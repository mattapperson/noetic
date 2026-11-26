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
  AcpConnectOptions,
  AcpContentBlock,
  AcpCreateElicitationRequest,
  AcpKeepAlive,
  AcpNewSessionOptions,
  AcpPermissionOutcome,
  AcpPermissionSteerer,
  AcpReattachHandle,
  AcpSession,
  AcpSessionPolicy,
  AcpTurnResult,
  AcpWhenHostExits,
  Context,
  ContextData,
  ContextLayer,
  Item,
  LLMResponse,
  RoundUsage,
  StepAcpAgent,
  StepMeta,
} from '@noetic-tools/types';
import {
  createMessage,
  extractAssistantText,
  frameworkCast,
  isAcpCapabilityError,
  isAcpConnectError,
  NoeticConfigError,
  NoeticErrorImpl,
  SteeringAction,
} from '@noetic-tools/types';
import { assertAgentTakesTools } from '../builders/acp-agent-checks';
import { runtimeOf } from '../connections/model-tools';
import type { AcpLiveSession, AcpSessionStore } from '../runtime/acp-session-store';
import { acpSessionsOf } from '../runtime/acp-session-store';
import { awaitApproval } from '../runtime/tool-approval';
import { isRpcError, RpcFailure } from '../util/error-message';
import { modelOf } from './acp-activity';
import { AcpEventBridge } from './acp-events';
import { withHistoryPrompt } from './acp-history';
import { renderLayerContext } from './acp-layers';
import type { QuestionAsker } from './acp-questions';
import { questionAsker } from './acp-questions';
import { ACP_RESUME_NOTICE, acpSessionRecords } from './acp-resume';
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
  return acpSessionsOf(ctx.harness);
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

/**
 * The turn's tokens as a model round reports them, from the adapter. What the
 * agent's `session/prompt` answer reports is the session's running total, not
 * the turn's, so it is never charged.
 */
function turnUsage(result: AcpTurnResult): RoundUsage | undefined {
  if (!result.usage) {
    return undefined;
  }
  return {
    inputTokens: result.usage.input,
    outputTokens: result.usage.output,
    cachedTokens: result.usage.cached,
  };
}

/** The turn as a model call's response, for usage accounting and `afterModelCall` layers. */
function toLlmResponse(result: AcpTurnResult): LLMResponse {
  return {
    items: result.items,
    usage: turnUsage(result) ?? {
      inputTokens: 0,
      outputTokens: 0,
    },
    cost: result.cost,
  };
}

/**
 * The model the session runs with: its `model` config option's current value —
 * found as the session finds it to set it, by category, else by id — else the
 * model the step selected.
 */
function currentModel(session: AcpSession, selected: string | undefined): string | undefined {
  return modelOf(session.configOptions) ?? selected;
}

/** Record a turn's items and charge its spend: every attempt, as every model call is. */
function applyTurnResult(ctx: Context<ContextData>, result: AcpTurnResult): void {
  for (const item of result.items) {
    ctx.itemLog.append(item);
  }
  trackUsage(ctx, toLlmResponse(result));
}

/** Publish the accepted turn's metadata, as a `callModel` step does once its outcome is settled. */
function publishStepMeta(
  ctx: Context<ContextData>,
  result: AcpTurnResult,
  model: string | undefined,
): void {
  const toolCalls = result.items.filter(isFunctionCall);
  const stopReason = result.stopReason;
  const meta: StepMeta = {
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: turnUsage(result),
    cost: result.cost,
    responseItems: result.items,
    // Only a turn that returned is accepted: a refusal or a cancellation fails the step.
    ...(stopReason === 'end_turn' ||
    stopReason === 'max_tokens' ||
    stopReason === 'max_turn_requests'
      ? {
          stopReason,
        }
      : {}),
    ...(model === undefined
      ? {}
      : {
          model,
        }),
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

/**
 * The last tier of a permission request: the harness's approval seam (spec 08
 * § Held tool calls). The agent's process is waiting on the answer and its session
 * would not survive the turn stopping, so the turn stays live while the request is
 * held.
 */
function buildApprover(
  ctx: Context<ContextData>,
  events: AcpEventBridge,
): AcpPermissionSteerer | undefined {
  // A harness with no approval seam has none to give.
  if (!ctx.harness.approve) {
    return undefined;
  }
  return async (request): Promise<AcpPermissionOutcome | undefined> => {
    // `harness.approve()` itself, plus who asks: a subagent's request is held
    // as the run's, named as its nested agent's.
    const { decision } = await awaitApproval({
      harness: ctx.harness,
      toolName: request.toolCall.title ?? request.toolCall.toolCallId,
      toolArgs: request.toolCall.rawInput,
      callId: request.toolCall.toolCallId,
      ctx,
      park: false,
      scope: events.scopeFor(request.sessionId),
    });
    if (decision.action === SteeringAction.Allow) {
      return {
        decision: 'allow',
      };
    }
    return {
      decision: 'deny',
      reason: decision.guidance ?? `approval ${decision.action}`,
    };
  };
}

interface HostBindingOptions<TContext, I, O> {
  step: StepAcpAgent<TContext, I, O>;
  ctx: Context<ContextData>;
  /** The step's questions to a person, one asker for the whole step. */
  questions: QuestionAsker;
  /** `agentId` of the adapter taking the turn, surfaced to permission handlers. */
  agentId: string;
  /** Sink for the agent's `fs/*` and `terminal/*` calls. */
  onActivity: NonNullable<AcpClientHost['onClientActivity']>;
  layers?: ContextLayer[];
  onUpdate: AcpClientHost['onSessionUpdate'];
  /** A subagent's traffic: a nested agent of this turn (spec 08 § Nested agents). */
  onChildUpdate: NonNullable<AcpClientHost['onChildUpdate']>;
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
  host.approvePermission = buildApprover(opts.ctx, opts.events);
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
  // An agent's question is a question for a person: held like any other (spec 27
  // § Questions the agent asks), answered by whoever answers held calls.
  host.onElicitation = (request, info) =>
    opts.questions.ask(request, info, opts.events.scopeFor(sessionOfQuestion(request)));
  host.onSessionUpdate = opts.onUpdate;
  host.onChildUpdate = opts.onChildUpdate;
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
    elicitation: config?.elicitation !== false,
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
  settings: SessionSettings,
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
  // Instructions, the adapter's `_meta`, cwd and capabilities as the connection
  // would send them, against what it sent when the session opened.
  const opened = live.fingerprint;
  if (
    opened !== undefined &&
    opened !== live.connection.fingerprintFor(sessionRequest(cwd, settings))
  ) {
    throw conflict(
      'instructions or agent settings',
      'A session takes its instructions and its agent settings when it is created. Give every step sharing a `session.reuse` key the same `instructions` and agent, or use a separate session.',
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

/** What the step opens its session with, beside its cwd. */
interface SessionSettings {
  instructions?: string;
}

async function resolveSessionSettings<TContext, I, O>(
  step: StepAcpAgent<TContext, I, O>,
  ctx: Context<TContext>,
): Promise<SessionSettings> {
  const instructions = await resolveLazy(step.instructions, ctx);
  if (instructions === undefined || instructions.trim().length === 0) {
    return {};
  }
  return {
    instructions,
  };
}

/** The session request for `cwd` and `settings`, as `fingerprintFor` takes it. */
function sessionRequest(cwd: string, settings: SessionSettings): AcpNewSessionOptions {
  return {
    cwd,
    ...settings,
  };
}

/** JSON-RPC "resource not found", which an agent answers a load of a session it no longer has with. */
const RESOURCE_NOT_FOUND = -32002;

/**
 * Whether a failed `session/load` says the agent no longer has the session —
 * the one failure a resumed step starts over from. Anything else may mean the
 * old turn is still there, so the step fails rather than repeat its work.
 */
function sessionIsGone(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  return Reflect.get(error, 'code') === RESOURCE_NOT_FOUND;
}

/** The session a question names, when it names one (form and URL questions do). */
function sessionOfQuestion(request: AcpCreateElicitationRequest): string | undefined {
  const sessionId = Reflect.get(request, 'sessionId');
  return typeof sessionId === 'string' ? sessionId : undefined;
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
    hint: "Add `keepAlive: 'run'` to share the connection for the rest of the run, or `keepAlive: 'harness'` to keep it past the run and close it yourself with `harness.close()`.",
  });
}

interface SessionResolution {
  live: AcpLiveSession;
  /** Handle the session is filed under in the harness store. */
  key: string;
  keepAlive: AcpKeepAlive;
  /** True when this step opened the connection rather than reusing one. */
  fresh: boolean;
  /** True when this step reloaded the session an earlier attempt of it opened. */
  resumed: boolean;
  /**
   * True when it reattached to that session, still live in an agent that
   * outlived the earlier host: the first turn collects the turn that host left
   * running instead of prompting.
   */
  reattached: boolean;
}

/**
 * Open the step's session on a new connection. An earlier attempt's session is
 * reloaded when the agent can; an agent that cannot, or that no longer has the
 * session, gets a new one, and the step starts it over.
 */
async function sessionOn(
  connection: AcpAgentConnection,
  opts: {
    cwd: string;
    /** The session the step names with `session.load`. A failure to load it is an error. */
    loadId?: string;
    /** The session an earlier attempt of this step opened. */
    resumeId?: string;
    settings: SessionSettings;
  },
): Promise<{
  session: AcpSession;
  resumed: boolean;
}> {
  const { cwd, loadId, resumeId, settings } = opts;
  if (loadId) {
    return {
      session: await connection.loadSession({
        sessionId: loadId,
        cwd,
        ...settings,
      }),
      resumed: false,
    };
  }
  if (resumeId !== undefined && connection.agentCapabilities.loadSession === true) {
    const session = await connection
      .loadSession({
        sessionId: resumeId,
        cwd,
        ...settings,
      })
      .catch((error: unknown) => {
        if (sessionIsGone(error)) {
          return undefined;
        }
        throw error;
      });
    if (session) {
      return {
        session,
        resumed: true,
      };
    }
  }
  return {
    session: await connection.newSession({
      cwd,
      ...settings,
    }),
    resumed: false,
  };
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
  /** The session an earlier attempt of this step opened, to reload when the agent can. */
  resumeId?: string;
  /** How to reach the agent that earlier attempt left running, when it can outlive its host. */
  reattach?: AcpReattachHandle;
  /** The fingerprint that earlier attempt's session was opened with. */
  fingerprint?: string;
  settings: SessionSettings;
}): Promise<SessionResolution> {
  let resumed = false;
  let reattached = false;
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
    const connectOptions = {
      host: opts.host,
      signal: abortSignalOf(opts.baseCtx),
      whenHostExits: whenHostExitsOf(opts.baseCtx),
    };
    const kept = await reattachTo(opts.agent, connectOptions, {
      reattach: opts.reattach,
      sessionId: opts.resumeId,
      fingerprint: opts.fingerprint,
      request: sessionRequest(opts.cwd, opts.settings),
      stepId: opts.step.id,
    });
    if (kept) {
      resumed = true;
      reattached = true;
      return {
        connection: holdingConnections(kept.connection, opts.baseCtx, keepAlive),
        session: kept.session,
        host: opts.host,
        agentId: opts.agent.agentId,
        keepAlive,
        cwd: opts.cwd,
        tools: opts.tools?.tools,
        // Checked equal to this step's when it reattached.
        fingerprint: opts.fingerprint,
      };
    }
    const connection = holdingConnections(
      await opts.agent.connect(connectOptions),
      opts.baseCtx,
      keepAlive,
    );

    // From here on the connection owns a live agent (usually a child process).
    // Anything that throws before the caller can take responsibility for it
    // must close it first — otherwise the agent outlives the step and, because
    // its stdio keeps the event loop alive, the host never exits.
    try {
      const opened = await sessionOn(connection, {
        cwd: opts.cwd,
        loadId: opts.step.session?.load,
        resumeId: opts.resumeId,
        settings: opts.settings,
      });
      resumed = opened.resumed;
      const { session } = opened;
      return {
        connection,
        session,
        host: opts.host,
        agentId: opts.agent.agentId,
        keepAlive,
        cwd: opts.cwd,
        tools: opts.tools?.tools,
        fingerprint: session.fingerprint,
      };
    } catch (e) {
      await connection.close().catch(() => undefined);
      throw e;
    }
  });

  if (!fresh) {
    assertSessionScopedSettingsMatch(opts.step, live, opts.cwd, opts.tools, opts.settings);
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
    resumed,
    reattached,
  };
}

/** The harness's choice for agents its process leaves behind. */
function whenHostExitsOf(ctx: Context<ContextData>): AcpWhenHostExits {
  return ctx.harness.config.killAgentsOnExit === true ? 'stop' : 'keep';
}

/**
 * The live session an earlier attempt of the step left in an agent that
 * outlived its host, or undefined when there is none to reach — the agent is
 * gone, or no longer has the session — so the step reloads or starts over.
 */
async function reattachTo(
  agent: AcpAgent,
  connectOptions: AcpConnectOptions,
  opts: {
    reattach: AcpReattachHandle | undefined;
    sessionId: string | undefined;
    /** What the session was opened with, as stored; absent on an older record. */
    fingerprint: string | undefined;
    /** What this step would open it with. */
    request: AcpNewSessionOptions;
    stepId: string;
  },
): Promise<
  | {
      connection: AcpAgentConnection;
      session: AcpSession;
    }
  | undefined
> {
  if (!opts.reattach || opts.sessionId === undefined) {
    return undefined;
  }
  // Only "the agent is gone" starts the step over; any other failure fails it.
  const connection = await agent
    .connect({
      ...connectOptions,
      reattach: opts.reattach,
    })
    .catch(goneOrThrow);
  if (!connection) {
    return undefined;
  }
  try {
    const session = await connection.attachSession?.(opts.sessionId).catch(goneOrThrow);
    if (!session?.resumeTurn) {
      await connection.close().catch(() => undefined);
      return undefined;
    }
    assertSameSettings(opts, connection);
    return {
      connection,
      session,
    };
  } catch (error) {
    // The old turn may still be working: let go of it, never stop it, so a
    // host that resumes with the settings it started with can still take it.
    await letGo(connection);
    throw error;
  }
}

/** Release this host's side of a reattached connection, leaving the agent running. */
async function letGo(connection: AcpAgentConnection): Promise<void> {
  const release = connection.detach ?? connection.close;
  await release.call(connection).catch(() => undefined);
}

/**
 * Undefined when the agent or its session is confirmed gone, the error itself
 * otherwise: a connect failure that says nothing about the agent must not
 * start its work over.
 */
function goneOrThrow(error: unknown): undefined {
  if (isAcpConnectError(error) && error.gone) {
    return undefined;
  }
  throw error;
}

/**
 * A reattached session runs with what it was opened with. A step that would
 * open it differently must not adopt it: the old turn may already have acted on
 * the old instructions.
 */
function assertSameSettings(
  opts: {
    fingerprint: string | undefined;
    request: AcpNewSessionOptions;
    stepId: string;
  },
  connection: AcpAgentConnection,
): void {
  if (
    opts.fingerprint === undefined ||
    opts.fingerprint === connection.fingerprintFor(opts.request)
  ) {
    return;
  }
  throw new NoeticConfigError({
    code: 'ACP_SESSION_SETTING_CONFLICT',
    message: `step.acpAgent(${JSON.stringify(opts.stepId)}) resumes a session that was opened with different instructions or agent settings than the step now gives.`,
    hint: 'A resumed step must resolve the same instructions, cwd and agent settings as the run that started it.',
  });
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
): Promise<string | undefined> {
  try {
    const mode = await resolveLazy(step.mode, ctx);
    if (mode) {
      await resolution.live.session.setMode(mode);
    }
    const model = await resolveLazy(step.model, ctx);
    if (model) {
      await resolution.live.session.setModel(model);
    }
    return model || undefined;
  } catch (e) {
    await discardIfFresh(resolution, baseCtx);
    throw e;
  }
}

/**
 * Whatever went wrong, as a Noetic error (spec 27 § Failures are Noetic errors):
 * a host never sees a protocol error. A missing capability is the workflow's
 * configuration; everything else the agent did, or failed to do, is the step
 * failing, with the agent's own message.
 */
function stepFailure(
  step: {
    id: string;
  },
  cause: unknown,
  baseCtx: Context<ContextData>,
): NoeticErrorImpl | NoeticConfigError {
  if (cause instanceof NoeticErrorImpl || cause instanceof NoeticConfigError) {
    return cause;
  }
  if (isAcpCapabilityError(cause)) {
    return new NoeticConfigError({
      code: 'AGENT_CAPABILITY_MISSING',
      message: `step.acpAgent(${JSON.stringify(step.id)}): ${cause.message}`,
      hint: `The agent does not support '${cause.capability}'. Leave that setting off this step, or use an agent that supports it.`,
    });
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
    // A JSON-RPC rejection keeps its detail (`data`) in the message, so a
    // failure reads "Internal error: Authentication required (-32603)", never
    // "[object Object]" or a bare "Internal error".
    cause: cause instanceof Error && !isRpcError(cause) ? cause : new RpcFailure(cause),
    retriesExhausted: false,
  });
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
  /**
   * Collect the turn an earlier host left running on a reattached session
   * before prompting; prompt only when no turn was running.
   */
  collect?: boolean;
}): Promise<AcpTurnResult> {
  const { step, baseCtx, resolution, bridge, tools, turnError } = params;
  if (tools) {
    bridge.nameToolCalls(
      (title: string) => tools.wireNameOf(title),
      (wireName, input) => tools.identityOf(wireName, input),
    );
  }
  bridge.begin();
  let result: AcpTurnResult;
  try {
    // Per-turn signal, so a session reused across turns is cancelled by the
    // context running the CURRENT turn rather than the one that opened it.
    const signal = abortSignalOf(baseCtx);
    const session = resolution.live.session;
    const collected =
      params.collect && session.resumeTurn
        ? await session.resumeTurn({
            signal,
          })
        : undefined;
    result =
      collected ??
      (await session.prompt({
        content: params.content,
        signal,
      }));
  } catch (e) {
    await settle(tools);
    // What the turn's calls did still reaches the stream, settled to their owners.
    tools?.takeFinished();
    // Close the turn on the event surface before rethrowing. A consumer driving
    // a UI off `getFullStream()` saw `response.created` and would otherwise
    // wait forever for a completion that never comes — the stream just stops.
    // The stream carries the same Noetic error `execute()` throws.
    const failure = stepFailure(step, turnError.error ?? e, baseCtx);
    bridge.abort(failure);
    await discardIfFresh(resolution, baseCtx);
    throw failure;
  }
  await settle(tools);
  if (turnError.error !== undefined) {
    tools?.takeFinished();
    const failure = stepFailure(step, turnError.error, baseCtx);
    bridge.abort(failure);
    await discardIfFresh(resolution, baseCtx);
    throw failure;
  }
  if (tools) {
    const merged = mergeBridgedItems(result.items, tools.takeFinished());
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
  const questions = questionAsker({
    ctx: baseCtx,
    agentId: agent.agentId,
    stepId: step.id,
  });
  // A question's answer is kept until the step ends, so a host that died after
  // taking it and before the agent got it is not asked again (spec 27
  // § Questions the agent asks). A step cut off with its host never gets here.
  try {
    return await runAcpStep({
      step,
      input,
      ctx,
      layers,
      agent,
      questions,
    });
  } finally {
    await questions.release().catch(() => undefined);
  }
}

async function runAcpStep<TContext, I, O>(params: {
  step: StepAcpAgent<TContext, I, O>;
  input: I;
  ctx: Context<TContext>;
  layers: ContextLayer[] | undefined;
  agent: AcpAgent;
  questions: QuestionAsker;
}): Promise<O> {
  const { step, input, ctx, layers, agent, questions } = params;
  const baseCtx = frameworkCast<Context<ContextData>>(ctx);
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
  const settings = await resolveSessionSettings(step, ctx);
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

  // An earlier attempt of this step may have left its session behind.
  const sessions = step.session?.load ? undefined : acpSessionRecords(baseCtx);
  const recorded = await sessions?.load();
  const sameAgent = recorded?.agentId === agent.agentId;
  const resumeId = sameAgent ? recorded?.sessionId : undefined;
  const reattach = sameAgent ? recorded?.reattach : undefined;
  const fingerprint = sameAgent ? recorded?.fingerprint : undefined;
  // `session/load` replays the session's conversation as updates. They are the
  // agent's history, not this turn's work: they reach raw-event consumers
  // marked `replay: true`, and never the text, reasoning or item streams.
  let reloading = false;

  let bridge = new AcpEventBridge(step, baseCtx);
  bridge.identifyToolCalls(agent.toolIdOf?.bind(agent));
  // A tool pipeline error fails the step, as it does in `callModel`: it is
  // kept, the agent's turn is cancelled, and the error is thrown once the
  // turn has unwound.
  const turnError: TurnError = {};
  const bindingFor = (events: AcpEventBridge): HostBindingOptions<TContext, I, O> => ({
    step,
    ctx: baseCtx,
    questions,
    agentId: agent.agentId,
    layers,
    onUpdate: (notification) => {
      // A loaded session's history is not this turn's output.
      if (reloading) {
        return;
      }
      tools?.observe(notification.update);
      events.forward(notification);
    },
    onChildUpdate: (update) => {
      // A loaded session's history is not this turn's work, its subagents' included.
      if (reloading) {
        return;
      }
      // Its lineage first: a hold the announcement renames names the nested
      // agent only once the turn knows where it sits.
      events.forwardChild(update);
      tools?.observeChild(update.sessionId, update.update);
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

  // Both an explicit `session.load` and the resume of an earlier attempt's
  // session load it; a reused live session is not reloaded and replays nothing.
  reloading = resumeId !== undefined || step.session?.load !== undefined;
  const resolution = await openSession({
    step,
    agent,
    baseCtx,
    cwd,
    host,
    binding: bindingFor(bridge),
    tools,
    resumeId,
    reattach,
    fingerprint,
    settings,
  })
    .catch((cause: unknown) => {
      throw stepFailure(step, cause, baseCtx);
    })
    .finally(() => {
      reloading = false;
    });
  if (resolution.resumed) {
    tools?.sessionReloaded();
  }
  // A reloaded session was opened again with this step's settings: its record
  // takes the new fingerprint. A reattached one keeps the one it has.
  if (resolution.fresh && !resolution.reattached) {
    await sessions?.write({
      sessionId: resolution.live.session.sessionId,
      agentId: agent.agentId,
      // How a resumed run reaches this agent if it outlives this host.
      reattach: resolution.live.connection.reattach,
      fingerprint: resolution.live.session.fingerprint,
    });
  }

  const selectedModel = await applySessionSelection(step, ctx, resolution, baseCtx).catch(
    (cause: unknown) => {
      throw stepFailure(step, cause, baseCtx);
    },
  );
  turnError.cancel = () => resolution.live.session.cancel();

  // History seeds only a freshly opened session; a reused one already owns
  // its conversation on the agent side.
  // A reloaded session has its conversation too, and the work it had done.
  let turnPrompt = resolution.resumed
    ? `${ACP_RESUME_NOTICE}\n\n${promptText}`
    : resolution.fresh
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
      collect: retries === 0 && resolution.reattached,
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
      bridge = new AcpEventBridge(step, baseCtx);
      bridge.identifyToolCalls(agent.toolIdOf?.bind(agent));
      bindHostToStep(resolution.live.host, bindingFor(bridge));
      continue;
    }
    publishStepMeta(baseCtx, result, currentModel(resolution.live.session, selectedModel));
    if (layers && layers.length > 0) {
      await baseCtx.harness.storeLayers(layers, response, baseCtx);
    }
    await finalizeSession(resolution, baseCtx);
    await sessions?.clear();
    return await stepOutput(step, result);
  }
}

//#endregion
