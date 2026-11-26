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
import type { Bill } from './call-spend';
import { noBill } from './call-spend';
import { ContextImpl } from './deps/runtime';

//#region Types

/** Ledger kind of a model-loop round's record. */
export const ROUND_KIND = 'callModel:round';
/** Ledger kind of one tool call's record within a round. */
export const CALL_KIND = 'callModel:call';
/** What follows a round's key in the key of a call recorded beneath it. */
export const CALL_SEGMENT = '/call:';

/** What a recorded tool call left: the result the round went on with. */
const CallOutputSchema = z.object({
  output: z.string(),
  result: z.unknown().optional(),
  /**
   * `result` was left out because `output` holds the same thing: as text, or as
   * its JSON. A record that kept both was twice the size of what it recorded.
   */
  resultAs: z
    .enum([
      'text',
      'json',
    ])
    .optional(),
  /** The id of the result item the call appended, which a replay appends again. */
  itemId: z.string().optional(),
  /** The tool's body ran, so its UI showed a call and how it ended. */
  ran: z.boolean().optional(),
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
  /**
   * Where in the run this round is: the model step's path and the round's number.
   * The same on a resume, and what tells two calls with one call id apart.
   */
  readonly scope: string;
  /** The recorded result of this call, when an earlier attempt of the round finished it. */
  take(call: CalledFunction): ToolCallResult | undefined;
  /** Record what the call produced. Resolves whether the record was stored. */
  record(call: CalledFunction, result: ToolCallResult): Promise<boolean>;
  /** Note that the call has a lasting effect: its record and its round's are marked so. */
  noteEffect(call: CalledFunction): void;
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

/** Item ids saved in the context, completed steps and model rounds. */
export function savedItemIds(ctx: ContextImpl): Set<string> {
  const ids = new Set<string>();
  const add = (items: ReadonlyArray<unknown>): void => {
    for (const item of items) {
      if (item && typeof item === 'object' && 'id' in item && typeof item.id === 'string') {
        ids.add(item.id);
      }
    }
  };
  add(ctx.itemLog.items);
  for (const entry of ctx.ledger?.savedEntries() ?? []) {
    add(entry.items ?? []);
    if (entry.kind === ROUND_KIND) {
      const round = RoundOutputSchema.safeParse(entry.output);
      if (round.success) {
        add(round.data.items);
      }
    }
  }
  return ids;
}

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
    // The next round's record, and the calls recorded beneath it, belong to the
    // conversation an earlier attempt had. This one may ask for other calls.
    await ledger.dropWithin(this.key(round + 1));
    return true;
  }

  /**
   * The call ledger of round `round`. Each call is recorded beneath the round's key,
   * so the round's own record prunes them once it lands.
   */
  calls(round: number): CallLedger {
    const ledger = this.ctx.ledger;
    const stepId = this.dispatch.stepId;
    const keyOf = (call: CalledFunction): string =>
      `${this.key(round)}${CALL_SEGMENT}${call.callId}`;
    // A call is the same call only with the same name and arguments, asked for by
    // the same step input: a provider that numbers its calls from one each time
    // would otherwise hand a call the result of another conversation's.
    const hashOf = (call: CalledFunction): string | undefined =>
      hashStepInput({
        name: call.name,
        arguments: call.arguments,
        step: this.dispatch.inputHash,
      });
    return {
      scope: this.key(round),
      noteEffect: (call) => {
        ledger?.noteEffect(keyOf(call));
        ledger?.noteEffect(this.key(round));
      },
      take: (call) => {
        const entry = ledger?.take(keyOf(call), {
          id: stepId,
          kind: CALL_KIND,
          inputHash: hashOf(call),
        });
        const parsed = entry ? CallOutputSchema.safeParse(entry.output) : undefined;
        return parsed?.success ? expandResult(parsed.data) : undefined;
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
          output: compactResult(result),
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

/** What a call record stores: the result, with `result` left out where `output` says it. */
function compactResult(result: ToolCallResult): z.infer<typeof CallOutputSchema> {
  const kept: z.infer<typeof CallOutputSchema> = {
    output: result.output,
    ...(result.error === undefined
      ? {}
      : {
          error: result.error,
        }),
    ...(result.approval === undefined
      ? {}
      : {
          approval: result.approval,
        }),
    ...(result.itemId === undefined
      ? {}
      : {
          itemId: result.itemId,
        }),
    ...(result.ran === undefined
      ? {}
      : {
          ran: result.ran,
        }),
  };
  if (result.result === undefined) {
    return kept;
  }
  const resultAs = sameAsOutput(result.result, result.output);
  return resultAs === undefined
    ? {
        ...kept,
        result: result.result,
      }
    : {
        ...kept,
        resultAs,
      };
}

/** How `output` holds `result`, or undefined when it does not. */
function sameAsOutput(result: unknown, output: string): 'text' | 'json' | undefined {
  if (typeof result === 'string') {
    return result === output ? 'text' : undefined;
  }
  try {
    return JSON.stringify(result) === output ? 'json' : undefined;
  } catch {
    return undefined;
  }
}

/** The result a call record stands for. */
function expandResult(stored: z.infer<typeof CallOutputSchema>): ToolCallResult {
  const { resultAs, ...result } = stored;
  if (resultAs === 'text') {
    return {
      ...result,
      result: result.output,
    };
  }
  if (resultAs === 'json') {
    return {
      ...result,
      result: JSON.parse(result.output),
    };
  }
  return result;
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

interface RoundJournal {
  readonly enabled: boolean;
  mark(round: number): void;
  marked(round: number): boolean;
  checkpoint(items: Item[]): void;
  wait(): Promise<void>;
  record(bill: Bill): Promise<void>;
  drop(): Promise<void>;
  check<
    T extends {
      kind: 'continue' | 'ok';
    },
  >(check: () => T): Promise<T>;
}

/** Queue stream checkpoints in order, then keep or drop the finished round. */
export function openRoundJournal({
  roundLedger,
  allItems,
  conversationInput,
  signal,
  emit,
}: {
  roundLedger: RoundLedger | undefined;
  allItems: Item[];
  conversationInput: unknown[];
  signal: AbortSignal | undefined;
  emit: (eventType: string, data: Record<string, unknown>) => void;
}): RoundJournal {
  // Where the loop's lists stood when the current round began, for its record.
  let marks = {
    round: -1,
    log: 0,
    input: 0,
    items: 0,
  };
  const markRound = (round: number): void => {
    marks = {
      round,
      log: roundLedger?.mark() ?? 0,
      input: conversationInput.length,
      items: allItems.length,
    };
  };
  // The current round's checkpoint writes, in order. Its own record waits for
  // them, so a late checkpoint never replaces it.
  let checkpoints: Promise<void> = Promise.resolve();
  const writeRound = async (record: RoundRecord): Promise<void> => {
    if (!roundLedger || signal?.aborted) {
      return;
    }
    if (!(await roundLedger.record(marks.round, marks.log, record))) {
      return;
    }
    emit('model_round_recorded', {
      round: marks.round,
      itemIds: itemIds(record.items),
      done: !record.cut,
    });
  };
  // A rejected round is asked again on the conversation it was asked on, or fails
  // the call, so a resume must not go on from the items it streamed. The same goes
  // for the round that ends the loop.
  const dropCheckpoints = async (): Promise<void> => {
    await checkpoints;
    await roundLedger?.drop(marks.round);
  };
  const rejectRound = async <
    T extends {
      kind: 'continue' | 'ok';
    },
  >(
    check: () => T,
  ): Promise<T> => {
    let result: T;
    try {
      result = check();
    } catch (error: unknown) {
      await dropCheckpoints();
      throw error;
    }
    if (result.kind === 'continue') {
      await dropCheckpoints();
    }
    return result;
  };
  // Record a round the loop goes on from, so a resumed loop can replay it.
  const recordRound = async (bill: Bill): Promise<void> => {
    await checkpoints;
    await writeRound({
      items: allItems.slice(marks.items),
      input: conversationInput.slice(marks.input),
      ...bill,
    });
  };
  // Record the output items a round has finished while it still streams, so a
  // resume goes on from them rather than making them again. The input holds only
  // what the round began with: the tool round adds each function call with its
  // output, as it does for a round that finishes.
  const checkpoint = (finished: Item[]): void => {
    if (!roundLedger) {
      return;
    }
    const record: RoundRecord = {
      items: [
        ...allItems.slice(marks.items),
        ...finished,
      ],
      input: conversationInput.slice(marks.input),
      ...noBill,
      cut: true,
    };
    checkpoints = checkpoints.then(() => writeRound(record));
  };
  return {
    enabled: roundLedger !== undefined,
    mark: markRound,
    marked: (round: number) => marks.round === round,
    checkpoint,
    wait: () => checkpoints,
    record: recordRound,
    drop: dropCheckpoints,
    check: rejectRound,
  };
}

function itemIds(items: ReadonlyArray<Item>): string[] {
  return items.flatMap((item) =>
    'id' in item && typeof item.id === 'string'
      ? [
          item.id,
        ]
      : [],
  );
}
