import type { TurnContext } from '@openrouter/agent';
import type { Context } from '../types/context';
import type { AgentHarnessContract } from '../types/runtime';
import type { ToolExecutionContext, ToolMemory } from '../types/tool-context';

export function buildToolMemory(harness: AgentHarnessContract, ctx: Context): ToolMemory {
  return {
    get<T>(layerId: string): T | undefined {
      return harness.getLayerState(ctx.id, layerId);
    },
    set<T>(layerId: string, state: T): void {
      harness.setLayerState(ctx.id, layerId, state);
    },
  };
}

export function buildToolExecutionContext(
  ctx: Context,
  harness: AgentHarnessContract,
  turnContext?: TurnContext,
): ToolExecutionContext {
  return {
    ctx,
    harness,
    memory: buildToolMemory(harness, ctx),
    assembledView: ctx.itemLog.items,
    lastStepMeta: ctx.lastStepMeta,
    turnContext,
  };
}
