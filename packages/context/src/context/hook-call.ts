/**
 * Timed, traced calls into context layer hooks. Each call of a traced hook is
 * recorded as one `layer.hook` record shaped as a `LayerTraceSpan`: a child
 * span of the context's span when the context can open one
 * (`ctx.trace.createSpan`), otherwise an event on the context's span. Never
 * both, so a backend sees each call once.
 */

import type { ExecutionContext, ExecutionSpan, LayerTraceSpan } from '@noetic-tools/types';

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

type Outcome<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: unknown;
    };

//#endregion

//#region Public API

/** Name of the span (or span event) recording one layer hook call. */
export const LAYER_HOOK_EVENT = 'layer.hook';

/** Attributes of a `layer.hook` span. A span times itself, so it carries no duration. */
export const LayerHookAttr = {
  LAYER_ID: 'noetic.layer.id',
  HOOK: 'noetic.layer.hook',
  STATUS: 'noetic.layer.status',
  ITEM_COUNT: 'noetic.layer.item_count',
  BUDGET_ALLOCATED: 'noetic.layer.budget.allocated',
  BUDGET_USED: 'noetic.layer.budget.used',
  BUDGET_YIELDED: 'noetic.layer.budget.yielded',
} as const;

/**
 * Runs a layer hook under its timeout and records a `layer.hook` span (or
 * event) for it. Rethrows whatever the hook threw (or the timeout), so callers
 * keep their own failure handling. The span opens before the hook runs and ends
 * once it settles.
 */
export async function callHook<T>({
  ctx,
  layerId,
  hook,
  timeout,
  run,
  measure,
}: HookCall<T>): Promise<T> {
  const span = ctx.trace.createSpan?.(LAYER_HOOK_EVENT);
  const started = performance.now();
  const outcome = await settle(withTimeout(run(), timeout));
  const duration = performance.now() - started;
  if (outcome.ok) {
    await traceHook(ctx, span, {
      layerId,
      hook,
      duration,
      status: 'ok',
      ...measure?.(outcome.value),
    });
    return outcome.value;
  }
  await traceHook(ctx, span, {
    layerId,
    hook,
    duration,
    status: outcome.error instanceof HookTimeout ? 'timeout' : 'error',
    error: {
      message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
    },
  });
  throw outcome.error;
}

/** Records a hook the layer defines but the lifecycle did not call. */
export async function traceSkipped(
  ctx: ExecutionContext,
  layerId: string,
  hook: TracedHook,
): Promise<void> {
  await traceHook(ctx, ctx.trace.createSpan?.(LAYER_HOOK_EVENT), {
    layerId,
    hook,
    duration: 0,
    status: 'skipped',
  });
}

/** Runs a hook under a timeout without tracing it, for calls that must leave no trace (a peek recall). */
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

async function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  try {
    return {
      ok: true,
      value: await promise,
    };
  } catch (error) {
    return {
      ok: false,
      error,
    };
  }
}

async function traceHook(
  ctx: ExecutionContext,
  span: ExecutionSpan | undefined,
  record: LayerTraceSpan,
): Promise<void> {
  if (!span) {
    ctx.trace.addEvent(LAYER_HOOK_EVENT, eventAttributes(record));
    return;
  }
  for (const [key, value] of Object.entries(spanAttributes(record))) {
    span.setAttribute(key, value);
  }
  await span.end();
}

type Attributes = Record<string, string | number | boolean>;

function spanAttributes(record: LayerTraceSpan): Attributes {
  const attributes: Attributes = {
    [LayerHookAttr.LAYER_ID]: record.layerId,
    [LayerHookAttr.HOOK]: record.hook,
    [LayerHookAttr.STATUS]: record.status,
  };
  if (record.itemCount !== undefined) {
    attributes[LayerHookAttr.ITEM_COUNT] = record.itemCount;
  }
  if (record.budget) {
    attributes[LayerHookAttr.BUDGET_ALLOCATED] = record.budget.allocated;
    attributes[LayerHookAttr.BUDGET_USED] = record.budget.used;
    attributes[LayerHookAttr.BUDGET_YIELDED] = record.budget.yielded;
  }
  if (record.error) {
    attributes.error = true;
    attributes['error.message'] = record.error.message;
  }
  return attributes;
}

/** Span event attributes hold only scalars, so nested fields flatten to dotted keys. */
function eventAttributes(record: LayerTraceSpan): Attributes {
  const attributes: Attributes = {
    layerId: record.layerId,
    hook: record.hook,
    duration: record.duration,
    status: record.status,
  };
  if (record.itemCount !== undefined) {
    attributes.itemCount = record.itemCount;
  }
  if (record.budget) {
    attributes['budget.allocated'] = record.budget.allocated;
    attributes['budget.used'] = record.budget.used;
    attributes['budget.yielded'] = record.budget.yielded;
  }
  if (record.error) {
    attributes['error.message'] = record.error.message;
  }
  return attributes;
}

//#endregion
