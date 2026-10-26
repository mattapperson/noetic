/**
 * Durable rounds for the model loop.
 *
 * One `callModel` step can run many rounds: the model asks for tools, the harness
 * runs them, the model answers again. The step ledger records the step only when the
 * whole loop ends, so without this a failure on round five throws rounds one to four
 * away — each paid for again on resume, and each tool run again.
 *
 * Each finished round is recorded under `<step path>/round#<n>`, carrying what it
 * added to the loop: the model's output and tool results, the conversation input
 * those became, the items appended to the item log,
 * and the round's usage. A resumed loop replays rounds in order and stops at the first
 * one it does not find; every round after that runs live, because a recorded round
 * belongs to the conversation the earlier recorded rounds built. When the step
 * finishes and records, the ledger prunes its rounds.
 */

import type { Item, ItemSchemaRegistry, RoundUsage } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { ContextImpl } from './deps/runtime';

//#region Types

const ROUND_KIND = 'callModel:round';

/** What one finished round added to the loop. */
export interface RoundRecord {
  /** Model output items and tool result items, in the order the loop gathered them. */
  items: Item[];
  /** Conversation input entries the round appended, in SDK input shape. */
  input: unknown[];
  usage: RoundUsage;
  cost: number;
}

const RoundOutputSchema = z.object({
  items: z.array(z.unknown()),
  input: z.array(z.unknown()),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cachedTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
  }),
  cost: z.number(),
});

/** A replayed round: its record plus the items it appended to the item log. */
export interface ReplayedRound extends RoundRecord {
  appended: Item[];
}

//#endregion

//#region Public API

/**
 * The round ledger for one model loop. `open` gives none when the call is not running
 * as a step on a context with a ledger.
 */
export class RoundLedger {
  private replaying = true;

  private constructor(
    private readonly ctx: ContextImpl,
    private readonly dispatch: {
      path: string;
      stepId: string;
      inputHash: string | undefined;
    },
  ) {}

  /** Undefined when the loop has nothing to record into. */
  static open(ctx: unknown): RoundLedger | undefined {
    if (!(ctx instanceof ContextImpl) || !ctx.ledger) {
      return undefined;
    }
    const dispatch = ctx.currentDispatch();
    return dispatch ? new RoundLedger(ctx, dispatch) : undefined;
  }

  /**
   * The recorded round `round`, with its items parsed, or undefined once replay has
   * stopped — at the first round with no usable record, and for good after that.
   */
  take(round: number, schemas: ItemSchemaRegistry): ReplayedRound | undefined {
    const ledger = this.ctx.ledger;
    if (!this.replaying || !ledger || ledger.isEmpty) {
      this.replaying = false;
      return undefined;
    }
    const entry = ledger.take(this.key(round), {
      id: this.dispatch.stepId,
      kind: ROUND_KIND,
      inputHash: this.dispatch.inputHash,
    });
    const parsed = entry ? RoundOutputSchema.safeParse(entry.output) : undefined;
    if (!entry || !parsed?.success) {
      this.replaying = false;
      return undefined;
    }
    try {
      return {
        items: schemas.parseMany(parsed.data.items),
        input: parsed.data.input,
        usage: parsed.data.usage,
        cost: parsed.data.cost,
        appended: schemas.parseMany(entry.items ?? []),
      };
    } catch {
      this.replaying = false;
      return undefined;
    }
  }

  /** Mark where the log stood when a round began, so its appends can be recorded. */
  mark(): number {
    return this.ctx.appendedItems().length;
  }

  /** Record a finished round. `logMark` is what `mark()` returned when it began. */
  async record(round: number, logMark: number, record: RoundRecord): Promise<void> {
    this.replaying = false;
    const appended = this.ctx.appendedItems().slice(logMark);
    await this.ctx.ledger?.record({
      path: this.key(round),
      stepId: this.dispatch.stepId,
      kind: ROUND_KIND,
      inputHash: this.dispatch.inputHash,
      output: frameworkCast<unknown>(record),
      ...(appended.length > 0
        ? {
            items: appended,
          }
        : {}),
      completedAt: new Date().toISOString(),
    });
  }

  private key(round: number): string {
    return `${this.dispatch.path}/round#${round}`;
  }
}

//#endregion
