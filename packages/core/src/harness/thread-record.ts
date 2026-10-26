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
import type { SessionRecord } from '../runtime/durable/session-store';
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
  restore(executionId: string, opts: RestoreCheckpointOptions): Promise<Context | null>;
  clearCheckpoint(executionId: string): Promise<void>;
  parseItems(raw: unknown[]): Item[];
}

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

  constructor(
    private readonly host: ThreadRecordHost,
    private readonly threadId: string,
  ) {}

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
      if (sameIds(turn.messageIds, messageIds)) {
        return (await this.host.restore(turn.executionId, opts)) ?? undefined;
      }
      await this.write(withoutTurn);
      await this.host.clearCheckpoint(turn.executionId);
      return undefined;
    });
  }

  /** Keep a steer sent into the running turn, so a resumed turn still applies it. */
  keepSteer(message: QueuedMessage): Promise<void> {
    if (message.deliveryMode !== 'between-rounds' && message.deliveryMode !== 'next-item') {
      return Promise.resolve();
    }
    const steer = {
      id: message.id,
      input: message.input,
      deliveryMode: message.deliveryMode,
      enqueuedAt: message.enqueuedAt,
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
        // Options carry live objects (layers, state) that storage cannot hold; a
        // steer applied mid-turn never reads them.
        options: {},
        enqueuedAt: steer.enqueuedAt,
      })),
    );
  }

  /**
   * Record the turn about to run on `ctx`, before any of it runs. Kept steers it
   * delivers as input stop being steers: re-delivering the turn re-sends them.
   */
  begin(ctx: Context, messageIds: ReadonlyArray<string>): Promise<void> {
    return this.update((record) => ({
      ...record,
      steers: record.steers?.filter((steer) => !messageIds.includes(steer.id)),
      turn: {
        executionId: ctx.id,
        messageIds: [
          ...messageIds,
        ],
      },
    }));
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
    await this.update((record) => ({
      ...withoutTurn(record),
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
      await this.write((record) => ({
        ...record,
        usage,
      }));
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

  /** Read-modify-write the stored record. Call only from inside `run`. */
  private async write(change: (record: SessionRecord) => SessionRecord): Promise<void> {
    const record = change(
      (await this.load()) ?? {
        items: [],
      },
    );
    try {
      await this.host.store.save(this.threadId, record);
    } catch (error) {
      // Same rule as checkpoints: losing the record costs resumability, not the turn.
      console.warn(
        `AgentHarness: failed to persist session "${this.threadId}":`,
        error instanceof Error ? error.message : String(error),
      );
    }
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

  private load(): Promise<SessionRecord | undefined> {
    return this.host.store.load(this.threadId);
  }

  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op);
    this.queue = next.catch(() => {});
    return next;
  }
}

function withoutTurn(record: SessionRecord): SessionRecord {
  const { turn, ...rest } = record;
  void turn;
  return rest;
}

function sameIds(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
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
