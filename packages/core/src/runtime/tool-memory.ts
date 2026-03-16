import type { TurnContext } from '@openrouter/sdk';
import type { Context } from '../types/context';
import type { Runtime } from '../types/runtime';
import type { ToolExecutionContext, ToolMemory } from '../types/tool-context';

const NO_OP_TOOL_MEMORY: ToolMemory = {
  get: () => undefined,
  set: () => {},
};

export function buildToolMemory(runtime: Runtime, ctx: Context): ToolMemory {
  return {
    get<T>(layerId: string): T | undefined {
      return runtime.getLayerState(ctx.id, layerId);
    },
    set<T>(layerId: string, state: T): void {
      runtime.setLayerState(ctx.id, layerId, state);
    },
  };
}

export function buildToolExecutionContext(
  ctx: Context,
  runtime?: Runtime,
  turnContext?: TurnContext,
): ToolExecutionContext {
  return {
    ctx,
    // SAFETY: runtime is undefined only in bare `execute()` calls without a Runtime wrapper.
    // Tools that access runtime in that path will get undefined, which is safe — runtime-dependent
    // operations (spawn, channels) will throw at the call site with a clear error.
    runtime: runtime as Runtime,
    memory: runtime ? buildToolMemory(runtime, ctx) : NO_OP_TOOL_MEMORY,
    assembledView: ctx.itemLog.items,
    lastStepMeta: ctx.lastStepMeta,
    turnContext,
  };
}
