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

/**
 * The idempotency key of a tool call: the turn's root execution and the call's id.
 * With `scope`, where in the run the call was made, since a call id is only as
 * unique as the provider that made it up.
 */
export function toolIdempotencyKey(
  executionId: string,
  toolCallId: string,
  scope?: string,
): string {
  return scope === undefined
    ? `${executionId}:tool:${toolCallId}`
    : `${executionId}:tool:${scope}:${toolCallId}`;
}

/** Where in the run each tool context's call was made, for those built knowing it. */
const keyScopes = new WeakMap<ToolExecutionContext, string>();

/** @internal The scope `toolCtx`'s idempotency key was made with, if it had one. */
export function keyScopeOf(toolCtx: ToolExecutionContext): string | undefined {
  return keyScopes.get(toolCtx);
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
        /** Where in the run the call was made (see `toolIdempotencyKey`). */
        keyScope?: string;
      },
): ToolExecutionContext {
  const callId = typeof call === 'string' ? call : call?.callId;
  const recordId = typeof call === 'string' ? call : (call?.recordId ?? call?.callId);
  const keyScope = typeof call === 'string' ? undefined : call?.keyScope;
  const toolContext = buildToolContext(harness, ctx);
  const built: ToolExecutionContext = {
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
    ...(recordId === undefined
      ? {}
      : {
          // The root execution's id: a child context gets a new id on every resume.
          idempotencyKey: toolIdempotencyKey(rootIdOf(ctx), recordId, keyScope),
        }),
  };
  if (keyScope !== undefined) {
    keyScopes.set(built, keyScope);
  }
  return built;
}
