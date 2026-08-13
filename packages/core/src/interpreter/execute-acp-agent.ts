/**
 * ACP step handler: drives an external coding agent over the Agent Client
 * Protocol for one prompt turn and folds its output back into the Noetic
 * execution context — the ACP analogue of `executeCallModel`.
 *
 * Core reaches the agent only through the `@noetic-tools/types` contract, so no
 * protocol library or agent SDK enters its dependency graph.
 */

import type {
  AcpAgent,
  AcpAgentConnection,
  AcpClientActivity,
  AcpClientHost,
  AcpContentBlock,
  AcpKeepAlive,
  AcpLiveSession,
  AcpPermissionOutcome,
  AcpPermissionSteerer,
  AcpSessionPolicy,
  AcpTurnResult,
  Context,
  ContextData,
  ContextLayer,
  FunctionCallItem,
  Item,
  LLMResponse,
  StepAcpAgent,
  StepMeta,
} from '@noetic-tools/types';
import {
  createMessage,
  extractAssistantText,
  frameworkCast,
  NoeticConfigError,
  NoeticErrorImpl,
  SteeringAction,
} from '@noetic-tools/types';
import type { AcpSessionStore } from '../harness/acp-session-store';
import { AcpEventBridge } from './acp-events';
import { withHistoryPrompt } from './acp-history';
import { resolveLazy } from './execute-action';
import { trackUsage } from './message-helpers';
import { parseStructuredOutput } from './structured-output';
import { isContextImpl, isFunctionCall, isMutableContext } from './typeguards';

//#region Types

/**
 * The cross-step session store, hung off the concrete `AgentHarness` and
 * reached via `frameworkCast`, mirroring how the interpreter reaches
 * `layerStateStore`.
 */
//#endregion

//#region Helpers

function sessionStore(ctx: Context<ContextData>): AcpSessionStore {
  return frameworkCast<{
    acpSessions: AcpSessionStore;
  }>(ctx.harness).acpSessions;
}

/**
 * The root of the context chain. Run-scoped sessions are filed under it so
 * concurrent runs on one harness cannot see or tear down each other's agents.
 */
function rootContextId(ctx: Context<ContextData>): string {
  let current: Context<ContextData> = ctx;
  while (current.parent) {
    current = frameworkCast<Context<ContextData>>(current.parent);
  }
  return current.id;
}

function abortSignalOf(ctx: Context<ContextData>): AbortSignal | undefined {
  return isContextImpl(ctx) ? ctx.abortSignal : undefined;
}

async function resolveAgent<TContext, I, O>(
  step: StepAcpAgent<TContext, I, O>,
  ctx: Context<TContext>,
): Promise<AcpAgent> {
  const resolved = await resolveLazy(step.agent, ctx);
  if (!resolved) {
    throw new NoeticConfigError({
      code: 'MISSING_ACP_AGENT',
      message: `step.acpAgent(${JSON.stringify(step.id)}) resolved no agent adapter.`,
      hint: 'Pass an agent factory result, e.g. agent: claudeCode() from @noetic-tools/acp.',
    });
  }
  return resolved;
}

/**
 * Build the turn's prompt content. Plain text comes first (seeded with the
 * conversation so far on a fresh session), then any explicit content blocks.
 */
function buildContent(opts: {
  text: string;
  blocks?: ReadonlyArray<AcpContentBlock>;
}): AcpContentBlock[] {
  const content: AcpContentBlock[] = [];
  if (opts.text.length > 0) {
    content.push({
      type: 'text',
      text: opts.text,
    });
  }
  if (opts.blocks) {
    content.push(...opts.blocks);
  }
  return content;
}

function toLlmResponse(result: AcpTurnResult): LLMResponse {
  return {
    items: result.items,
    usage: {
      inputTokens: result.usage?.input ?? 0,
      outputTokens: result.usage?.output ?? 0,
      cachedTokens: result.usage?.cached,
    },
    cost: result.cost,
  };
}

function applyTurnResult(ctx: Context<ContextData>, result: AcpTurnResult): void {
  const toolCalls: FunctionCallItem[] = [];
  for (const item of result.items) {
    ctx.itemLog.append(item);
    if (isFunctionCall(item)) {
      toolCalls.push(item);
    }
  }

  const llmResponse = toLlmResponse(result);
  trackUsage(ctx, llmResponse);

  const meta: StepMeta = {
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: result.usage ? llmResponse.usage : undefined,
    cost: result.cost,
    responseItems: result.items,
  };
  if (isMutableContext(ctx)) {
    ctx.lastStepMeta = meta;
  }
}

/**
 * Turn a stop reason into the step's outcome. A refusal and a cancellation are
 * genuine failures with dedicated error kinds; a token or turn cap is a normal
 * return whose reason is recorded on `lastStepMeta` for the caller to inspect.
 */
function assertTurnSucceeded(
  stepId: string,
  result: AcpTurnResult,
  ctx: Context<ContextData>,
): void {
  if (result.stopReason === 'cancelled') {
    throw new NoeticErrorImpl({
      kind: 'cancelled',
      reason: ctx.abortReason ?? 'the ACP agent reported a cancelled turn',
    });
  }
  if (result.stopReason === 'refusal') {
    throw new NoeticErrorImpl({
      kind: 'model_refused',
      stepId,
      refusal: result.text.length > 0 ? result.text : 'the ACP agent refused to continue',
    });
  }
}

//#endregion

//#region Client host

/**
 * Bridge the agent's permission requests into the steering pipeline.
 *
 * Steering is a **veto** tier: `beforeToolCall` returns `allow` both when a rule
 * explicitly permits the call *and* when no steering hook exists at all, so
 * treating `allow` as decisive would silently grant every permission. Only a
 * non-allow decision is acted on; anything else abstains and the next tier
 * (the step's handler, then the policy default) decides.
 */
function buildSteerer(
  ctx: Context<ContextData>,
  layers: ContextLayer[] | undefined,
): AcpPermissionSteerer | undefined {
  if (!layers || layers.length === 0) {
    return undefined;
  }
  return async (request): Promise<AcpPermissionOutcome | undefined> => {
    const decision = await ctx.harness.beforeToolCall(
      layers,
      request.toolCall.title ?? request.toolCall.toolCallId,
      request.toolCall.rawInput,
      ctx,
    );
    if (decision.action === SteeringAction.Allow) {
      return undefined;
    }
    return {
      decision: 'deny',
      reason: decision.guidance ?? `steering ${decision.action}`,
    };
  };
}

interface HostBindingOptions<TContext, I, O> {
  step: StepAcpAgent<TContext, I, O>;
  ctx: Context<ContextData>;
  /** `agentId` of the adapter taking the turn, surfaced to permission handlers. */
  agentId: string;
  /** Sink for the agent's `fs/*` and `terminal/*` calls. */
  onActivity: NonNullable<AcpClientHost['onClientActivity']>;
  layers?: ContextLayer[];
  onUpdate: AcpClientHost['onSessionUpdate'];
}

/**
 * Point an existing host at the step that is about to take a turn.
 *
 * A connection outlives the step that opened it, so everything per-turn —
 * permissions, steering, the async handler, the event sink — must be rebound
 * before each turn. Without this, a session shared by several steps answers
 * every later step with the FIRST step's policy and streams its output to the
 * first step's (already finalized) event bridge.
 */
function bindHostToStep<TContext, I, O>(
  host: AcpClientHost,
  opts: HostBindingOptions<TContext, I, O>,
): void {
  host.permissions = opts.step.permissions;
  host.steerPermission = buildSteerer(opts.ctx, opts.layers);
  // Bind the executing context into the handler so the protocol client never
  // has to know about `Context` — it just asks a question and gets an answer.
  const handler = opts.step.onPermissionRequest;
  host.onPermissionRequest = handler
    ? (request) =>
        handler(request, opts.ctx, {
          agentId: opts.agentId,
          stepId: opts.step.id,
        })
    : undefined;
  host.onSessionUpdate = opts.onUpdate;
  host.onClientActivity = opts.onActivity;
}

function buildHost<TContext, I, O>(
  opts: HostBindingOptions<TContext, I, O> & {
    cwd: string;
  },
): AcpClientHost {
  const host: AcpClientHost = {
    cwd: opts.cwd,
    fs: opts.ctx.fs,
    shell: opts.ctx.shell,
    threadId: opts.ctx.threadId,
    signal: abortSignalOf(opts.ctx),
    // Connection-level: ACP negotiates the capability set once, in `initialize`.
    capabilities: opts.step.clientCapabilities,
    onSessionUpdate: opts.onUpdate,
    onClientActivity: opts.onActivity,
  };
  bindHostToStep(host, opts);
  return host;
}

/**
 * `clientCapabilities` is negotiated once per connection, so a step joining an
 * existing session cannot change it. Silently ignoring the request would hand
 * back a session with different permissions than the step asked for, so this
 * is a configuration error instead.
 */
function assertCapabilitiesCompatible<TContext, I, O>(
  step: StepAcpAgent<TContext, I, O>,
  live: AcpLiveSession,
): void {
  const requested = step.clientCapabilities;
  if (requested === undefined) {
    return;
  }
  const current = live.host.capabilities;
  if (JSON.stringify(requested) === JSON.stringify(current ?? {})) {
    return;
  }
  throw new NoeticConfigError({
    code: 'ACP_SESSION_CAPABILITY_CONFLICT',
    message: `step.acpAgent(${JSON.stringify(step.id)}) reuses session '${step.session?.reuse}' but requests different clientCapabilities than the connection was opened with.`,
    hint: 'ACP negotiates client capabilities once per connection. Give every step sharing a `session.reuse` key the same `clientCapabilities`, or use a separate session.',
  });
}

//#endregion

//#region Session lifecycle

/** Keeping a connection is always explicit; the default closes it with the step. */
function keepAliveOf(policy: AcpSessionPolicy | undefined): AcpKeepAlive {
  return policy?.keepAlive ?? 'step';
}

/**
 * Sharing a connection only means something if the connection outlives the
 * step. Rather than silently upgrading the scope, say so — the step is asking
 * for two different things and has only named one.
 */
function assertReuseIsKeptAlive<TContext, I, O>(step: StepAcpAgent<TContext, I, O>): void {
  const policy = step.session;
  if (!policy?.reuse || keepAliveOf(policy) !== 'step') {
    return;
  }
  throw new NoeticConfigError({
    code: 'ACP_REUSE_WITHOUT_KEEPALIVE',
    message: `step.acpAgent(${JSON.stringify(step.id)}) sets session.reuse '${policy.reuse}' but leaves keepAlive at 'step', so the connection closes before any other step can share it.`,
    hint: "Add `keepAlive: 'run'` to share the connection for the rest of the run, or `keepAlive: 'harness'` to keep it past the run and close it yourself with `harness.closeAcpSessions()`.",
  });
}

interface SessionResolution {
  live: AcpLiveSession;
  /** Handle the session is filed under in the harness store. */
  key: string;
  keepAlive: AcpKeepAlive;
  /** True when this step opened the connection rather than reusing one. */
  fresh: boolean;
}

async function openSession<TContext, I, O>(opts: {
  step: StepAcpAgent<TContext, I, O>;
  agent: AcpAgent;
  ctx: Context<TContext>;
  baseCtx: Context<ContextData>;
  cwd: string;
  host: AcpClientHost;
  /** Per-turn host binding, reapplied when an existing session is reused. */
  binding: HostBindingOptions<TContext, I, O>;
  /** MCP servers for the session, already resolved from the step. */
  servers?: Parameters<AcpAgentConnection['newSession']>[0]['mcpServers'];
}): Promise<SessionResolution> {
  const store = sessionStore(opts.baseCtx);
  const keepAlive = keepAliveOf(opts.step.session);
  const reuseKey = opts.step.session?.reuse;
  const parts = {
    keepAlive,
    rootId: rootContextId(opts.baseCtx),
    reuseKey,
  };
  // Registered under a key even without `session.reuse`: anything kept past
  // its step has to be reachable, or nothing can ever close it.
  const key = store.keyFor(parts);

  const { live, fresh } = await store.acquire(key, parts, async () => {
    const connection = await opts.agent.connect({
      host: opts.host,
      signal: abortSignalOf(opts.baseCtx),
    });

    // From here on the connection owns a live agent (usually a child process).
    // Anything that throws before the caller can take responsibility for it
    // must close it first — otherwise the agent outlives the step and, because
    // its stdio keeps the event loop alive, the host never exits.
    try {
      const loadId = opts.step.session?.load;
      const session = loadId
        ? await connection.loadSession({
            sessionId: loadId,
            cwd: opts.cwd,
            mcpServers: opts.servers,
          })
        : await connection.newSession({
            cwd: opts.cwd,
            mcpServers: opts.servers,
          });
      return {
        connection,
        session,
        host: opts.host,
        agentId: opts.agent.agentId,
        keepAlive,
      };
    } catch (e) {
      await connection.close().catch(() => undefined);
      throw e;
    }
  });

  if (!fresh) {
    if (live.agentId !== opts.agent.agentId) {
      throw new NoeticConfigError({
        code: 'ACP_SESSION_AGENT_CONFLICT',
        message: `step.acpAgent(${JSON.stringify(opts.step.id)}) reuses session '${reuseKey}', which was opened by the '${live.agentId}' agent, with a '${opts.agent.agentId}' agent.`,
        hint: 'A reused session is one live connection to one agent. Give every step sharing a `session.reuse` key the same agent, or use separate keys.',
      });
    }
    assertCapabilitiesCompatible(opts.step, live);
    // Point the existing connection at THIS step before it takes a turn.
    bindHostToStep(live.host, opts.binding);
  }

  return {
    live,
    key,
    keepAlive,
    fresh,
  };
}

/**
 * Tear the connection down per policy. Nothing is kept unless the step asked
 * for it: only `keepAlive: 'run' | 'harness'` survives the step, and the run
 * scope is collected by the harness when the root run finishes.
 */
async function finalizeSession(
  resolution: SessionResolution,
  baseCtx: Context<ContextData>,
): Promise<void> {
  if (resolution.keepAlive !== 'step') {
    return;
  }
  // Teardown must not fail a turn whose work already landed in the item log —
  // the stdio transport throws from `close()` if the child ever errored.
  await resolution.live.connection.close().catch(() => undefined);
  sessionStore(baseCtx).forget(resolution.key);
}

//#endregion

//#region Public API

export async function executeAcpAgent<TContext, I, O>(
  step: StepAcpAgent<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
  layers?: ContextLayer[],
): Promise<O> {
  const baseCtx = frameworkCast<Context<ContextData>>(ctx);

  assertReuseIsKeptAlive(step);

  const agent = await resolveAgent(step, ctx);
  const resolvedPrompt = await resolveLazy(step.prompt, ctx);
  const blocks = await resolveLazy(step.content, ctx);
  const promptText =
    resolvedPrompt && resolvedPrompt.length > 0
      ? resolvedPrompt
      : typeof input === 'string'
        ? input
        : '';
  if (promptText.trim() === '' && (!blocks || blocks.length === 0)) {
    throw new NoeticConfigError({
      code: 'MISSING_PROMPT',
      message: `step.acpAgent(${JSON.stringify(step.id)}) resolved an empty prompt.`,
      hint: 'Provide a non-empty `prompt` or `content`, or pass a string input to the step.',
    });
  }

  const cwd = (await resolveLazy(step.cwd, ctx)) ?? baseCtx.cwdState.cwd;
  const servers = await resolveLazy(step.mcpServers, ctx);

  // Capture the conversation so far BEFORE appending this turn's prompt, so a
  // fresh session can be seeded with it and the agent is not left guessing at
  // what earlier steps established.
  const priorHistory: Item[] = [
    ...baseCtx.itemLog.items,
  ];
  if (promptText.length > 0) {
    baseCtx.itemLog.append(createMessage(promptText, 'user'));
  }

  const bridge = new AcpEventBridge(step, agent.agentId, baseCtx);
  const binding = {
    step,
    ctx: baseCtx,
    agentId: agent.agentId,
    layers,
    onUpdate: (notification: Parameters<AcpClientHost['onSessionUpdate']>[0]) => {
      bridge.forward(notification);
    },
    onActivity: (activity: AcpClientActivity) => {
      bridge.forwardActivity(activity);
    },
  };
  const host = buildHost({
    ...binding,
    cwd,
  });

  const resolution = await openSession({
    step,
    agent,
    ctx,
    baseCtx,
    cwd,
    host,
    binding,
    servers: servers
      ? [
          ...servers,
        ]
      : undefined,
  });

  // Mode/model selection is part of setting the turn up, so a failure here is
  // torn down exactly like a failed turn — a fresh connection must not be left
  // holding a live agent.
  try {
    const mode = await resolveLazy(step.mode, ctx);
    if (mode) {
      await resolution.live.session.setMode(mode);
    }
    const model = await resolveLazy(step.model, ctx);
    if (model) {
      await resolution.live.session.setModel(model);
    }
  } catch (e) {
    if (resolution.fresh) {
      await resolution.live.connection.close().catch(() => undefined);
      sessionStore(baseCtx).forget(resolution.key);
    }
    throw e;
  }

  bridge.begin();

  let result: AcpTurnResult;
  try {
    result = await resolution.live.session.prompt({
      content: buildContent({
        // History seeds only a freshly opened session; a reused one already
        // owns its conversation on the agent side.
        text: resolution.fresh
          ? withHistoryPrompt({
              prompt: promptText,
              history: priorHistory,
            })
          : promptText,
        blocks,
      }),
      // Per-turn signal, so a session reused across turns is cancelled by the
      // context running the CURRENT turn rather than the one that opened it.
      signal: abortSignalOf(baseCtx),
    });
  } catch (e) {
    // Best-effort teardown of a fresh connection before surfacing the failure;
    // a reused one is left intact for a later step to retry against.
    if (resolution.fresh) {
      await resolution.live.connection.close().catch(() => undefined);
      sessionStore(baseCtx).forget(resolution.key);
    }
    if (e instanceof NoeticErrorImpl) {
      throw e;
    }
    if (baseCtx.aborted) {
      throw new NoeticErrorImpl({
        kind: 'cancelled',
        reason: baseCtx.abortReason ?? 'context aborted',
      });
    }
    throw new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: step.id,
      cause: e instanceof Error ? e : new Error(String(e)),
      retriesExhausted: false,
    });
  }

  bridge.finalize(result);
  applyTurnResult(baseCtx, result);
  await finalizeSession(resolution, baseCtx);
  assertTurnSucceeded(step.id, result, baseCtx);

  const lastText = result.text.length > 0 ? result.text : extractAssistantText(result.items);

  if (step.output) {
    return parseStructuredOutput<O>({
      schema: step.output,
      rawText: lastText,
      stepId: step.id,
    });
  }

  return frameworkCast<O>(lastText);
}

//#endregion
