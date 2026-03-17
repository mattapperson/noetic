import type { TurnContext } from '@openrouter/sdk';
import type { Context } from '../types/context';
import type { Runtime } from '../types/runtime';
import type { ToolExecutionContext, ToolMemory } from '../types/tool-context';

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
  runtime: Runtime,
  turnContext?: TurnContext,
): ToolExecutionContext {
  return {
    ctx,
    runtime,
    memory: buildToolMemory(runtime, ctx),
    assembledView: ctx.itemLog.items,
    lastStepMeta: ctx.lastStepMeta,
    turnContext,
  };
}
