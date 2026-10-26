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
  /** Id of the call's dispatch record, when the harness keeps them (spec 23). */
  readonly dispatchId?: string;
  /** The provider's id for the call, once its response headers arrived. */
  readonly generationId?: string;
}

/**
 * @internal The dispatch record of a tracked call. Read when a drain reports, so a
 * generation id saved after dispatch still shows.
 */
export interface DrainRecord {
  readonly id: string;
  readonly generationId?: string;
}

type DrainCallInfo = Omit<DrainCall, 'executionId' | 'dispatchId' | 'generationId'>;

/** @internal Why a drain ended. */
export type DrainEnd = 'settled' | 'deadline' | 'stopped';

interface Call {
  readonly info: DrainCallInfo;
  readonly ctx: Context;
  readonly record?: DrainRecord;
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
   * Note a provider call about to be dispatched on `ctx` under `record`. Call the
   * returned function once its response is in (or it failed).
   */
  track(ctx: Context | undefined, info: DrainCallInfo, record?: DrainRecord): () => void {
    if (!ctx) {
      return () => {};
    }
    const call: Call = {
      info,
      ctx,
      record,
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
   * until a drain over it stops the tree; the caller then sees `ctx.aborted`.
   */
  async hold(ctx: Context | undefined): Promise<void> {
    if (!ctx || this.active.size === 0 || ctx.aborted) {
      return;
    }
    this.release(ctx);
    const over = [
      ...this.active,
    ]
      .filter((drain) => within(ctx, drain.root))
      .map((drain) => drain.over);
    if (over.length > 0) {
      await Promise.race(over);
    }
  }

  /**
   * The step running on `ctx` ended, or reached a hold: the finished calls it
   * made are charged and recorded. Calls a concurrent dispatch on the same
   * context made stay in flight until that dispatch ends.
   */
  release(ctx: Context): void {
    if (this.active.size === 0) {
      return;
    }
    for (const call of this.calls) {
      if (call.done && inside(call.ctx, ctx)) {
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
      ].map(report),
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
      finished: calls.filter((call) => call.done).map(report),
      cutOff: calls.filter((call) => !call.done).map(report),
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

/** Timers round longer delays down to 1 ms; the longest a timer can wait. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

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
  const timer = setTimeout(() => end('deadline'), Math.min(ms, MAX_TIMEOUT_MS));
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

function report(call: Call): DrainCall {
  const { record } = call;
  return {
    ...call.info,
    executionId: call.ctx.id,
    ...(record
      ? {
          dispatchId: record.id,
        }
      : {}),
    ...(record?.generationId
      ? {
          generationId: record.generationId,
        }
      : {}),
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

/**
 * Whether `ctx` runs within the dispatch `step` is the lane of: beneath its
 * context, or on that context under its execution path. Lanes of one context
 * share its id, so the path is what tells concurrent dispatches apart.
 */
function inside(ctx: Context, step: Context): boolean {
  for (let node: Context | null = ctx; node; node = node.parent) {
    if (node.id === step.id) {
      return under(pathOf(node), pathOf(step));
    }
  }
  return false;
}

function pathOf(ctx: Context): string {
  return ctx instanceof ContextImpl ? ctx.currentPath() : '';
}

/** Whether `path` is `base` or a path beneath it (`/step#n` or `[i]` segments). */
function under(path: string, base: string): boolean {
  if (!path.startsWith(base)) {
    return false;
  }
  const next = path[base.length];
  return next === undefined || next === '/' || next === '[';
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
