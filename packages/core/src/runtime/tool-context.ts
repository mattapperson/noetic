import type {
  AgentHarnessContract,
  Context,
  ToolContext,
  ToolExecutionContext,
} from '@noetic-tools/types';

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
  callId?: string,
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
    ...(callId === undefined
      ? {}
      : {
          callId,
        }),
  };
}
