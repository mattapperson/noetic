import type {
  AgentHarnessContract,
  Context,
  ToolContext,
  ToolExecutionContext,
} from '@noetic-tools/types';

function rootIdOf(ctx: Context): string {
  let node: Context = ctx;
  while (node.parent) {
    node = node.parent;
  }
  return node.id;
}

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

/** The idempotency key of a model tool call: the turn's root execution and the tool call id. */
export function toolIdempotencyKey(executionId: string, toolCallId: string): string {
  return `${executionId}:tool:${toolCallId}`;
}

export function buildToolExecutionContext(
  ctx: Context,
  harness: AgentHarnessContract,
  call?:
    | string
    | {
        callId?: string;
        /** The id the idempotency key is made from, when it is not `callId`. */
        recordId?: string;
      },
): ToolExecutionContext {
  const callId = typeof call === 'string' ? call : call?.callId;
  const recordId = typeof call === 'string' ? call : (call?.recordId ?? call?.callId);
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
          // The root execution's id: a child context gets a new id on every resume.
          idempotencyKey: toolIdempotencyKey(rootIdOf(ctx), recordId ?? callId),
        }),
  };
}
