import type {
  AgentHarnessContract,
  Context,
  ToolExecutionContext,
  ToolMemory,
} from '@noetic-tools/types';
import type { TurnContext } from '@openrouter/agent';

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
    fs: harness.fs,
    shell: harness.shell,
    memory: buildToolMemory(harness, ctx),
    assembledView: ctx.itemLog.items,
    lastStepMeta: ctx.lastStepMeta,
    turnContext,
  };
}
