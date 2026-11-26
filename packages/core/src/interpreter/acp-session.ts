import type {
  AcpAgent,
  AcpAgentConnection,
  AcpClientCapabilityConfig,
  AcpClientHost,
  AcpConnectOptions,
  AcpKeepAlive,
  AcpNewSessionOptions,
  AcpReattachHandle,
  AcpSession,
  AcpSessionPolicy,
  AcpWhenHostExits,
  Context,
  ContextData,
  StepAcpAgent,
} from '@noetic-tools/types';
import { frameworkCast, isAcpConnectError, NoeticConfigError } from '@noetic-tools/types';
import { runtimeOf } from '../connections/model-tools';
import type {
  AcpAdapterNames,
  AcpLiveSession,
  AcpSessionStore,
} from '../runtime/acp-session-store';
import { acpSessionsOf } from '../runtime/acp-session-store';
import type { AcpToolRunner } from './acp-tools';
import { resolveLazy } from './action-tools';
import { abortSignalOf } from './typeguards';

//#region Session settings

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

export async function resolveSessionSettings<TContext, I, O>(
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

/** Keeping a connection is always explicit; the default closes it with the step. */
function keepAliveOf(policy: AcpSessionPolicy | undefined): AcpKeepAlive {
  return policy?.keepAlive ?? 'step';
}

/**
 * Sharing a connection only means something if the connection outlives the
 * step. Rather than silently upgrading the scope, say so — the step is asking
 * for two different things and has only named one.
 */
export function assertReuseIsKeptAlive<TContext, I, O>(step: StepAcpAgent<TContext, I, O>): void {
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

export interface SessionResolution {
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

//#endregion

//#region Session acquisition

export async function openSession<TContext, I, O>(opts: {
  step: StepAcpAgent<TContext, I, O>;
  agent: AcpAgent;
  baseCtx: Context<ContextData>;
  cwd: string;
  host: AcpClientHost;
  /** Per-turn host binding, reapplied when an existing session is reused. */
  rebind(host: AcpClientHost): void;
  tools?: AcpToolRunner;
  /** The session an earlier attempt of this step opened, to reload when the agent can. */
  resumeId?: string;
  /** How to reach the agent that earlier attempt left running, when it can outlive its host. */
  reattach?: AcpReattachHandle;
  /** The fingerprint that earlier attempt's session was opened with. */
  fingerprint?: string;
  settings: SessionSettings;
  /** The harness adapters the step uses. */
  adapters: AcpAdapterNames;
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
    adapters: opts.adapters,
  };
  // Registered under a key even without `session.reuse`: anything kept past
  // its step has to be reachable, or nothing can ever close it.
  const key = store.keyFor(parts);

  const { live, fresh } = await store.acquire(key, parts, async () => {
    const connectOptions = {
      host: opts.host,
      signal: abortSignalOf(opts.baseCtx),
      whenHostExits: whenHostExitsOf(opts.baseCtx),
      subprocess: {
        adapters: opts.baseCtx.adapters.subprocess,
        name: opts.step.subprocess,
      },
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
    opts.rebind(live.host);
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

//#endregion

//#region Session cleanup and selection

/**
 * Tear the connection down per policy. Nothing is kept unless the step asked
 * for it: only `keepAlive: 'run' | 'harness'` survives the step, and the run
 * scope is collected by the harness when the root run finishes.
 */
export async function finalizeSession(
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

/**
 * Release a connection this step opened, before surfacing a failure. A reused
 * one is left intact for a later step to retry against.
 */
export async function discardIfFresh(
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
export async function applySessionSelection<TContext, I, O>(
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

//#endregion
