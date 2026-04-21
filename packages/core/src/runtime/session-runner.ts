import type { Context } from '../types/context';
import type { HarnessResponse } from '../types/harness-result';
import type { ExecuteInput, InputMessageItem, Item } from '../types/items';
import type { HarnessStatus } from '../types/runtime';
import { emitFrameworkEvent } from './broadcaster-utils';
import { EventBroadcaster } from './event-broadcaster';
import type { QueuedMessage } from './message-queue';
import { MessageQueue } from './message-queue';

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

export interface SessionRunnerOpts {
  readonly threadId: string;
  readonly agentName: string;
  readonly runTurn: RunTurnFn;
  readonly createContext: (input: ExecuteInput, turnId: string) => Context;
  readonly disposeContext?: (ctx: Context) => Promise<void>;
}

//#endregion

//#region Helpers

function inputToItems(input: ExecuteInput): Item[] {
  if (typeof input === 'string') {
    if (input.length === 0) {
      return [];
    }
    const item: InputMessageItem = {
      id: `user-${crypto.randomUUID()}`,
      type: 'message',
      role: 'user',
      status: 'completed',
      content: [
        {
          type: 'input_text',
          text: input,
        },
      ],
    };
    return [
      item,
    ];
  }
  if (Array.isArray(input)) {
    return input;
  }
  return [
    input,
  ];
}

function mergeInputs(messages: QueuedMessage[]): ExecuteInput {
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
 * Per-thread runner. Drains the MessageQueue and drives turns on the shared
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
  private readonly createContext: (input: ExecuteInput, turnId: string) => Context;
  private readonly disposeContext?: (ctx: Context) => Promise<void>;

  private status: HarnessStatus = {
    kind: 'idle',
  };
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
    this.disposeContext = opts.disposeContext;

    this.queue.subscribe(() => {
      this.kick();
    });
  }

  getStatus(): HarnessStatus {
    return this.status;
  }

  /** Resolves once the queue has been drained and the runner is idle with a
   *  response available. If nothing has run yet, waits for the first turn. */
  getAgentResponse(): Promise<HarnessResponse> {
    if (this.status.kind === 'idle' && this.queue.size === 0 && this.lastResponse) {
      return Promise.resolve(this.lastResponse);
    }
    if (this.lastError) {
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

  /** Start the drain loop if not already running. Safe to call many times. */
  kick(): void {
    if (this.loopPromise) {
      return;
    }
    if (this.queue.size === 0) {
      return;
    }
    this.loopPromise = this.drain().finally(() => {
      this.loopPromise = undefined;
      // If messages arrived during finally, run again.
      if (this.queue.size > 0) {
        this.kick();
      }
    });
  }

  private async drain(): Promise<void> {
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
    const mergedInput = mergeInputs(messages);
    const ctx = this.createContext(mergedInput, turnId);
    this.currentCtx = ctx;

    emitFrameworkEvent({
      broadcaster: this.broadcaster,
      agentName: this.agentName,
      eventType: 'turn_started',
      data: {
        turnId,
        messageIds: messages.map((m) => m.id),
      },
    });

    const turn: TurnContext = {
      turnId,
      session: this,
    };

    try {
      const text = await this.runTurn(ctx, turn, controller.signal);
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
      const error = err instanceof Error ? err : new Error(String(err));
      this.lastError = error;
      emitFrameworkEvent({
        broadcaster: this.broadcaster,
        agentName: this.agentName,
        eventType: 'turn_aborted',
        data: {
          turnId,
          reason: error.message,
        },
      });
      this.rejectWaiters(error);
    } finally {
      if (this.disposeContext && this.currentCtx) {
        await this.disposeContext(this.currentCtx).catch(() => {});
      }
      this.currentCtx = undefined;
      this.currentController = undefined;
      this.status = {
        kind: 'idle',
      };
    }
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

function buildResponse(text: string, ctx: Context): HarnessResponse {
  return {
    items: ctx.itemLog.items,
    usage: {
      inputTokens: ctx.tokens.input,
      outputTokens: ctx.tokens.output,
      cachedTokens: ctx.tokens.cached && ctx.tokens.cached > 0 ? ctx.tokens.cached : undefined,
    },
    cost: ctx.cost > 0 ? ctx.cost : undefined,
    text,
    lastLayerUsage: ctx.lastLayerUsage,
  };
}

//#endregion
