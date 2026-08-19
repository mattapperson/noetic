import type {
  AgentHarnessContract,
  Context,
  ToolContext,
  ToolExecutionContext,
} from '@noetic-tools/types';
import type { TurnContext } from '@openrouter/agent';

function buildToolContext(harness: AgentHarnessContract, ctx: Context): ToolContext {
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
  const toolContext = buildToolContext(harness, ctx);
  return {
    ctx,
    harness,
    fs: harness.fs,
    shell: harness.shell,
    context: toolContext,
    assembledView: ctx.itemLog.items,
    lastStepMeta: ctx.lastStepMeta,
    turnContext,
  };
}
