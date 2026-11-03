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
  AcpClientCapabilityConfig,
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
import { assertAgentTakesTools } from '../builders/acp-agent-checks';
import { runtimeOf } from '../connections/model-tools';
import type { AcpSessionStore } from '../runtime/acp-session-store';
import { AcpEventBridge } from './acp-events';
import { withHistoryPrompt } from './acp-history';
import { renderLayerContext } from './acp-layers';
import { AcpToolRunner, mergeBridgedItems, resolveAcpTools } from './acp-tools';
import { appendUserInput, MAX_STEERING_RETRIES, resolveLazy } from './execute-action';
import { trackUsage } from './message-helpers';
import { parseStructuredOutput } from './structured-output';
import { isContextImpl, isFunctionCall, isMutableContext } from './typeguards';

//#region Helpers

/**
 * The cross-step session store, hung off the concrete `AgentHarness` and
 * reached via `frameworkCast`, mirroring how the interpreter reaches
 * `layerStateStore`.
 */
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
    acpStopReason: result.stopReason,
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
      request.toolCall.toolCallId,
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
  /** The step's tools, served to the agent; `undefined` when it gave none. */
  tools?: AcpToolRunner;
  events: AcpEventBridge;
  /** Fail the turn when the tool pipeline itself throws. */
  failTurn: (error: unknown) => void;
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
  // A step that gives no tools gets none, even on a session another step
  // opened with tools. The session's runner stays listed, so the agent's
  // permission requests are still recognized, but its calls answer as unknown
  // tools.
  if (!opts.tools) {
    if (host.tools instanceof AcpToolRunner) {
      host.tools.unbind();
    }
    return;
  }
  host.tools = opts.tools;
  opts.tools.bind({
    stepId: opts.step.id,
    ctx: opts.ctx,
    layers: opts.layers,
    events: opts.events,
    fail: opts.failTurn,
  });
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
 * The capability set as the wire sees it, so two spellings of the same policy
 * compare equal. Matches the defaults `clientCapabilitiesFor` applies in the
 * protocol client — an omitted field and an explicitly-`true` one are the same
 * request, and field order is not a difference at all.
 */
function normalizedCapabilities(config: AcpClientCapabilityConfig | undefined): string {
  return JSON.stringify({
    readTextFile: config?.readTextFile !== false,
    writeTextFile: config?.writeTextFile !== false,
    terminal: config?.terminal !== false,
    allowAnyPath: config?.allowAnyPath === true,
    additionalDirectories: [
      ...(config?.additionalDirectories ?? []),
    ].sort(),
  });
}

/**
 * `cwd` and the served tools are fixed when the session is created, so a step
 * joining an existing one cannot change them either. Connection-scoped
 * settings all fail the same way: a mismatch throws rather than being dropped.
 */
function assertSessionScopedSettingsMatch<TContext, I, O>(
  step: StepAcpAgent<TContext, I, O>,
  live: AcpLiveSession,
  cwd: string,
  tools: AcpToolRunner | undefined,
): void {
  const conflict = (setting: string, hint: string): NoeticConfigError =>
    new NoeticConfigError({
      code: 'ACP_SESSION_SETTING_CONFLICT',
      message: `step.acpAgent(${JSON.stringify(step.id)}) reuses session '${step.session?.reuse}' but requests a different ${setting} than the session was created with.`,
      hint,
    });

  if (cwd !== live.cwd) {
    throw conflict(
      'cwd',
      'A session is created in one working directory. Give every step sharing a `session.reuse` key the same `cwd`, or use a separate session.',
    );
  }
  // The agent reads its tool list once, so a step may serve any part of it —
  // a call to a tool outside its part answers as unknown, as on `callModel` —
  // but nothing the list lacks.
  const listed = new Map(
    (live.tools ?? []).map((tool) => [
      tool.name,
      JSON.stringify(tool),
    ]),
  );
  const unlisted = (tools?.tools ?? [])
    .filter((tool) => listed.get(tool.name) !== JSON.stringify(tool))
    .map((tool) => tool.name);
  if (unlisted.length > 0) {
    throw conflict(
      `set of tools (${unlisted.join(', ')} ${unlisted.length === 1 ? 'is' : 'are'} not in the session's tool list, or differ)`,
      'The agent reads its tool list once, when the session is created. Give the step that opens a `session.reuse` session every tool a later step will serve, or use a separate session.',
    );
  }
}

/**
 * `clientCapabilities` is negotiated once per connection, so a step joining an
 * existing session cannot change it. Silently ignoring the request would hand
 * back a session with different permissions than the step asked for, so this
 * is a configuration error instead.
 *
 * Compared field by field after normalisation: comparing raw JSON made
 * `{a,b}` conflict with `{b,a}`, and an omitted capability conflict with the
 * default it resolves to — telling an author to make two identical policies
 * identical.
 */
function assertCapabilitiesCompatible<TContext, I, O>(
  step: StepAcpAgent<TContext, I, O>,
  live: AcpLiveSession,
): void {
  const requested = step.clientCapabilities;
  if (requested === undefined) {
    return;
  }
  if (normalizedCapabilities(requested) === normalizedCapabilities(live.host.capabilities)) {
    return;
  }
  throw new NoeticConfigError({
    code: 'ACP_SESSION_CAPABILITY_CONFLICT',
    message: `step.acpAgent(${JSON.stringify(step.id)}) reuses session '${step.session?.reuse}' but requests different clientCapabilities than the connection was opened with.`,
    hint: 'ACP negotiates client capabilities once per connection. Give every step sharing a `session.reuse` key the same `clientCapabilities`, or use a separate session.',
  });
}

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
  baseCtx: Context<ContextData>;
  cwd: string;
  host: AcpClientHost;
  /** Per-turn host binding, reapplied when an existing session is reused. */
  binding: HostBindingOptions<TContext, I, O>;
  tools?: AcpToolRunner;
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
    const connection = holdingConnections(
      await opts.agent.connect({
        host: opts.host,
        signal: abortSignalOf(opts.baseCtx),
      }),
      opts.baseCtx,
      keepAlive,
    );

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
          })
        : await connection.newSession({
            cwd: opts.cwd,
          });
      return {
        connection,
        session,
        host: opts.host,
        agentId: opts.agent.agentId,
        keepAlive,
        cwd: opts.cwd,
        tools: opts.tools?.tools,
      };
    } catch (e) {
      await connection.close().catch(() => undefined);
      throw e;
    }
  });

  if (!fresh) {
    assertSessionScopedSettingsMatch(opts.step, live, opts.cwd, opts.tools);
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
 * A connection kept past its step holds the turn's connections until it
 * closes: its agent may still call tools of entries the turn attached, which
 * would otherwise be released when the turn ends.
 */
function holdingConnections(
  connection: AcpAgentConnection,
  ctx: Context<ContextData>,
  keepAlive: AcpKeepAlive,
): AcpAgentConnection {
  const registry = runtimeOf(ctx.harness);
  if (keepAlive === 'step' || !registry) {
    return connection;
  }
  const release = registry.hold(rootContextId(ctx));
  const close = connection.close.bind(connection);
  return Object.assign(connection, {
    async close(): Promise<void> {
      try {
        await close();
      } finally {
        release();
      }
    },
  });
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

/**
 * Release a connection this step opened, before surfacing a failure. A reused
 * one is left intact for a later step to retry against.
 */
async function discardIfFresh(
  resolution: SessionResolution,
  baseCtx: Context<ContextData>,
): Promise<void> {
  if (!resolution.fresh) {
    return;
  }
  await resolution.live.connection.close().catch(() => undefined);
  sessionStore(baseCtx).forget(resolution.key);
}

/**
 * Apply the step's mode and model before its turn. Part of setting the turn up,
 * so a failure tears down exactly like a failed turn rather than leaving a
 * fresh connection holding a live agent.
 */
async function applySessionSelection<TContext, I, O>(
  step: StepAcpAgent<TContext, I, O>,
  ctx: Context<TContext>,
  resolution: SessionResolution,
  baseCtx: Context<ContextData>,
): Promise<void> {
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
    await discardIfFresh(resolution, baseCtx);
    throw e;
  }
}

/** Turn a failed turn into the step's typed error, after closing the bracket. */
function turnFailure(
  step: {
    id: string;
  },
  cause: unknown,
  baseCtx: Context<ContextData>,
): NoeticErrorImpl {
  if (cause instanceof NoeticErrorImpl) {
    return cause;
  }
  if (baseCtx.aborted) {
    return new NoeticErrorImpl({
      kind: 'cancelled',
      reason: baseCtx.abortReason ?? 'context aborted',
    });
  }
  return new NoeticErrorImpl({
    kind: 'step_failed',
    stepId: step.id,
    cause: cause instanceof Error ? cause : new Error(describeCause(cause)),
    retriesExhausted: false,
  });
}

/** A readable message for a thrown non-Error, such as a JSON-RPC error object. */
function describeCause(cause: unknown): string {
  if (typeof cause !== 'object' || cause === null) {
    return String(cause);
  }
  const message = Reflect.get(cause, 'message');
  const data = Reflect.get(cause, 'data');
  const head = typeof message === 'string' ? message : JSON.stringify(cause);
  return data === undefined ? head : `${head}: ${JSON.stringify(data)}`;
}

//#region Turn

interface TurnError {
  error?: unknown;
  cancel?: () => Promise<void>;
}

/**
 * The tools the agent is served. No `tools` offers every tool the run has,
 * as on `callModel`, and an agent that cannot take tools then simply gets
 * none; tools given explicitly to such an agent are a configuration error.
 */
async function resolveServedTools<TContext, I, O>(
  step: StepAcpAgent<TContext, I, O>,
  ctx: Context<TContext>,
  layers: ContextLayer[] | undefined,
  agent: AcpAgent,
): Promise<AcpToolRunner | undefined> {
  const given = gives(step.tools);
  if (given) {
    assertAgentTakesTools(step.id, agent);
  }
  const tools = await resolveAcpTools(step, ctx, layers);
  if (given || agent.refusesTools === undefined) {
    return tools;
  }
  return undefined;
}

/** Whether a step setting may name anything: a getter, or a non-empty array. */
function gives(setting: unknown): boolean {
  return typeof setting === 'function' || (Array.isArray(setting) && setting.length > 0);
}

/**
 * One agent turn: prompt, wait for every bridged call the turn started, and
 * fold the bridge's records into the turn's items.
 */
async function runTurn<TContext, I, O>(params: {
  step: StepAcpAgent<TContext, I, O>;
  baseCtx: Context<ContextData>;
  resolution: SessionResolution;
  bridge: AcpEventBridge;
  tools: AcpToolRunner | undefined;
  turnError: TurnError;
  content: AcpContentBlock[];
}): Promise<AcpTurnResult> {
  const { step, baseCtx, resolution, bridge, tools, turnError } = params;
  if (tools) {
    bridge.nameToolCalls((title: string) => tools.wireNameOf(title));
  }
  bridge.begin();
  let result: AcpTurnResult;
  try {
    result = await resolution.live.session.prompt({
      content: params.content,
      // Per-turn signal, so a session reused across turns is cancelled by the
      // context running the CURRENT turn rather than the one that opened it.
      signal: abortSignalOf(baseCtx),
    });
  } catch (e) {
    await settle(tools);
    // Close the turn on the event surface before rethrowing. A consumer driving
    // a UI off `getFullStream()` saw `response.created` and would otherwise
    // wait forever for a completion that never comes — the stream just stops.
    bridge.abort(e);
    await discardIfFresh(resolution, baseCtx);
    throw turnFailure(step, turnError.error ?? e, baseCtx);
  }
  await settle(tools);
  if (turnError.error !== undefined) {
    bridge.abort(turnError.error);
    await discardIfFresh(resolution, baseCtx);
    throw turnFailure(step, turnError.error, baseCtx);
  }
  if (tools) {
    const merged = mergeBridgedItems(result.items, tools.takeFinished());
    bridge.adoptToolCalls(merged.adopted);
    result = {
      ...result,
      items: merged.items,
    };
  }
  bridge.finalize(result);
  return result;
}

/** Let every bridged call the turn started finish, then stop taking calls. */
async function settle(tools: AcpToolRunner | undefined): Promise<void> {
  if (!tools) {
    return;
  }
  await tools.idle();
  tools.unbind();
}

async function stepOutput<TContext, I, O>(
  step: StepAcpAgent<TContext, I, O>,
  result: AcpTurnResult,
): Promise<O> {
  const lastText = result.text.trim().length > 0 ? result.text : extractAssistantText(result.items);
  if (step.output) {
    return await parseStructuredOutput<O>({
      schema: step.output,
      rawText: lastText,
      stepId: step.id,
    });
  }
  return frameworkCast<O>(lastText);
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
  const tools = await resolveServedTools(step, ctx, layers, agent);

  // Capture the conversation so far BEFORE appending this turn's prompt, so a
  // fresh session can be seeded with it and the agent is not left guessing at
  // what earlier steps established.
  const priorHistory: Item[] = [
    ...baseCtx.itemLog.items,
  ];
  // Through the layers' append pipeline, as `callModel` adds its input.
  let rerenderRequests = await appendUserInput({
    ctx: baseCtx,
    layers,
    input: promptText,
  });

  let bridge = new AcpEventBridge(step, agent.agentId, baseCtx);
  // A tool pipeline error fails the step, as it does in `callModel`: it is
  // kept, the agent's turn is cancelled, and the error is thrown once the
  // turn has unwound.
  const turnError: TurnError = {};
  const bindingFor = (events: AcpEventBridge): HostBindingOptions<TContext, I, O> => ({
    step,
    ctx: baseCtx,
    agentId: agent.agentId,
    layers,
    onUpdate: (notification) => {
      tools?.observe(notification.update);
      events.forward(notification);
    },
    onActivity: (activity: AcpClientActivity) => {
      events.forwardActivity(activity);
    },
    tools,
    events,
    failTurn: (error: unknown) => {
      if (turnError.error !== undefined) {
        return;
      }
      turnError.error = error;
      void turnError.cancel?.().catch(() => undefined);
    },
  });
  const host = buildHost({
    ...bindingFor(bridge),
    cwd,
  });

  const resolution = await openSession({
    step,
    agent,
    baseCtx,
    cwd,
    host,
    binding: bindingFor(bridge),
    tools,
  });

  await applySessionSelection(step, ctx, resolution, baseCtx);
  turnError.cancel = () => resolution.live.session.cancel();

  // History seeds only a freshly opened session; a reused one already owns
  // its conversation on the agent side.
  let turnPrompt = resolution.fresh
    ? withHistoryPrompt({
        prompt: promptText,
        history: priorHistory,
      })
    : promptText;
  let turnBlocks = blocks;
  let retries = 0;
  for (;;) {
    // Recall runs before every turn, as before every model call; its output
    // leads the prompt.
    const context = await renderLayerContext({
      ctx: baseCtx,
      layers,
      query: promptText,
      rerenderRequests,
    });
    rerenderRequests = [];
    const result = await runTurn({
      step,
      baseCtx,
      resolution,
      bridge,
      tools,
      turnError,
      content: buildContent({
        text: [
          context,
          turnPrompt,
        ]
          .filter((part) => part.length > 0)
          .join('\n\n'),
        blocks: turnBlocks,
      }),
    });
    applyTurnResult(baseCtx, result);
    try {
      assertTurnSucceeded(step.id, result, baseCtx);
    } catch (e) {
      await finalizeSession(resolution, baseCtx);
      throw e;
    }

    const response = toLlmResponse(result);
    const decision =
      layers && layers.length > 0
        ? await baseCtx.harness.afterModelCall(layers, response, baseCtx)
        : undefined;
    if (decision?.action === SteeringAction.Deny) {
      await finalizeSession(resolution, baseCtx);
      throw new NoeticErrorImpl({
        kind: 'steering_denied',
        guidance: decision.guidance,
      });
    }
    // A layer asking for a better answer gets another turn carrying its
    // guidance, as a `callModel` step retries its call. The agent keeps its
    // first answer in its own history, so it stays in the log as well.
    if (decision?.action === SteeringAction.Guide && retries < MAX_STEERING_RETRIES) {
      const guidance = decision.guidance ?? 'Please adjust your response.';
      baseCtx.itemLog.append(createMessage(guidance, 'developer'));
      turnPrompt = guidance;
      turnBlocks = undefined;
      retries += 1;
      bridge = new AcpEventBridge(step, agent.agentId, baseCtx);
      bindHostToStep(resolution.live.host, bindingFor(bridge));
      continue;
    }
    if (layers && layers.length > 0) {
      await baseCtx.harness.storeLayers(layers, response, baseCtx);
    }
    await finalizeSession(resolution, baseCtx);
    return await stepOutput(step, result);
  }
}

//#endregion
