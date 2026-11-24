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

/** The idempotency key of a model tool call: the turn's execution and the tool call id. */
export function toolIdempotencyKey(executionId: string, toolCallId: string): string {
  return `${executionId}:tool:${toolCallId}`;
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
          idempotencyKey: toolIdempotencyKey(ctx.id, callId),
        }),
  };
}
