import type {
  Context,
  HarnessResponse,
  HarnessStatus,
  Item,
  SessionUsage,
} from '@noetic-tools/types';
import { isNoeticError } from '@noetic-tools/types';
import { emitFrameworkEvent } from './broadcaster-utils';
import { EventBroadcaster } from './event-broadcaster';
import type { QueuedMessage } from './message-queue';
import { inputToItems, isSteer, MessageQueue } from './message-queue';

//#region Types

/** @internal Callback the harness supplies to run a single turn against a
 *  prepared context. The runner invokes this once per turn; it returns the
 *  final text as a string and must append any produced items to `ctx.itemLog`. */
export type RunTurnFn = (ctx: Context, turn: TurnContext, signal: AbortSignal) => Promise<string>;

/** @internal Everything the harness needs to stamp the current turn. */
export interface TurnContext {
  readonly turnId: string;
  readonly session: SessionRunner;
}

/** @internal Callback the harness supplies to build a fresh context for a
 *  single turn. Receives the already-converted items to seed the context
 *  (so the runner is the single point of ExecuteInput → Item[] conversion),
 *  plus the messages being delivered this turn so the harness can honour
 *  per-turn `ExecuteOptions` (the first message's options establish
 *  resourceId/state/context for the turn). */
export type CreateContextFn = (
  items: ReadonlyArray<Item>,
  turnId: string,
  messages: ReadonlyArray<QueuedMessage>,
) => Context | Promise<Context>;

/** @internal What one turn spent: its context's usage at the end, less at the start. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  cost: number;
  billedCost: number;
}

export interface SessionRunnerOpts {
  readonly threadId: string;
  readonly agentName: string;
  readonly runTurn: RunTurnFn;
  readonly createContext: CreateContextFn;
  /**
   * Called once per turn, success or not, with what the turn spent. A durable host
   * writes it to storage and hands the stored totals back through `seedUsage`.
   */
  readonly onTurnUsage?: (usage: TurnUsage) => Promise<void>;
}

//#endregion

//#region Helpers

function mergeInputsToItems(messages: ReadonlyArray<QueuedMessage>): Item[] {
  const items: Item[] = [];
  for (const msg of messages) {
    items.push(...inputToItems(msg.input));
  }
  return items;
}

//#endregion

//#region SessionRunner

/**
 * @internal
 *
 * Per-thread runner. Works through the MessageQueue and drives turns on the shared
 * session broadcaster. Emits `turn_started` / `turn_completed` /
 * `inbox_injected` framework events so consumers can correlate queued
 * messages with the turn that delivered them.
 *
 * Abort semantics: when `abort()` is called, the current AbortController is
 * fired (cancelling the in-flight LLM call) and a flag is set so the runner
 * does NOT auto-restart from the queue until the caller re-kicks. For the
 * ESC-restart UX, callers typically enqueue the new message first, then
 * abort — the new message is the head of the queue when the runner wakes.
 */
export class SessionRunner {
  readonly threadId: string;
  readonly broadcaster = new EventBroadcaster();
  readonly queue = new MessageQueue();

  private readonly agentName: string;
  private readonly runTurn: RunTurnFn;
  private readonly createContext: CreateContextFn;

  private status: HarnessStatus = {
    kind: 'idle',
  };
  /** Cumulative token/cost accounting across every turn this session has run,
   *  including turns that failed or were aborted after partial model work. */
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  /** `undefined` until some turn reports a cache figure, so a provider that
   *  explicitly reported 0 cached tokens stays distinguishable from a provider
   *  that reports nothing about caching at all (see `SessionUsage`). */
  private totalCachedTokens: number | undefined;
  private totalCost = 0;
  private totalBilledCost = 0;
  private readonly onTurnUsage?: (usage: TurnUsage) => Promise<void>;
  private currentController?: AbortController;
  private currentCtx?: Context;
  private loopPromise?: Promise<void>;
  private lastResponse?: HarnessResponse;
  private lastError?: Error;
  private readonly responseWaiters: Array<{
    resolve: (r: HarnessResponse) => void;
    reject: (e: Error) => void;
  }> = [];

  constructor(opts: SessionRunnerOpts) {
    this.threadId = opts.threadId;
    this.agentName = opts.agentName;
    this.runTurn = opts.runTurn;
    this.createContext = opts.createContext;
    this.onTurnUsage = opts.onTurnUsage;

    this.queue.subscribe(() => {
      this.kick();
    });
  }

  getStatus(): HarnessStatus {
    return this.status;
  }

  /** The running turn's context, if a turn is running. */
  get context(): Context | undefined {
    return this.currentCtx;
  }

  /** Queue a message. A steer that arrives mid-turn is announced first, so
   *  `steer_accepted` always precedes the `inbox_injected` that applies it. */
  enqueue(message: QueuedMessage): void {
    if (this.status.kind === 'generating' && isSteer(message)) {
      emitFrameworkEvent({
        broadcaster: this.broadcaster,
        agentName: this.agentName,
        eventType: 'steer_accepted',
        data: {
          messageId: message.id,
          turnId: this.status.turnId,
          deliveryMode: message.deliveryMode,
        },
      });
    }
    this.queue.enqueue(message);
  }

  /** Cumulative token usage and cost across all turns this session has run. */
  getUsage(): SessionUsage {
    return {
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      cachedTokens: this.totalCachedTokens,
      cost: this.totalCost > 0 ? this.totalCost : undefined,
      billedCost: this.totalBilledCost > 0 ? this.totalBilledCost : undefined,
    };
  }

  /** Replace the totals with ones a durable host read back from storage. */
  seedUsage(usage: SessionUsage): void {
    this.totalInputTokens = usage.inputTokens;
    this.totalOutputTokens = usage.outputTokens;
    this.totalCachedTokens = usage.cachedTokens;
    this.totalCost = usage.cost ?? 0;
    this.totalBilledCost = usage.billedCost ?? 0;
  }

  /** Resolves once the queue has been drained and the runner is idle with a
   *  response available. If nothing has run yet, waits for the first turn.
   *
   *  The cached `lastError` is only surfaced when the session is genuinely
   *  idle with no pending work. If a new turn is running or a message is
   *  queued, the caller is asking about the NEXT response — we must wait
   *  for that turn rather than reject with the stale error. */
  getAgentResponse(): Promise<HarnessResponse> {
    if (this.status.kind === 'idle' && this.queue.size === 0 && this.lastResponse) {
      return Promise.resolve(this.lastResponse);
    }
    if (this.status.kind === 'idle' && this.queue.size === 0 && this.lastError) {
      return Promise.reject(this.lastError);
    }
    return new Promise<HarnessResponse>((resolve, reject) => {
      this.responseWaiters.push({
        resolve,
        reject,
      });
    });
  }

  /** Cancel the in-flight turn. Does NOT re-kick — callers that want restart
   *  behaviour should enqueue a message before/after calling abort. */
  async abort(reason?: string): Promise<void> {
    if (this.status.kind !== 'generating') {
      return;
    }
    const turnId = this.status.turnId;
    this.status = {
      kind: 'aborting',
      turnId,
    };
    const ctx = this.currentCtx;
    if (ctx) {
      ctx.abort(reason);
    }
    this.currentController?.abort(reason);
    await this.loopPromise?.catch(() => {
      // The abort surfaces as a rejection; we swallow it here because callers
      // observe it via the broadcaster / lastError, not the abort() return.
    });
  }

  /** Start the queue loop if not already running. Safe to call many times. */
  kick(): void {
    if (this.loopPromise) {
      return;
    }
    if (this.queue.size === 0) {
      return;
    }
    this.loopPromise = this.runQueue().finally(() => {
      this.loopPromise = undefined;
      // If messages arrived during finally, run again.
      if (this.queue.size > 0) {
        this.kick();
      }
    });
  }

  private async runQueue(): Promise<void> {
    while (this.queue.size > 0) {
      const messages = this.queue.drainAll();
      if (messages.length === 0) {
        break;
      }
      await this.runOneTurn(messages);
    }
  }

  private async runOneTurn(messages: QueuedMessage[]): Promise<void> {
    const turnId = crypto.randomUUID();
    const startedAt = Date.now();
    this.status = {
      kind: 'generating',
      startedAt,
      turnId,
    };

    const controller = new AbortController();
    this.currentController = controller;
    // The runner is the single point of ExecuteInput → Item[] conversion —
    // the harness's createContext callback receives Item[] directly and
    // seeds the context without re-converting.
    const items = mergeInputsToItems(messages);
    let ctx: Context;
    try {
      ctx = await this.createContext(items, turnId, messages);
    } catch (err: unknown) {
      this.failBeforeStart(turnId, err);
      return;
    }
    this.currentCtx = ctx;
    // A resumed turn's context already carries what the cut-off attempt spent; only
    // the increase belongs to this turn.
    const start = usageOf(ctx);

    emitFrameworkEvent({
      broadcaster: this.broadcaster,
      agentName: this.agentName,
      eventType: 'turn_started',
      data: {
        turnId,
        messageIds: messages.map((m) => m.id),
      },
    });
    // Input items never appear in the SDK stream — item_appended is what
    // carries them into getItemStream (and any other log-faithful consumer).
    for (const item of items) {
      emitFrameworkEvent({
        broadcaster: this.broadcaster,
        agentName: this.agentName,
        eventType: 'item_appended',
        data: {
          item,
        },
      });
    }

    const turn: TurnContext = {
      turnId,
      session: this,
    };

    try {
      const text = await this.runTurn(ctx, turn, controller.signal);
      await this.settleUsage(start, ctx);
      const response = buildResponse(text, ctx);
      this.lastResponse = response;
      this.lastError = undefined;
      emitFrameworkEvent({
        broadcaster: this.broadcaster,
        agentName: this.agentName,
        eventType: 'turn_completed',
        data: {
          turnId,
          durationMs: Date.now() - startedAt,
        },
      });
      // Only resolve waiters when the queue is fully drained; otherwise let
      // the next turn's completion surface the final response. This matches
      // `getAgentResponse`'s contract: "once the session has finished
      // processing its queue".
      if (this.queue.size === 0) {
        this.resolveWaiters(response);
      }
    } catch (err: unknown) {
      // An aborted turn still consumed whatever the model billed before the cut.
      await this.settleUsage(start, ctx);
      const error = err instanceof Error ? err : new Error(String(err));
      this.lastError = error;
      emitFrameworkEvent({
        broadcaster: this.broadcaster,
        agentName: this.agentName,
        eventType: 'turn_aborted',
        data: {
          turnId,
          reason: error.message,
          // The typed kind ('cancelled', 'model_refused', …) so consumers can
          // classify the abort without parsing the human-readable message.
          errorKind: isNoeticError(error) ? error.noeticError.kind : undefined,
        },
      });
      this.rejectWaiters(error);
    } finally {
      this.currentCtx = undefined;
      this.currentController = undefined;
      this.status = {
        kind: 'idle',
      };
    }
  }

  /**
   * Add what the turn spent to the session's totals, before anyone waiting on the turn
   * hears it settled — so `getUsage()` after `getAgentResponse()` includes it.
   */
  private async settleUsage(start: TurnUsage, ctx: Context): Promise<void> {
    const spent = usageSince(start, ctx);
    this.totalInputTokens += spent.inputTokens;
    this.totalOutputTokens += spent.outputTokens;
    // Only ever leave `undefined` behind when NO turn reported a figure —
    // a turn that reported 0 must surface as 0, not "unreported".
    if (spent.cachedTokens !== undefined) {
      this.totalCachedTokens = (this.totalCachedTokens ?? 0) + spent.cachedTokens;
    }
    this.totalCost += spent.cost;
    this.totalBilledCost += spent.billedCost;
    await this.onTurnUsage?.(spent);
  }

  /** A turn whose context could not be built: report it like any other failed turn. */
  private failBeforeStart(turnId: string, err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this.lastError = error;
    emitFrameworkEvent({
      broadcaster: this.broadcaster,
      agentName: this.agentName,
      eventType: 'turn_aborted',
      data: {
        turnId,
        reason: error.message,
        errorKind: isNoeticError(error) ? error.noeticError.kind : undefined,
      },
    });
    this.rejectWaiters(error);
    this.currentController = undefined;
    this.status = {
      kind: 'idle',
    };
  }

  private resolveWaiters(response: HarnessResponse): void {
    const pending = this.responseWaiters.splice(0, this.responseWaiters.length);
    for (const w of pending) {
      w.resolve(response);
    }
  }

  private rejectWaiters(err: Error): void {
    const pending = this.responseWaiters.splice(0, this.responseWaiters.length);
    for (const w of pending) {
      w.reject(err);
    }
  }
}

//#endregion

//#region buildResponse

function usageOf(ctx: Context): TurnUsage {
  return {
    inputTokens: ctx.tokens.input,
    outputTokens: ctx.tokens.output,
    cachedTokens: ctx.tokens.cached,
    cost: ctx.cost,
    billedCost: ctx.billedCost,
  };
}

function usageSince(start: TurnUsage, ctx: Context): TurnUsage {
  const now = usageOf(ctx);
  return {
    inputTokens: now.inputTokens - start.inputTokens,
    outputTokens: now.outputTokens - start.outputTokens,
    cachedTokens:
      now.cachedTokens === undefined ? undefined : now.cachedTokens - (start.cachedTokens ?? 0),
    cost: now.cost - start.cost,
    billedCost: now.billedCost - start.billedCost,
  };
}

function buildResponse(text: string, ctx: Context): HarnessResponse {
  return {
    items: ctx.itemLog.items,
    usage: {
      inputTokens: ctx.tokens.input,
      outputTokens: ctx.tokens.output,
      // Passed through verbatim: `ctx.tokens.cached` is already
      // undefined-unless-reported, so collapsing a reported 0 to `undefined`
      // here would re-erase the distinction between "nothing was cached" and
      // "this provider says nothing about caching". Matches `SessionUsage`.
      cachedTokens: ctx.tokens.cached,
    },
    cost: ctx.cost > 0 ? ctx.cost : undefined,
    billedCost: ctx.billedCost > 0 ? ctx.billedCost : undefined,
    text,
    lastLayerUsage: ctx.lastLayerUsage,
  };
}

//#endregion
