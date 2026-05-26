import type { Context } from '../types/context';
import type { ExecutionContext } from '../types/memory';
import { estimateTokens } from '../util/message-helpers';

/**
 * Optional overrides for `contextToExecCtx`. Used by `executeSpawn` to build
 * parent and child execution contexts that reuse the same tokenize / trace /
 * layer-state wiring as the main path, but with spawn-specific identity
 * (`executionId`, `depth`, `stepNumber`, and the scope used for layer-state
 * reads).
 */
export interface ExecCtxOverrides {
  callModel?: ExecutionContext['callModel'];
  executionId?: string;
  depth?: number;
  stepNumber?: number;
  tokenUsage?: ExecutionContext['tokenUsage'];
  cost?: number;
  /** Execution id to scope `readLayerState` to (defaults to `ctx.id`). */
  readLayerStateId?: string;
}

/**
 * Maps a full `Context` to the lightweight `ExecutionContext` consumed by memory layer hooks.
 * Centralised here so the mapping stays consistent across agent-harness, layer-api, and the
 * spawn interpreter.
 */
export function contextToExecCtx(ctx: Context, overrides?: ExecCtxOverrides): ExecutionContext {
  const readLayerStateId = overrides?.readLayerStateId ?? ctx.id;
  return {
    executionId: overrides?.executionId ?? ctx.id,
    threadId: ctx.threadId,
    resourceId: ctx.resourceId,
    depth: overrides?.depth ?? ctx.depth,
    stepNumber: overrides?.stepNumber ?? ctx.stepCount,
    tokenUsage: overrides?.tokenUsage ?? {
      input: ctx.tokens.input,
      output: ctx.tokens.output,
    },
    cost: overrides?.cost ?? ctx.cost,
    fs: ctx.harness.fs,
    shell: ctx.harness.shell,
    callModel: overrides?.callModel,
    tokenize: estimateTokens,
    trace: {
      setAttribute: (key, value) => ctx.span.setAttribute(key, value),
      addEvent: (name, attributes) => ctx.span.addEvent(name, attributes),
    },
    readLayerState: <T>(layerId: string): T | undefined =>
      ctx.harness.getLayerState<T>(readLayerStateId, layerId),
  };
}
