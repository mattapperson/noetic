/**
 * Timed, traced calls into context layer hooks. Each call of a traced hook adds
 * one `layer.hook` event to the span of the context it runs in (`ctx.trace`),
 * shaped as a `LayerTraceSpan`. Events rather than child spans: an
 * `ExecutionContext` can annotate its span but not open one.
 */

import type { ExecutionContext, LayerTraceSpan } from '@noetic-tools/types';

//#region Types

type TracedHook = LayerTraceSpan['hook'];

interface HookCall<T> {
  ctx: ExecutionContext;
  layerId: string;
  hook: TracedHook;
  /** Milliseconds before the call fails as a timeout; `0` or less waits forever. */
  timeout: number;
  run: () => Promise<T>;
  /** Reads a recall's budget and item count from the hook's result. */
  measure?: (result: T) => Pick<LayerTraceSpan, 'budget' | 'itemCount'>;
}

//#endregion

//#region Public API

/** Span event recording one layer hook call. Attributes follow `LayerTraceSpan`. */
export const LAYER_HOOK_EVENT = 'layer.hook';

/**
 * Runs a layer hook under its timeout and records a `layer.hook` event for it.
 * Rethrows whatever the hook threw (or the timeout), so callers keep their own
 * failure handling.
 */
export async function callHook<T>({
  ctx,
  layerId,
  hook,
  timeout,
  run,
  measure,
}: HookCall<T>): Promise<T> {
  const started = performance.now();
  try {
    const result = await withTimeout(run(), timeout);
    traceHook(ctx, {
      layerId,
      hook,
      duration: performance.now() - started,
      status: 'ok',
      ...measure?.(result),
    });
    return result;
  } catch (e) {
    traceHook(ctx, {
      layerId,
      hook,
      duration: performance.now() - started,
      status: e instanceof HookTimeout ? 'timeout' : 'error',
      error: {
        message: e instanceof Error ? e.message : String(e),
      },
    });
    throw e;
  }
}

/** Records a hook the layer defines but the lifecycle did not call. */
export function traceSkipped(ctx: ExecutionContext, layerId: string, hook: TracedHook): void {
  traceHook(ctx, {
    layerId,
    hook,
    duration: 0,
    status: 'skipped',
  });
}

/** Runs a hook under a timeout without tracing it, for hooks outside `LayerTraceSpan`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HookTimeout(ms)), ms);
    }),
  ]);
}

//#endregion

//#region Helpers

class HookTimeout extends Error {
  constructor(ms: number) {
    super(`Timeout after ${ms}ms`);
  }
}

/** Span event attributes hold only scalars, so nested fields flatten to dotted keys. */
function traceHook(ctx: ExecutionContext, span: LayerTraceSpan): void {
  const attributes: Record<string, string | number | boolean> = {
    layerId: span.layerId,
    hook: span.hook,
    duration: span.duration,
    status: span.status,
  };
  if (span.itemCount !== undefined) {
    attributes.itemCount = span.itemCount;
  }
  if (span.budget) {
    attributes['budget.allocated'] = span.budget.allocated;
    attributes['budget.used'] = span.budget.used;
    attributes['budget.yielded'] = span.budget.yielded;
  }
  if (span.error) {
    attributes['error.message'] = span.error.message;
  }
  ctx.trace.addEvent(LAYER_HOOK_EVENT, attributes);
}

//#endregion
