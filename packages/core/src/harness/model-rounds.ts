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
 *
 * While a round streams, each output item it finishes is recorded at the same key as
 * a `cut` round, so a host killed mid-stream resumes from those items rather than
 * making them again. The round's own record replaces it. A cut round with neither a
 * function call nor an answer has nothing to go on from, so replay stops there.
 *
 * A call that fails charges its context with the rounds it recorded, so a failed run
 * reports what it paid. A retry in place replays those rounds on the same context,
 * so the ledger remembers which rounds were charged and the replay counts them no
 * more.
 */

import type { Item, ItemSchemaRegistry, RoundUsage } from '@noetic-tools/types';
import { frameworkCast, isAssistantMessage } from '@noetic-tools/types';
import { z } from 'zod';
import { isFunctionCall } from '../interpreter/typeguards';
import type { StepLedger } from '../runtime/durable/step-ledger';
import { hashStepInput } from '../runtime/durable/step-ledger';
import type { ToolCallResult } from '../runtime/tool-call';
import { ContextImpl } from './deps/runtime';

//#region Types

const ROUND_KIND = 'callModel:round';
const CALL_KIND = 'callModel:call';

/** What a recorded tool call left: the result the round went on with. */
const CallOutputSchema = z.object({
  output: z.string(),
  result: z.unknown().optional(),
  error: z.boolean().optional(),
  approval: z
    .enum([
      'approved',
      'denied',
      'none_configured',
    ])
    .optional(),
});

/** A function call as the call ledger identifies it. */
interface CalledFunction {
  callId: string;
  name: string;
  arguments: string;
}

/**
 * The tool calls of one round, recorded one by one as they finish
 * (spec 23a § Tool calls in a round).
 */
export interface CallLedger {
  /** The recorded result of this call, when an earlier attempt of the round finished it. */
  take(call: CalledFunction): ToolCallResult | undefined;
  /** Record what the call produced. Resolves whether the record was stored. */
  record(call: CalledFunction, result: ToolCallResult): Promise<boolean>;
}

/** What one finished round added to the loop. */
export interface RoundRecord {
  /** Model output items and tool result items, in the order the loop gathered them. */
  items: Item[];
  /** Conversation input entries the round appended, in SDK input shape. */
  input: unknown[];
  usage: RoundUsage;
  cost: number;
  /** The stream had not finished: `items` holds the output items it had, tools not yet run. */
  cut?: boolean;
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
  cut: z.boolean().optional(),
});

/** A replayed round: its record plus the items it appended to the item log. */
export interface ReplayedRound extends RoundRecord {
  appended: Item[];
  /** A failed call already charged this round's bill to the context. */
  charged: boolean;
}

/**
 * Keys of recorded rounds a failed call charged, per execution ledger. Kept in memory
 * only: a new harness resuming the execution starts from a restored context, which
 * never saw that charge.
 */
const chargedRounds = new WeakMap<StepLedger, Set<string>>();

//#endregion

//#region Public API

/**
 * The round ledger for one model loop. `open` gives none when the call is not running
 * as a step on a context with a ledger.
 */
export class RoundLedger {
  private replaying = true;
  /** Rounds this loop recorded. */
  private readonly recorded = new Set<number>();

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
    let replayed: ReplayedRound;
    try {
      replayed = {
        items: schemas.parseMany(parsed.data.items),
        input: parsed.data.input,
        usage: parsed.data.usage,
        cost: parsed.data.cost,
        cut: parsed.data.cut,
        appended: schemas.parseMany(entry.items ?? []),
        charged: chargedRounds.get(ledger)?.has(this.key(round)) ?? false,
      };
    } catch {
      this.replaying = false;
      return undefined;
    }
    if (replayed.cut && !replayed.items.some(goesOn)) {
      this.replaying = false;
      return undefined;
    }
    return replayed;
  }

  /** Mark where the log stood when a round began, so its appends can be recorded. */
  mark(): number {
    return this.ctx.appendedItems().length;
  }

  /**
   * Record a round, finished or `cut`. `logMark` is what `mark()` returned when it
   * began. Resolves whether the record was stored.
   *
   * Also drops the record of the round after it, left by an earlier attempt of the
   * same step (a steering retry calls the model again at the same path). Replay
   * stops at the first missing round, so the stale rounds past it are never read.
   */
  async record(round: number, logMark: number, record: RoundRecord): Promise<boolean> {
    this.replaying = false;
    const ledger = this.ctx.ledger;
    if (!ledger) {
      return false;
    }
    const appended = this.ctx.appendedItems().slice(logMark);
    const stored = await ledger.record({
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
    if (!stored) {
      return false;
    }
    this.recorded.add(round);
    // A new record holds a bill no context has been charged with yet.
    chargedRounds.get(ledger)?.delete(this.key(round));
    await ledger.drop(this.key(round + 1));
    return true;
  }

  /**
   * The call ledger of round `round`. Each call is recorded beneath the round's key,
   * so the round's own record prunes them once it lands.
   */
  calls(round: number): CallLedger {
    const ledger = this.ctx.ledger;
    const stepId = this.dispatch.stepId;
    const keyOf = (call: CalledFunction): string => `${this.key(round)}/call:${call.callId}`;
    // A call is the same call only with the same name and arguments.
    const hashOf = (call: CalledFunction): string | undefined =>
      hashStepInput({
        name: call.name,
        arguments: call.arguments,
      });
    return {
      take: (call) => {
        const entry = ledger?.take(keyOf(call), {
          id: stepId,
          kind: CALL_KIND,
          inputHash: hashOf(call),
        });
        const parsed = entry ? CallOutputSchema.safeParse(entry.output) : undefined;
        return parsed?.success ? parsed.data : undefined;
      },
      record: async (call, result) => {
        if (!ledger) {
          return false;
        }
        return ledger.record({
          path: keyOf(call),
          stepId,
          kind: CALL_KIND,
          inputHash: hashOf(call),
          output: frameworkCast<unknown>(result),
          completedAt: new Date().toISOString(),
        });
      },
    };
  }

  /** Drop the record of round `round`: the loop threw that round away. */
  async drop(round: number): Promise<void> {
    await this.ctx.ledger?.drop(this.key(round));
  }

  /** Note that the rounds this loop recorded were charged to its context. */
  charged(): void {
    const ledger = this.ctx.ledger;
    if (!ledger || this.recorded.size === 0) {
      return;
    }
    const keys = chargedRounds.get(ledger) ?? new Set<string>();
    for (const round of this.recorded) {
      keys.add(this.key(round));
    }
    chargedRounds.set(ledger, keys);
  }

  private key(round: number): string {
    return roundPath(this.dispatch.path, round);
  }
}

/** A cut round holding a function call or an answer has something to go on from. */
function goesOn(item: Item): boolean {
  return isFunctionCall(item) || isAssistantMessage(item);
}

/** @internal The ledger key of round `round` of the model loop at step path `path`. */
export function roundPath(path: string, round: number): string {
  return `${path}/round#${round}`;
}

//#endregion
