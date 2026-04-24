import { estimateTokens } from '../interpreter/message-helpers';
import type { Context } from '../types/context';
import type { ExecutionContext } from '../types/memory';

/**
 * Maps a full `Context` to the lightweight `ExecutionContext` consumed by memory layer hooks.
 * Centralised here so the mapping stays consistent across agent-harness and layer-api.
 */
export function contextToExecCtx(
  ctx: Context,
  callModel?: ExecutionContext['callModel'],
): ExecutionContext {
  return {
    executionId: ctx.id,
    threadId: ctx.threadId,
    resourceId: ctx.resourceId,
    depth: ctx.depth,
    stepNumber: ctx.stepCount,
    tokenUsage: {
      input: ctx.tokens.input,
      output: ctx.tokens.output,
    },
    cost: ctx.cost,
    fs: ctx.harness.fs,
    shell: ctx.harness.shell,
    callModel,
    tokenize: estimateTokens,
    trace: {
      setAttribute: (key, value) => ctx.span.setAttribute(key, value),
      addEvent: (name, attributes) => ctx.span.addEvent(name, attributes),
    },
  };
}
