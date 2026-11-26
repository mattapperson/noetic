import { NoeticConfigError } from '@noetic-tools/types';
import { pendingTasksOf, resumableWaitsOf } from '../interpreter/connection-steps';
import type { ConnectionGate } from './connection-gate';
import type { RestoreCheckpointOptions, SessionStore, TurnLeaseOptions } from './deps/runtime';
import {
  canSwap,
  createInMemoryStorage,
  createSessionStore,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_PARK_GRACE_MS,
  heldElsewhere,
} from './deps/runtime';
import type { Context, ExecuteOptions, Item, StorageAdapter, StoredTurn } from './deps/types';
import type { ParkConfig, TurnLeaseConfig } from './harness-options';
import { DEFAULT_TASK_POLL_MS, DEFAULT_WAKE_DEBOUNCE_MS, ParkWatchers } from './park-watchers';
import type { Session } from './session';
import type { StoredTurnRecord } from './thread-record';
import { ThreadRecord } from './thread-record';
import { TurnCuts } from './turn-cuts';

//#region Wake types

interface WakeThreads {
  forgetting(threadId: string): boolean;
  current(threadId: string): Session | undefined;
  open(threadId: string): Session;
  options(
    threadId: string,
    turn: StoredTurnRecord,
    cut: StoredTurn['cut'],
  ): Promise<ExecuteOptions>;
}

type WakeScope = {
  threadId?: string;
  options?: ExecuteOptions;
};

//#endregion

//#region Stored session operations

export class SessionStoreOps {
  /** Set when sessions are durable and storage can compare-and-set. */
  readonly leaseOptions: TurnLeaseOptions | undefined;
  /** Set with the lease: how cut turns are run again, and each thread’s cut mark. */
  readonly cuts: TurnCuts | undefined;
  /** Set when turns park (`environment.storage.park`): the grace before one does. */
  readonly parkGraceMs: number | undefined;
  /** Set when this harness wakes the turns it parked (`park.autoWake`). */
  readonly parkWatchers: ParkWatchers | undefined;
  /** Stored sessions for `execute()` threads. Present exactly when durability is on. */
  readonly store: SessionStore | undefined;

  constructor(
    private readonly host: {
      storage: StorageAdapter | undefined;
      durable: boolean;
      version(): string | undefined;
      restore(id: string, opts?: RestoreCheckpointOptions): Promise<Context | null>;
      clearCheckpoint(id: string): Promise<void>;
      parseItems(raw: unknown[]): Item[];
      layerIds(): string[];
      start(): Promise<void>;
      connections(): ConnectionGate;
      wake(opts: { threadId: string; options?: ExecuteOptions }): Promise<string[]>;
      now(): number;
    },
    lease: TurnLeaseConfig,
    park: boolean | ParkConfig | undefined,
  ) {
    this.store = host.durable
      ? createSessionStore(host.storage ?? createInMemoryStorage())
      : undefined;
    this.leaseOptions = resolveLeaseOptions(this.store ? host.storage : undefined, lease);
    this.cuts = this.leaseOptions ? new TurnCuts(lease.cut) : undefined;
    this.parkGraceMs = resolveParkGrace(this.leaseOptions ? park : undefined);
    this.parkWatchers = this.createParkWatchers(park);
  }

  /** Re-deliver all of a turn's original message IDs in one arrival to resume it. */
  async wake(scope: WakeScope | undefined, threads: WakeThreads): Promise<string[]> {
    if (!this.store) {
      return [];
    }
    const now = this.host.now();
    const ids = scope?.threadId
      ? [
          scope.threadId,
        ]
      : await this.store.threads();
    const woken: string[] = [];
    for (const id of ids) {
      if (await this.wakeThread(id, now, scope, threads)) {
        woken.push(id);
      }
    }
    return woken;
  }

  private async wakeThread(
    id: string,
    now: number,
    scope: WakeScope | undefined,
    threads: WakeThreads,
  ): Promise<boolean> {
    // A thread being forgotten has no turn left to wake.
    if (threads.forgetting(id)) {
      return false;
    }
    const named = Boolean(scope?.threadId);
    const runner = named ? threads.current(id)?.runner : undefined;
    // A named turn can be closing out its park. Wait for that runner to finish.
    if (runner && runner.context === undefined) {
      await runner.whenIdle();
    }
    const turn = (await this.store?.load(id))?.turn;
    // A stuck turn waits for the host to settle it, however the wake was asked for.
    if (!turn || turn.stuck) {
      return false;
    }
    const cut = turn.parked ? undefined : this.cuts?.markOf(id, turn);
    // A routine wake leaves alone a parked turn that is not due, one with no
    // deadline at all (it waits for an answer, not for a time), and one that
    // failed or was cancelled here: only a turn cut off by a crash resumes unasked.
    if (!named && this.waitToWake(id, turn, cut, now, scope?.options)) {
      return false;
    }
    const session = threads.open(id);
    if (session.runner.getStatus().kind !== 'idle' || session.runner.queue.size > 0) {
      return false;
    }
    // A named wake waits for the lease in the runner, where a timeout is visible.
    const held = this.leaseOptions && (await heldElsewhere(this.leaseOptions, id));
    if (held && !named) {
      return false;
    }
    const options = scope?.options ?? (await threads.options(id, turn, cut));
    session.runner.queue.enqueueAll(
      turn.messageIds.map((messageId) => ({
        id: messageId,
        input: [],
        deliveryMode: 'next-turn',
        options,
        enqueuedAt: Date.now(),
      })),
    );
    return true;
  }

  private waitToWake(
    id: string,
    turn: StoredTurnRecord,
    cut: StoredTurn['cut'],
    now: number,
    options?: ExecuteOptions,
  ): boolean {
    if (turn.parked) {
      const { until } = turn.parked;
      if (until !== undefined && until <= now) {
        return false;
      }
      // A parked turn found in storage, as at boot, is watched from this host.
      if (this.parkWatchers && !this.parkWatchers.has(id)) {
        this.parkWatchers.watch(id, {
          executionId: turn.executionId,
          until,
          options,
        });
      }
      return true;
    }
    return Boolean(turn.stopped || (cut && this.cuts && this.cuts.dueAt(cut) > now));
  }

  /** The stored record for `threadId`, when durability is on. */
  record(threadId: string): ThreadRecord | undefined {
    if (!this.store) {
      return undefined;
    }
    return new ThreadRecord(
      {
        store: this.store,
        version: this.host.version(),
        restore: (executionId, opts) => this.host.restore(executionId, opts),
        clearCheckpoint: (executionId) => this.host.clearCheckpoint(executionId),
        parseItems: (raw) => this.host.parseItems(raw),
        layerIds: () => this.host.layerIds(),
      },
      threadId,
    );
  }

  /** The watchers that wake this harness's parked turns, when auto-wake is on. */
  private createParkWatchers(park: boolean | ParkConfig | undefined): ParkWatchers | undefined {
    if (this.parkGraceMs === undefined) {
      return undefined;
    }
    const config = park === true || park === undefined || park === false ? {} : park;
    if (config.autoWake === false) {
      return undefined;
    }
    const storage = this.host.storage;
    return new ParkWatchers(
      {
        listen: async (connection, request) => {
          await this.host.start();
          return this.host.connections().registry.listenRaw(connection, request);
        },
        waits: async (executionId) => (storage ? resumableWaitsOf(storage, executionId) : []),
        tasks: async (executionId) => (storage ? pendingTasksOf(storage, executionId) : []),
        taskState: async (task, signal) => {
          try {
            await this.host.start();
            const status = await this.host
              .connections()
              .registry.taskStatus(task.connection, task.taskId, signal);
            return status.state;
          } catch {
            return undefined;
          }
        },
        wake: async (threadId, options) =>
          (
            await this.host.wake({
              threadId,
              options,
            })
          ).length > 0,
        parked: async (threadId) => {
          const turn = (await this.store?.load(threadId))?.turn;
          return turn?.parked && !turn.stuck ? turn.executionId : undefined;
        },
        now: () => this.host.now(),
      },
      config.wakeDebounceMs ?? DEFAULT_WAKE_DEBOUNCE_MS,
      config.taskPollMs ?? DEFAULT_TASK_POLL_MS,
    );
  }
}
//#endregion

//#region Lease options and stored turn view

/** Added to the lease period for the default wait on a held lease. */
export const LEASE_WAIT_MARGIN_MS = 1e3;

/** The grace before a turn parks, or undefined when parking is off. */
function resolveParkGrace(park: boolean | ParkConfig | undefined): number | undefined {
  if (!park) {
    return undefined;
  }
  return park === true ? DEFAULT_PARK_GRACE_MS : (park.graceMs ?? DEFAULT_PARK_GRACE_MS);
}

/** Lease settings for sessions on `storage`, or none when it cannot compare-and-set. */
function resolveLeaseOptions(
  storage: StorageAdapter | undefined,
  config: TurnLeaseConfig | undefined,
): TurnLeaseOptions | undefined {
  if (!canSwap(storage)) {
    return undefined;
  }
  const ttlMs = config?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  // One lease period, and a little more: a dead holder's lease runs out in that time.
  const waitMs = config?.waitMs ?? ttlMs + LEASE_WAIT_MARGIN_MS;
  // A lease of no length is lost before the turn's first write; one that never
  // ends is never taken over.
  const ttlOk = Number.isFinite(ttlMs) && ttlMs > 0;
  const waitOk = Number.isFinite(waitMs) && waitMs >= 0;
  if (!ttlOk || !waitOk || config?.holder === '') {
    throw new NoeticConfigError({
      code: 'INVALID_LEASE_OPTIONS',
      message: `environment.storage.lease is not usable: ttlMs ${ttlMs}, waitMs ${waitMs}, holder ${JSON.stringify(config?.holder)}.`,
      hint: 'Give ttlMs a finite number of milliseconds above 0, waitMs a finite number from 0 up, and holder a non-empty name, or leave them out for the defaults.',
    });
  }
  return {
    storage,
    holder: config?.holder ?? crypto.randomUUID(),
    ttlMs,
    waitMs,
    now: config?.now ?? Date.now,
  };
}

/** A thread's turn in flight, as its record stores it. */

/** A stored turn as a host sees it (`turnOptions`, `getStoredThread`). */
export function storedTurnOf(
  threadId: string,
  turn: StoredTurnRecord,
  cut: StoredTurn['cut'],
): StoredTurn {
  return {
    threadId,
    executionId: turn.executionId,
    messageIds: turn.messageIds,
    ...(turn.version === undefined
      ? {}
      : {
          version: turn.version,
        }),
    ...(turn.parked
      ? {
          parked: turn.parked,
        }
      : {}),
    ...(cut
      ? {
          cut,
        }
      : {}),
  };
}

//#endregion
