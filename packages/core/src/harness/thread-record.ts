/**
 * Durable sessions: what lets a new harness pick up a thread that `execute()` drove on
 * an earlier one. See `runtime/durable/session-store` for the stored shape.
 *
 * Storage is the only record. Nothing here is cached between calls: every turn reads
 * the thread's history and in-flight turn from the store, and every change is a
 * read-modify-write of the stored record, so a harness that served the last turn and
 * a harness built a moment ago behave the same.
 */

import type { Context, ExecuteInput, Item, SessionUsage } from '@noetic-tools/types';
import { NoeticErrorImpl } from '@noetic-tools/types';
import type { SessionRecord } from '../runtime/durable/session-store';
import type { LedgerFence } from '../runtime/durable/turn-lease';
import type {
  QueuedMessage,
  RestoreCheckpointOptions,
  SessionStore,
  TurnUsage,
} from './deps/runtime';

//#region Types

/** @internal The harness surface a thread record needs. */
export interface ThreadRecordHost {
  readonly store: SessionStore;
  /** The flow version this harness runs, when it names one. */
  readonly version?: string;
  restore(executionId: string, opts: RestoreCheckpointOptions): Promise<Context | null>;
  clearCheckpoint(executionId: string): Promise<void>;
  parseItems(raw: unknown[]): Item[];
  /** Ids of the context layers this harness keeps durable state for. */
  layerIds?(): ReadonlyArray<string>;
}

/** How many finished turns a thread remembers, to answer a message delivered again. */
const MAX_DONE_TURNS = 20;

/** How a record write behaves. */
interface CommitOptions {
  /** Write only over a stored record: never create one. */
  onlyIfStored?: boolean;
}

/** How many times a compare-and-set write is tried against a record that keeps changing. */
const COMMIT_ATTEMPTS = 8;

const EMPTY_USAGE: SessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
};

//#endregion

//#region ThreadRecord

/**
 * @internal
 * One thread's stored session. Turns call `history` → `resume` → `begin` → `end`; a
 * turn that throws never reaches `end`, so its record stays for a re-delivery of the
 * same messages to resume. Steers sent into a running turn are kept with `keepSteer`
 * until `end`. Operations run one at a time, in call order, so a read
 * never overtakes a write issued before it.
 */
export class ThreadRecord {
  private queue: Promise<unknown> = Promise.resolve();
  /** The lease the turn in flight runs under, when storage can compare-and-set. */
  private fence: LedgerFence | undefined;

  constructor(
    private readonly host: ThreadRecordHost,
    private readonly threadId: string,
  ) {}

  /**
   * Run the turn's own writes (`begin`, `end`) under `fence`: a harness that lost
   * the lease does not overwrite the record, and a write that fails stops the turn
   * (spec 23 § One writer per turn, § Fail-stop). `undefined` goes back to best-effort.
   */
  hold(fence: LedgerFence | undefined): void {
    this.fence = fence;
  }

  /** The lease term the stored record was last written at, when it was written under one. */
  term(): Promise<number | undefined> {
    return this.run(async () => (await this.load())?.term);
  }

  /** The history the thread's next turn builds on: what storage holds, or none. */
  history(): Promise<Item[]> {
    return this.run(async () => this.host.parseItems((await this.load())?.items ?? []));
  }

  /** Replace the stored history (`seedSessionHistory`). */
  seed(items: ReadonlyArray<Item>): Promise<void> {
    return this.update((record) => ({
      ...record,
      items: [
        ...items,
      ],
    }));
  }

  /**
   * The context of the cut-off turn, when `messageIds` re-deliver exactly its
   * messages. A cut-off turn that is not re-delivered is abandoned: its record is
   * dropped, its checkpoint cleared, and the new messages start a fresh turn.
   */
  resume(
    messageIds: ReadonlyArray<string>,
    opts: RestoreCheckpointOptions,
  ): Promise<Context | undefined> {
    return this.run(async () => {
      const turn = (await this.load())?.turn;
      if (!turn) {
        return undefined;
      }
      if (isSameDelivery(turn.messageIds, messageIds)) {
        return (await this.host.restore(turn.executionId, opts)) ?? undefined;
      }
      await this.write(withoutTurn);
      await this.host.clearCheckpoint(turn.executionId);
      return undefined;
    });
  }

  /** Forget the turn in flight and what it recorded: the host aborted a parked turn. */
  drop(): Promise<SessionRecord['turn']> {
    return this.run(async () => {
      const turn = (await this.load())?.turn;
      if (!turn) {
        return undefined;
      }
      await this.write(withoutTurn);
      await this.host.clearCheckpoint(turn.executionId);
      return turn;
    });
  }

  /** Keep a steer sent into the running turn, so a resumed turn still applies it. */
  keepSteer(message: QueuedMessage): Promise<void> {
    if (message.deliveryMode !== 'between-rounds' && message.deliveryMode !== 'next-item') {
      return Promise.resolve();
    }
    return this.keepQueued(message);
  }

  /**
   * Keep a message a parked turn has not taken yet, steer or not: with no process
   * holding the turn, storage is the only queue there is. An `interrupt` is never
   * kept; it replaces the turn.
   */
  keepQueued(message: QueuedMessage): Promise<void> {
    if (message.deliveryMode === 'interrupt') {
      return Promise.resolve();
    }
    const steer = {
      id: message.id,
      input: message.input,
      deliveryMode: message.deliveryMode,
      enqueuedAt: message.enqueuedAt,
      ...(message.options.resourceId === undefined
        ? {}
        : {
            resourceId: message.options.resourceId,
          }),
    };
    return this.update((record) => ({
      ...record,
      steers: [
        ...(record.steers ?? []).filter((kept) => kept.id !== steer.id),
        steer,
      ],
    }));
  }

  /** The steers kept for the turn in flight, as queue messages. */
  steers(): Promise<QueuedMessage[]> {
    return this.run(async () =>
      ((await this.load())?.steers ?? []).map((steer) => ({
        id: steer.id,
        input: this.parseInput(steer.input),
        deliveryMode: steer.deliveryMode,
        // Options carry live objects (layers, state) that storage cannot hold. The
        // harness the message was sent to still has them and puts them back.
        options:
          steer.resourceId === undefined
            ? {}
            : {
                resourceId: steer.resourceId,
              },
        enqueuedAt: steer.enqueuedAt,
      })),
    );
  }

  /**
   * Record the turn about to run on `ctx`, before any of it runs. Kept steers it
   * delivers as input stop being steers: re-delivering the turn re-sends them.
   * Kept steers named in `removed` are removed in the same write (`keptSteers: 'drop'`).
   */
  begin(
    ctx: Context,
    messageIds: ReadonlyArray<string>,
    removed: ReadonlyArray<string> = [],
  ): Promise<void> {
    const start = (record: SessionRecord): SessionRecord => ({
      ...record,
      steers: record.steers?.filter(
        (steer) => !messageIds.includes(steer.id) && !removed.includes(steer.id),
      ),
      executions: withExecution(record.executions, ctx.id),
      ...this.withLayers(record),
      turn: {
        executionId: ctx.id,
        messageIds: [
          ...messageIds,
        ],
        ...(this.host.version === undefined
          ? {}
          : {
              version: this.host.version,
            }),
        // Kept until the turn ends, even when it resumes under a new execution (its
        // checkpoint was not written): how often it was cut counts toward giving up.
        ...(record.turn?.cut !== undefined &&
        (record.turn.executionId === ctx.id || isSameList(record.turn.messageIds, messageIds))
          ? {
              cut: record.turn.cut,
            }
          : {}),
        // Kept until the turn ends: a host that dies part way through going on
        // must not find the same step stuck again.
        ...(record.turn?.executionId === ctx.id && record.turn.accept !== undefined
          ? {
              accept: record.turn.accept,
            }
          : {}),
      },
    });
    return this.updateHeld(ctx, start, removed.length > 0);
  }

  /**
   * The turn on `ctx` stopped rather than redo a recorded effect under a newer flow
   * version. It stays, marked, until the host settles it.
   */
  stick(
    ctx: Context,
    stuck: {
      path: string;
      from: string;
      to: string;
    },
  ): Promise<void> {
    return this.update((record) =>
      record.turn?.executionId === ctx.id
        ? {
            ...record,
            turn: {
              ...record.turn,
              stuck,
            },
          }
        : record,
    );
  }

  /**
   * Settle a stuck turn. `continue` and `restart` clear the mark so the turn can
   * run; `continue` also lets its next run discard what no longer matches.
   * `abandon` forgets the turn. Resolves the turn it settled, or undefined when
   * the thread has no stuck turn.
   */
  settle(action: 'continue' | 'restart' | 'abandon'): Promise<SessionRecord['turn']> {
    return this.run(async () => {
      const turn = (await this.load())?.turn;
      if (!turn?.stuck) {
        return undefined;
      }
      const { stuck, stopped: _stopped, ...rest } = turn;
      await this.write((record) =>
        action === 'abandon'
          ? withoutTurn(record)
          : {
              ...record,
              turn: {
                ...rest,
                ...(action === 'continue'
                  ? {
                      accept: stuck.path,
                    }
                  : {}),
              },
            },
      );
      return turn;
    });
  }

  /**
   * The turn on `ctx` parked: keep its record, marked with when to wake it. Its
   * checkpoint and ledger stay, since they are what the woken turn resumes from.
   */
  park(ctx: Context, until: number | undefined): Promise<void> {
    return this.updateHeld(ctx, (record) =>
      record.turn
        ? {
            ...record,
            turn: {
              ...withoutCut(record.turn),
              parked:
                until === undefined
                  ? {}
                  : {
                      until,
                    },
            },
          }
        : record,
    );
  }

  /**
   * The turn on `ctx` was cut (spec 23 § Cut turns): keep its record, marked with how
   * often and when. Best-effort and unfenced: storage that just refused a write may
   * refuse this one, and the harness keeps the mark in memory as well. Written only
   * while the record still names the turn's execution.
   */
  cut(
    ctx: Context,
    cut: {
      reason: string;
      count: number;
      at: number;
    },
  ): Promise<void> {
    return this.update((record) =>
      record.turn?.executionId === ctx.id
        ? {
            ...record,
            turn: {
              ...record.turn,
              cut,
            },
          }
        : record,
    );
  }

  /**
   * The turn on `ctx` ended here without finishing. Best-effort: a turn whose mark
   * does not land is simply taken for one that was cut off.
   */
  stop(ctx: Context, reason: string, at: number): Promise<void> {
    return this.update((record) =>
      record.turn?.executionId === ctx.id
        ? {
            ...record,
            turn: {
              ...withoutCut(record.turn),
              stopped: {
                at,
                reason,
              },
            },
          }
        : record,
    );
  }

  /**
   * The turn on `ctx` gave its answer: remember it under the turn's message ids, so
   * the same messages delivered again get it back (`answerFor`). Call before `end`,
   * which forgets the turn. Only the last few turns are kept.
   */
  answered(ctx: Context, text: string): Promise<void> {
    return this.update((record) => {
      if (record.turn?.executionId !== ctx.id) {
        return record;
      }
      const kept = (record.done ?? []).slice(1 - MAX_DONE_TURNS);
      return {
        ...record,
        done: [
          ...(MAX_DONE_TURNS > 1 ? kept : []),
          {
            messageIds: record.turn.messageIds,
            text,
            executionId: ctx.id,
          },
        ],
      };
    });
  }

  /**
   * The answer a finished turn gave to the message `messageId`, when one of the
   * thread's recent turns delivered it.
   */
  answerFor(messageId: string): Promise<string | undefined> {
    return this.run(async () => {
      const done = (await this.load())?.done ?? [];
      return done.findLast((turn) => turn.messageIds.includes(messageId))?.text;
    });
  }

  /** The executions of every turn the thread began, oldest first, the one in flight last. */
  executions(): Promise<string[]> {
    return this.run(async () => executionsOf(await this.load()));
  }

  /** The stored record, read after every write issued before it. */
  stored(): Promise<SessionRecord | undefined> {
    return this.run(() => this.load());
  }

  /** The turn in flight, cut off or parked, when one is recorded. */
  turn(): Promise<SessionRecord['turn']> {
    return this.run(async () => (await this.load())?.turn);
  }

  /**
   * The turn on `ctx` finished: store the history it left and drop its checkpoint.
   * Only steers still queued are kept; the rest were applied or dropped.
   */
  async end(
    ctx: Context,
    history: ReadonlyArray<Item>,
    queuedIds: ReadonlyArray<string>,
  ): Promise<void> {
    await this.updateHeld(ctx, (record) => ({
      ...withoutTurn(record),
      ...this.withLayers(record),
      steers: record.steers?.filter((steer) => queuedIds.includes(steer.id)),
      items: [
        ...history,
      ],
    }));
    await this.host.clearCheckpoint(ctx.id);
  }

  /** Add one turn's spend to the stored totals, and return the totals now stored. */
  addUsage(spent: TurnUsage): Promise<SessionUsage> {
    return this.run(async () => {
      const usage = addUsage((await this.load())?.usage ?? EMPTY_USAGE, spent);
      // A record a forget deleted meanwhile stays deleted: a late bill does not bring it back.
      await this.write(
        (record) => ({
          ...record,
          usage,
        }),
        {
          onlyIfStored: true,
        },
      );
      return usage;
    });
  }

  /** The stored totals. */
  usage(): Promise<SessionUsage> {
    return this.run(async () => (await this.load())?.usage ?? EMPTY_USAGE);
  }

  private update(change: (record: SessionRecord) => SessionRecord): Promise<void> {
    return this.run(() => this.write(change));
  }

  /**
   * A write the turn itself makes. Under a lease it carries the lease's term and is
   * refused when the record already holds a higher one — another harness took the
   * turn, whatever this one's clock says — and a write that fails throws instead of
   * being logged (spec 23 § One writer per turn, § Fail-stop). A caller that
   * reports a removal also needs the write to succeed without a lease.
   */
  private updateHeld(
    ctx: Context,
    change: (record: SessionRecord) => SessionRecord,
    mustWrite = false,
  ): Promise<void> {
    const fence = this.fence;
    if (!fence && !mustWrite) {
      return this.update(change);
    }
    return this.run(async () => {
      fence?.assert();
      try {
        await this.commit((record) => {
          if (!fence) {
            return change(record);
          }
          if ((record.term ?? 0) > fence.term) {
            throw fence.lose(`the thread record was written at term ${record.term}`);
          }
          return {
            ...change(record),
            term: fence.term,
          };
        });
      } catch (error) {
        if (error instanceof NoeticErrorImpl) {
          throw error;
        }
        throw new NoeticErrorImpl({
          kind: 'ledger_write_failed',
          executionId: ctx.id,
          path: `session:${this.threadId}`,
          cause: error instanceof Error ? error : new Error(String(error)),
        });
      }
    });
  }

  /** Read-modify-write the stored record, best-effort. Call only from inside `run`. */
  private async write(
    change: (record: SessionRecord) => SessionRecord,
    opts?: CommitOptions,
  ): Promise<void> {
    try {
      await this.commit(change, opts);
    } catch (error) {
      // Same rule as checkpoints: losing the record costs resumability, not the turn.
      console.warn(
        `AgentHarness: failed to persist session "${this.threadId}":`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Apply `change` to what storage holds now. On storage that can compare-and-set
   * the write lands only if nothing else wrote meanwhile, and is tried again on what
   * the other writer left, so two harnesses never overwrite each other's fields.
   */
  private async commit(
    change: (record: SessionRecord) => SessionRecord,
    opts?: CommitOptions,
  ): Promise<void> {
    const store = this.host.store;
    for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt += 1) {
      const stored = await store.read(this.threadId);
      if (opts?.onlyIfStored && stored.raw === null) {
        return;
      }
      const next = change(
        stored.record ?? {
          items: [],
        },
      );
      if (!store.swap) {
        await store.save(this.threadId, next);
        return;
      }
      if (await store.swap(this.threadId, stored.raw, next)) {
        return;
      }
    }
    throw new Error(`session "${this.threadId}" kept changing while it was being written`);
  }

  private parseInput(input: unknown): ExecuteInput {
    if (typeof input === 'string') {
      return input;
    }
    return this.host.parseItems(
      Array.isArray(input)
        ? input
        : [
            input,
          ],
    );
  }

  /** `layers` with the ids of the layers this harness keeps durable state for, when it has any new ones. */
  private withLayers(record: SessionRecord): Pick<SessionRecord, 'layers'> {
    const known = this.host.layerIds?.() ?? [];
    const layers = new Set(record.layers);
    for (const id of known) {
      layers.add(id);
    }
    return layers.size === 0
      ? {}
      : {
          layers: [
            ...layers,
          ],
        };
  }

  private load(): Promise<SessionRecord | undefined> {
    return this.host.store.load(this.threadId);
  }

  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op);
    this.queue = next.catch(() => {});
    return next;
  }
}

function withoutCut(turn: NonNullable<SessionRecord['turn']>): NonNullable<SessionRecord['turn']> {
  const { cut, ...rest } = turn;
  void cut;
  return rest;
}

function withoutTurn(record: SessionRecord): SessionRecord {
  const { turn, ...rest } = record;
  void turn;
  return rest;
}

/**
 * True when `delivered` is the turn's own messages coming round again. Some of them
 * is enough: a queue redelivers one at a time, and a wake hands them back together.
 */
function isSameDelivery(turn: ReadonlyArray<string>, delivered: ReadonlyArray<string>): boolean {
  return delivered.length > 0 && delivered.every((id) => turn.includes(id));
}

function isSameList(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function addUsage(total: SessionUsage, spent: TurnUsage): SessionUsage {
  const cost = (total.cost ?? 0) + spent.cost;
  const billedCost = (total.billedCost ?? 0) + spent.billedCost;
  const cachedTokens =
    spent.cachedTokens === undefined
      ? total.cachedTokens
      : (total.cachedTokens ?? 0) + spent.cachedTokens;
  return {
    inputTokens: total.inputTokens + spent.inputTokens,
    outputTokens: total.outputTokens + spent.outputTokens,
    ...(cachedTokens !== undefined
      ? {
          cachedTokens,
        }
      : {}),
    ...(cost > 0
      ? {
          cost,
        }
      : {}),
    ...(billedCost > 0
      ? {
          billedCost,
        }
      : {}),
  };
}

//#endregion

//#region Executions

/** `executions` with `executionId` added at the end, unless it is already there. */
function withExecution(executions: string[] | undefined, executionId: string): string[] {
  const known = executions ?? [];
  return known.includes(executionId)
    ? known
    : [
        ...known,
        executionId,
      ];
}

/**
 * @internal
 * Every execution a stored record names, oldest first, without repeats: those it
 * began, then remembered finished turns from records written before `executions`
 * was kept, then the turn in flight.
 */
export function executionsOf(record: SessionRecord | undefined): string[] {
  const ids = new Set(record?.executions);
  for (const turn of record?.done ?? []) {
    if (turn.executionId !== undefined) {
      ids.add(turn.executionId);
    }
  }
  if (record?.turn) {
    ids.delete(record.turn.executionId);
    ids.add(record.turn.executionId);
  }
  return [
    ...ids,
  ];
}

//#endregion
