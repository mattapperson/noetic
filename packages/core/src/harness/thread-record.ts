/**
 * Durable sessions: what lets a new harness pick up a thread that `execute()` drove on
 * an earlier one. See `runtime/durable/session-store` for the stored shape.
 */

import type { Context, Item } from '@noetic-tools/types';
import type { SessionRecord } from '../runtime/durable/session-store';
import type { RestoreCheckpointOptions, SessionStore } from './deps/runtime';

//#region Types

/** @internal The harness surface a thread record needs. */
export interface ThreadRecordHost {
  readonly store: SessionStore;
  restore(executionId: string, opts: RestoreCheckpointOptions): Promise<Context | null>;
  clearCheckpoint(executionId: string): Promise<void>;
  parseItems(raw: unknown[]): Item[];
}

//#endregion

//#region ThreadRecord

/**
 * @internal
 * One thread's stored session, loaded on first use. Turns call `resume` → `begin` →
 * `end`; a turn that throws never reaches `end`, so its record stays for a re-delivery
 * of the same messages to resume.
 */
export class ThreadRecord {
  private loaded?: Promise<SessionRecord | undefined>;
  private turn: SessionRecord['turn'];
  /** True once the history has been handed out, or the host seeded its own. */
  private historyTaken = false;

  constructor(
    private readonly host: ThreadRecordHost,
    private readonly threadId: string,
  ) {}

  /** The host set the history itself (`seedSessionHistory`); stored history is ignored. */
  markSeeded(): void {
    this.historyTaken = true;
  }

  /**
   * The history the thread's next turn builds on. The first call hands out the stored
   * history; after that, and after a seed, `current` — held in memory — is newer.
   */
  async history(current: Item[]): Promise<Item[]> {
    const record = await this.load();
    if (this.historyTaken || !record) {
      this.historyTaken = true;
      return current;
    }
    this.historyTaken = true;
    return this.host.parseItems(record.items);
  }

  /**
   * The context of the cut-off turn, when `messageIds` re-deliver exactly its
   * messages. A cut-off turn that is not re-delivered is abandoned: its checkpoint is
   * cleared and the new messages start a fresh turn.
   */
  async resume(
    messageIds: ReadonlyArray<string>,
    opts: RestoreCheckpointOptions,
  ): Promise<Context | undefined> {
    await this.load();
    const turn = this.turn;
    if (!turn) {
      return undefined;
    }
    this.turn = undefined;
    if (!sameIds(turn.messageIds, messageIds)) {
      await this.host.clearCheckpoint(turn.executionId);
      return undefined;
    }
    return (await this.host.restore(turn.executionId, opts)) ?? undefined;
  }

  /** Record the turn about to run on `ctx`, before any of it runs. */
  async begin(ctx: Context, messageIds: ReadonlyArray<string>, history: Item[]): Promise<void> {
    this.turn = {
      executionId: ctx.id,
      messageIds: [
        ...messageIds,
      ],
    };
    await this.save(history);
  }

  /** The turn on `ctx` finished: store the history it left and drop its checkpoint. */
  async end(ctx: Context, history: ReadonlyArray<Item>): Promise<void> {
    this.turn = undefined;
    await this.save([
      ...history,
    ]);
    await this.host.clearCheckpoint(ctx.id);
  }

  private load(): Promise<SessionRecord | undefined> {
    this.loaded ??= this.host.store.load(this.threadId).then((record) => {
      this.turn = record?.turn;
      return record;
    });
    return this.loaded;
  }

  private async save(history: Item[]): Promise<void> {
    try {
      await this.host.store.save(this.threadId, {
        items: history,
        ...(this.turn
          ? {
              turn: this.turn,
            }
          : {}),
      });
    } catch (error) {
      // Same rule as checkpoints: losing the record costs resumability, not the turn.
      console.warn(
        `AgentHarness: failed to persist session "${this.threadId}":`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

function sameIds(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

//#endregion
