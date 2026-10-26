import type { Context } from '@noetic-tools/types';
import { emitFrameworkEvent, getBroadcaster } from './broadcaster-utils';
import { ContextImpl } from './context-impl';

//#region Types

/** @internal A provider call as a drain reports it in `drain_started` / `drain_finished`. */
export interface DrainCall {
  readonly kind: 'model_round' | 'decide';
  readonly model: string;
  /** Id of the context that made the call. */
  readonly executionId: string;
  /** The round within its `callModel`, for model rounds. */
  readonly round?: number;
}

/** @internal Why a drain ended. */
export type DrainEnd = 'settled' | 'deadline' | 'stopped';

interface Call {
  readonly info: DrainCall;
  readonly ctx: Context;
  done: boolean;
}

interface Drain {
  readonly root: Context;
  readonly startedAt: number;
  readonly deadline: number;
  /** Every call the drain waited on, so `drain_finished` can say how each ended. */
  readonly calls: Set<Call>;
  end(reason: DrainEnd): void;
  readonly ended: Promise<DrainEnd>;
  /** Resolves once the drain's stop has begun, so held steps see the abort. */
  readonly over: Promise<void>;
  wake(): void;
  /** The whole drain, stop included; a second cancel waits on it. */
  done?: Promise<void>;
}

//#endregion

//#region Drains

/**
 * @internal
 *
 * Graceful stops for one harness. A drain on a context holds back new steps,
 * model rounds and tool calls anywhere beneath it, lets the provider calls
 * already in flight finish, then stops the tree: when nothing is left in
 * flight, at its deadline, or when a second stop cuts it short.
 *
 * A call counts as in flight from dispatch until its caller reaches the next
 * hold or step end, not merely until its response arrives: the response
 * still has to be charged to the context and the step recorded, and stopping
 * the tree before then would lose both.
 */
export class Drains {
  private readonly calls = new Set<Call>();
  private readonly active = new Set<Drain>();

  /**
   * Note a provider call about to be dispatched on `ctx`. Call the returned
   * function once its response is in (or it failed).
   */
  track(ctx: Context | undefined, info: Omit<DrainCall, 'executionId'>): () => void {
    if (!ctx) {
      return () => {};
    }
    const call: Call = {
      info: {
        ...info,
        executionId: ctx.id,
      },
      ctx,
      done: false,
    };
    this.calls.add(call);
    for (const drain of this.active) {
      if (within(ctx, drain.root)) {
        drain.calls.add(call);
      }
    }
    return () => {
      call.done = true;
      // Kept until a hold or step end releases it only while a drain may be
      // waiting on it; otherwise nothing will ever release it.
      if (this.active.size === 0) {
        this.calls.delete(call);
      }
    };
  }

  /**
   * The dispatch gate. Under a drain, release `ctx`'s finished calls and wait
   * until the drain stops the tree; the caller then sees `ctx.aborted`.
   */
  async hold(ctx: Context | undefined): Promise<void> {
    if (!ctx || this.active.size === 0) {
      return;
    }
    this.release(ctx);
    const drain = this.find(ctx);
    if (drain) {
      await drain.over;
    }
  }

  /** A step on `ctx` ended: its finished calls are charged and recorded. */
  release(ctx: Context): void {
    if (this.active.size === 0) {
      return;
    }
    for (const call of this.calls) {
      if (call.done && within(call.ctx, ctx)) {
        this.calls.delete(call);
      }
    }
    for (const drain of this.active) {
      this.settleIfIdle(drain);
    }
  }

  /** The deadline of the drain on `ctx` or one of its ancestors, if one is running. */
  covering(ctx: Context):
    | {
        readonly deadline: number;
      }
    | undefined {
    return this.find(ctx);
  }

  private find(ctx: Context): Drain | undefined {
    for (const drain of this.active) {
      if (within(ctx, drain.root)) {
        return drain;
      }
    }
    return undefined;
  }

  /**
   * Drain `ctx` for up to `ms`, then run `stop`, which must abort the tree
   * before its first `await`: held steps wake as soon as it is called.
   */
  run(ctx: Context, ms: number, stop: () => Promise<void>): Promise<void> {
    const drain = openDrain(ctx, ms);
    for (const call of this.calls) {
      if (within(call.ctx, ctx)) {
        drain.calls.add(call);
      }
    }
    this.active.add(drain);
    drain.done = this.finish(drain, stop);
    return drain.done;
  }

  /**
   * Cut short the drain on `ctx`, if one is running, and return the promise
   * of its stop. A second cancel cancels at once.
   */
  stop(ctx: Context): Promise<void> | undefined {
    for (const drain of this.active) {
      if (drain.root.id === ctx.id) {
        drain.end('stopped');
        return drain.done;
      }
    }
    return undefined;
  }

  private async finish(drain: Drain, stop: () => Promise<void>): Promise<void> {
    emit(drain.root, 'drain_started', {
      executionId: drain.root.id,
      deadline: drain.deadline,
      inFlight: [
        ...drain.calls,
      ].map((call) => call.info),
    });
    this.settleIfIdle(drain);
    const reason = await drain.ended;
    this.active.delete(drain);
    if (this.active.size === 0) {
      for (const call of this.calls) {
        if (call.done) {
          this.calls.delete(call);
        }
      }
    }
    const calls = [
      ...drain.calls,
    ];
    emit(drain.root, 'drain_finished', {
      executionId: drain.root.id,
      reason,
      durationMs: Date.now() - drain.startedAt,
      finished: calls.filter((call) => call.done).map((call) => call.info),
      cutOff: calls.filter((call) => !call.done).map((call) => call.info),
    });
    const stopping = stop();
    drain.wake();
    await stopping;
  }

  private settleIfIdle(drain: Drain): void {
    for (const call of this.calls) {
      if (within(call.ctx, drain.root)) {
        return;
      }
    }
    drain.end('settled');
  }
}

/** The harness's drains, when `ctx` runs on a harness that has them. */
export function drainsOf(ctx: Context | undefined): Drains | undefined {
  const harness = ctx?.harness;
  if (!harness || !('drains' in harness)) {
    return undefined;
  }
  return harness.drains instanceof Drains ? harness.drains : undefined;
}

//#endregion

//#region Helpers

function openDrain(root: Context, ms: number): Drain {
  const startedAt = Date.now();
  let end: (reason: DrainEnd) => void = () => {};
  const ended = new Promise<DrainEnd>((resolve) => {
    end = resolve;
  });
  let wake: () => void = () => {};
  const over = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const timer = setTimeout(() => end('deadline'), ms);
  // Someone else aborting the tree ends the wait: there is nothing left to drain into.
  const signal = root instanceof ContextImpl ? root.abortSignal : undefined;
  const onAbort = (): void => end('stopped');
  signal?.addEventListener('abort', onAbort, {
    once: true,
  });
  void ended.then(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  });
  return {
    root,
    startedAt,
    deadline: startedAt + ms,
    calls: new Set(),
    end,
    ended,
    over,
    wake,
  };
}

/** Whether `ctx` is `root` or runs beneath it. Lanes share their context's id. */
function within(ctx: Context, root: Context): boolean {
  let node: Context | null = ctx;
  while (node) {
    if (node.id === root.id) {
      return true;
    }
    node = node.parent;
  }
  return false;
}

function emit(ctx: Context, eventType: string, data: Record<string, unknown>): void {
  emitFrameworkEvent({
    broadcaster: getBroadcaster(ctx),
    agentName: ctx.harness.config.name,
    eventType,
    data,
  });
}

//#endregion
