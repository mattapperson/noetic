/**
 * Drives the ACP agent side of a connection.
 *
 * Wraps the protocol library's `ClientSideConnection` in the Noetic
 * {@link AcpAgentConnection} / {@link AcpSession} contract, so `@noetic-tools/core`
 * can execute an ACP step without ever importing the protocol package.
 *
 * Responsibilities beyond plumbing:
 *  - negotiate `initialize` and hold the agent's advertised capabilities,
 *  - refuse, before anything hits the wire, requests the agent cannot serve
 *    (loading a session, switching mode, sending image/audio content),
 *  - route `session/update` notifications to the turn accumulator *and* the
 *    host, so both the result and the live event stream see every update,
 *  - translate an aborted turn into `session/cancel` plus the `cancelled`
 *    stop reason the specification requires.
 */

import type * as acp from '@agentclientprotocol/sdk';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  AcpAgentConnection,
  AcpChildInfo,
  AcpChildUpdate,
  AcpClientHost,
  AcpContentBlock,
  AcpLoadSessionOptions,
  AcpNewSessionOptions,
  AcpPromptOptions,
  AcpReattachHandle,
  AcpResumeTurnOptions,
  AcpSession,
  AcpSessionNotification,
  AcpTransport,
  AcpTurnResult,
} from '@noetic-tools/types';
import { AcpCapabilityError, AcpConnectError } from '@noetic-tools/types';
import { z } from 'zod';
import { clientCapabilitiesFor, NoeticAcpClient } from './client';
import { KEEPER_METHODS } from './keeper/relay';
import type { WatchedTransport } from './liveness';
import { watchTransport } from './liveness';
import type { ToolBridge } from './tool-bridge';
import { AcpTurnAccumulator } from './turn';
import { divertNewerUpdates } from './update-filter';

//#region Types

/** @public Options for {@link openAcpConnection}. */
export interface OpenAcpConnectionOptions {
  agentId: string;
  transport: AcpTransport;
  host: AcpClientHost;
  signal?: AbortSignal;
  /** The tool bridge serving `host.tools`, closed with the connection. */
  tools?: ToolBridge;
  /** How a later host reaches this agent, when it can outlive this one. */
  reattach?: AcpReattachHandle;
  /** The transport reaches an agent an earlier host started (through its keeper). */
  reattached?: boolean;
  /**
   * The agent's own way to take instructions when it does not advertise
   * `sessionCapabilities.systemPrompt`: the `_meta` to send instead.
   */
  instructionsMeta?: InstructionsMeta;
  /**
   * The agent's own session options, sent as `_meta` on every session this
   * connection opens. Its keys win over {@link instructionsMeta}'s.
   */
  sessionMeta?: Readonly<Record<string, unknown>>;
}

/** @public See {@link OpenAcpConnectionOptions.instructionsMeta}. */
export type InstructionsMeta = (instructions: string) => Record<string, unknown>;

/** The `_meta` and `systemPrompt` a session request carries. */
interface SessionFields {
  _meta?: Record<string, unknown>;
  systemPrompt?: acp.SystemPrompt;
}

/** Updates held for a session nobody has claimed yet, at most. */
const EARLY_UPDATE_LIMIT = 1e3;
/** Child sessions remembered per connection, at most; the oldest go first. */
const CHILD_LIMIT = 1e3;

/** Routes a session's notifications to whichever turn is currently running. */
type NotificationSink = (notification: AcpSessionNotification) => void;

//#endregion

//#region Content capability gating

/**
 * The spec requires clients to restrict prompt content to what the agent
 * advertised, so an unsupported block is a configuration error raised here
 * rather than an opaque failure on the wire.
 */
export function assertPromptContentSupported(
  agentId: string,
  content: ReadonlyArray<AcpContentBlock>,
  capabilities: acp.PromptCapabilities | undefined,
): void {
  for (const block of content) {
    if (block.type === 'image' && capabilities?.image !== true) {
      throw new AcpCapabilityError({
        agentId,
        capability: 'promptCapabilities.image',
      });
    }
    if (block.type === 'audio' && capabilities?.audio !== true) {
      throw new AcpCapabilityError({
        agentId,
        capability: 'promptCapabilities.audio',
      });
    }
    const embedded = block.type === 'resource' || block.type === 'resource_link';
    if (embedded && capabilities?.embeddedContext !== true) {
      throw new AcpCapabilityError({
        agentId,
        capability: 'promptCapabilities.embeddedContext',
      });
    }
  }
}

/** What the keeper says about a session (`_noetic/keeper/session`). */
const KeeperSessionSchema = z.object({
  known: z.boolean(),
  modes: z.custom<acp.SessionModeState>((value) => isRecord(value)).optional(),
  configOptions: z.custom<acp.SessionConfigOption[]>((value) => Array.isArray(value)).optional(),
});

const StopReasonSchema = z.enum([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
]);

/** How the keeper answers `_noetic/keeper/turn`. */
const KeeperTurnSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('idle'),
  }),
  z.object({
    state: z.literal('finished'),
    response: z.object({
      stopReason: StopReasonSchema,
      usage: z.custom<acp.Usage>((value) => isRecord(value)).nullish(),
    }),
  }),
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What a session is set up with beyond its request, stable across hosts: the
 * tools the bridge serves (names, descriptions, schemas), the bridge's name and
 * how it is declared, and the client's path rules. Snapshotted when the
 * connection opens, which is when the agent reads its tool list.
 */
function setupOf(host: AcpClientHost, tools: ToolBridge | undefined): Record<string, unknown> {
  return {
    tools: (host.tools?.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    bridge: tools
      ? {
          serverName: tools.server.name,
          declare: tools.declare ?? null,
        }
      : null,
    paths: {
      additionalDirectories: [
        ...(host.capabilities?.additionalDirectories ?? []),
      ].sort(),
      allowAnyPath: host.capabilities?.allowAnyPath === true,
    },
  };
}

/** JSON with object keys sorted, so two spellings of one value compare equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (!isRecord(inner)) {
      return inner;
    }
    return Object.fromEntries(
      Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
}

/**
 * The child session an update announces: the subagents RFD's
 * `subagent_update`, or codex-acp's earlier draft `subagent_spawned`.
 */
export function announcedChild(update: AcpSessionNotification['update']): string | undefined {
  if (update.sessionUpdate === 'subagent_update') {
    return update.sessionId;
  }
  // A draft variant the library does not know arrives as sent (update-filter).
  const draft: Record<string, unknown> = {
    ...update,
  };
  if (draft.sessionUpdate !== 'subagent_spawned') {
    return undefined;
  }
  return typeof draft.subagentSessionId === 'string' ? draft.subagentSessionId : undefined;
}

/** JSON-RPC's "method not found". */
const METHOD_NOT_FOUND = -32601;

function isMethodNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && Reflect.get(error, 'code') === METHOD_NOT_FOUND
  );
}

//#endregion

//#region Session

class AcpSessionImpl implements AcpSession {
  /** Set for the duration of a turn; notifications fan out to it. */
  private activeTurn?: AcpTurnAccumulator;
  /**
   * Tail of the turn queue. An ACP session is one conversation, and its
   * notifications carry no turn id — so two turns in flight at once fan into
   * whichever accumulator was installed last, silently truncating one and
   * corrupting the other. Turns are therefore serialised rather than rejected:
   * a model can emit parallel `acpAgentTool` calls sharing a session, and both
   * deserve a correct answer, just not simultaneously.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly agentId: string,
    private readonly agent: acp.Agent,
    readonly sessionId: string,
    private modeState: acp.SessionModeState | undefined,
    private options: acp.SessionConfigOption[] | undefined,
    private commands: acp.AvailableCommand[],
    /** Rejects if the agent dies, so a request cannot outlive it. */
    private readonly death: Promise<never>,
    /** What the agent said it accepts, enforced before a turn goes on the wire. */
    private readonly promptCapabilities: acp.PromptCapabilities | undefined,
    /** What the session was opened with; undefined on a reattached session. */
    readonly fingerprint?: string,
  ) {}

  get modes(): acp.SessionModeState | undefined {
    return this.modeState;
  }

  get configOptions(): ReadonlyArray<acp.SessionConfigOption> {
    return this.options ?? [];
  }

  get availableCommands(): ReadonlyArray<acp.AvailableCommand> {
    return this.commands;
  }

  /**
   * Take the modes and config options a `session/load` answer advertises. The
   * session is registered before the load (so replayed updates reach it), so
   * these arrive after construction.
   */
  applySettings(settings: Pick<acp.LoadSessionResponse, 'modes' | 'configOptions'>): void {
    if (settings.modes) {
      this.modeState = settings.modes;
    }
    if (settings.configOptions) {
      this.options = settings.configOptions;
    }
  }

  /** Feed a notification to the running turn, if any. */
  receive(notification: AcpSessionNotification): void {
    const update = notification.update;
    if (update.sessionUpdate === 'available_commands_update') {
      this.commands = [
        ...update.availableCommands,
      ];
    }
    if (update.sessionUpdate === 'current_mode_update' && this.modeState) {
      this.modeState = {
        ...this.modeState,
        currentModeId: update.currentModeId,
      };
    }
    if (update.sessionUpdate === 'config_option_update') {
      this.options = update.configOptions;
    }
    this.activeTurn?.push(notification);
  }

  async prompt(opts: AcpPromptOptions): Promise<AcpTurnResult> {
    // The specification requires clients to restrict prompt content to what the
    // agent advertised, so an unsupported block is refused here rather than
    // failing opaquely inside the agent. Checked before queueing, so a bad
    // request fails immediately instead of after an unrelated turn.
    assertPromptContentSupported(this.agentId, opts.content, this.promptCapabilities);

    // Wait for any turn already running on this session, then take our place at
    // the tail. A failed predecessor must not poison the queue.
    const ours = this.queue.then(
      () => this.runTurn(opts),
      () => this.runTurn(opts),
    );
    this.queue = ours.catch(() => undefined);
    return await ours;
  }

  private async runTurn(opts: AcpPromptOptions): Promise<AcpTurnResult> {
    const result = await this.collectTurn(opts.signal, async () =>
      this.agent.prompt({
        sessionId: this.sessionId,
        prompt: [
          ...opts.content,
        ],
      }),
    );
    if (!result) {
      throw new Error('session/prompt returned no answer.');
    }
    return result;
  }

  /**
   * Make this a reattached session: {@link resumeTurn} collects the turn the
   * previous host left running through the keeper.
   */
  enableResume(): void {
    this.resumeTurn = async (opts: AcpResumeTurnOptions) => {
      const ours = this.queue.then(
        () => this.collectTurn(opts.signal, () => this.keeperTurn()),
        () => this.collectTurn(opts.signal, () => this.keeperTurn()),
      );
      this.queue = ours.catch(() => undefined);
      return await ours;
    };
  }

  /** Set on a reattached session; see `AcpSession.resumeTurn`. */
  resumeTurn?: (opts: AcpResumeTurnOptions) => Promise<AcpTurnResult | undefined>;

  /** Ask the keeper for the turn in flight: its updates arrive, then its answer. */
  private async keeperTurn(): Promise<acp.PromptResponse | undefined> {
    const request = this.agent.extMethod?.bind(this.agent);
    if (!request) {
      return undefined;
    }
    const answer = KeeperTurnSchema.parse(
      await request(KEEPER_METHODS.turn, {
        sessionId: this.sessionId,
      }),
    );
    return answer.state === 'finished' ? answer.response : undefined;
  }

  /**
   * Run one turn: updates go to a fresh accumulator while `send` waits for
   * the agent's answer. Undefined when there was no turn to collect.
   */
  private async collectTurn(
    signal: AbortSignal | undefined,
    send: () => Promise<acp.PromptResponse | undefined>,
  ): Promise<AcpTurnResult | undefined> {
    const accumulator = new AcpTurnAccumulator();
    this.activeTurn = accumulator;
    const opts = {
      signal,
    };
    const onAbort = () => {
      // Fire-and-forget: the specification says the agent still answers the
      // original `session/prompt` with the `cancelled` stop reason.
      void this.cancel();
    };
    opts.signal?.addEventListener('abort', onAbort, {
      once: true,
    });
    try {
      const response = await Promise.race([
        send(),
        this.death,
      ]);
      if (!response) {
        return undefined;
      }
      const result = accumulator.result({
        stopReason: response.stopReason,
        reportedUsage: response.usage ?? undefined,
      });
      return {
        ...result,
        currentModeId: result.currentModeId ?? this.modeState?.currentModeId,
      };
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      this.activeTurn = undefined;
    }
  }

  async cancel(): Promise<void> {
    await this.agent.cancel({
      sessionId: this.sessionId,
    });
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.modeState || !this.agent.setSessionMode) {
      throw new AcpCapabilityError({
        agentId: this.agentId,
        capability: 'session/set_mode',
      });
    }
    await Promise.race([
      this.agent.setSessionMode({
        sessionId: this.sessionId,
        modeId,
      }),
      this.death,
    ]);
  }

  async setModel(modelId: string): Promise<void> {
    const model = this.modelOption();
    if (model && this.agent.setSessionConfigOption) {
      const response = await Promise.race([
        this.agent.setSessionConfigOption({
          sessionId: this.sessionId,
          configId: model.id,
          value: modelId,
        }),
        this.death,
      ]);
      this.options = response.configOptions;
      return;
    }
    await this.setModelDirectly(modelId);
  }

  /**
   * The `model` config option: by category, else by id, for an agent that
   * leaves the (optional, UX-only) category off.
   */
  private modelOption(): acp.SessionConfigOption | undefined {
    const selects = (this.options ?? []).filter((option) => option.type === 'select');
    return (
      selects.find((option) => option.category === 'model') ??
      selects.find((option) => option.id === 'model')
    );
  }

  /**
   * An agent that advertises no `model` config option may still take the
   * draft `session/set_model` request (it predates config options). One that
   * does not know it answers "method not found", which is the capability
   * error a step expects.
   */
  private async setModelDirectly(modelId: string): Promise<void> {
    const request = this.agent.extMethod?.bind(this.agent);
    if (!request) {
      throw new AcpCapabilityError({
        agentId: this.agentId,
        capability: 'session/set_config_option:model',
      });
    }
    try {
      await Promise.race([
        request('session/set_model', {
          sessionId: this.sessionId,
          modelId,
        }),
        this.death,
      ]);
    } catch (error) {
      if (isMethodNotFound(error)) {
        throw new AcpCapabilityError({
          agentId: this.agentId,
          capability: 'session/set_config_option:model',
        });
      }
      throw error;
    }
  }
}

//#endregion

//#region Connection

class AcpAgentConnectionImpl implements AcpAgentConnection {
  private readonly sessions = new Map<string, AcpSessionImpl>();
  /** Each subagent's child session, to the session that announced it. */
  private readonly children = new Map<string, string>();
  /** What each child's announcements said of it. */
  private readonly childInfo = new Map<string, AcpChildInfo>();
  /** Updates for a session not yet known, oldest first. */
  private early: AcpSessionNotification[] = [];
  /** Set by {@link openAcpConnection}. */
  settings: {
    instructionsMeta?: InstructionsMeta;
    sessionMeta?: Readonly<Record<string, unknown>>;
    /** What `initialize` advertised. */
    capabilities?: acp.ClientCapabilities;
    /**
     * What else the agent was set up with when this connection opened, without
     * anything that changes from host to host (addresses, tokens): the tools
     * served to it, the bridge's name, and the client's path rules.
     */
    setup?: Readonly<Record<string, unknown>>;
    /** Where an update of one of this connection's own sessions goes. */
    deliver?: (notification: AcpSessionNotification) => void;
    /** Where a subagent's child-session traffic goes. */
    toChild?: (update: AcpChildUpdate) => void;
  } = {};

  constructor(
    private readonly agentId: string,
    private readonly agent: acp.Agent,
    private readonly transport: AcpTransport,
    private readonly client: NoeticAcpClient,
    readonly agentCapabilities: acp.AgentCapabilities,
    readonly authMethods: ReadonlyArray<acp.AuthMethod>,
    readonly protocolVersion: number,
    private readonly watch: WatchedTransport,
    private readonly tools: ToolBridge | undefined,
    readonly reattach: AcpReattachHandle | undefined,
    reattached: boolean,
  ) {
    if (reattached) {
      this.attachSession = (sessionId) => this.attachTo(sessionId);
    }
    if (transport.detach) {
      this.detach = () => this.letGo();
    }
  }

  /** Set on a reattached connection; see `AcpAgentConnection.attachSession`. */
  attachSession?: (sessionId: string) => Promise<AcpSession>;

  /** The live session `sessionId`, as the keeper last saw it. */
  private async attachTo(sessionId: string): Promise<AcpSession> {
    const request = this.agent.extMethod?.bind(this.agent);
    const info = request
      ? KeeperSessionSchema.parse(
          await Promise.race([
            request(KEEPER_METHODS.session, {
              sessionId,
            }),
            this.watch.death,
          ]),
        )
      : undefined;
    if (!info?.known) {
      throw new AcpConnectError({
        agentId: this.agentId,
        message: `ACP agent '${this.agentId}' no longer has session ${sessionId}.`,
        gone: true,
      });
    }
    const session = new AcpSessionImpl(
      this.agentId,
      this.agent,
      sessionId,
      info.modes,
      info.configOptions,
      [],
      this.watch.death,
      this.agentCapabilities.promptCapabilities,
    );
    session.enableResume();
    return this.track(session);
  }

  /**
   * Route one `session/update` (spec 27 § Subagents' own sessions): an update
   * of one of this connection's sessions is delivered; a subagent's child
   * session's is dropped, never the step's output; one for a session not known
   * yet is held until it is.
   */
  route(notification: AcpSessionNotification): void {
    const owner = notification.sessionId;
    const child = announcedChild(notification.update);
    if (child !== undefined && child !== owner && this.owns(owner)) {
      this.adoptChild(child, owner);
      this.describe(child, notification.update);
      this.settings.toChild?.({
        sessionId: child,
        parentSessionId: owner,
        update: notification.update,
        announcement: true,
        lineage: this.lineageOf(child),
      });
      this.drainChild(child);
    }
    const parent = this.children.get(owner);
    if (parent !== undefined) {
      if (child === undefined || child === owner) {
        this.settings.toChild?.({
          sessionId: owner,
          parentSessionId: parent,
          update: notification.update,
          announcement: false,
          lineage: this.lineageOf(owner),
        });
      }
      return;
    }
    if (this.sessions.has(owner)) {
      this.settings.deliver?.(notification);
      return;
    }
    this.early.push(notification);
    if (this.early.length > EARLY_UPDATE_LIMIT) {
      this.early.shift();
    }
  }

  private owns(sessionId: string): boolean {
    return this.sessions.has(sessionId) || this.children.has(sessionId);
  }

  private adoptChild(child: string, parent: string): void {
    this.children.set(child, parent);
    this.trimChildren();
  }

  /**
   * Forget the oldest children past the cap, never one another kept child was
   * announced under: a grandchild must still be placed under its whole chain.
   */
  private trimChildren(): void {
    if (this.children.size <= CHILD_LIMIT) {
      return;
    }
    const parents = new Set(this.children.values());
    for (const child of this.children.keys()) {
      if (this.children.size <= CHILD_LIMIT) {
        return;
      }
      if (parents.has(child)) {
        continue;
      }
      this.children.delete(child);
      this.childInfo.delete(child);
    }
  }

  /** Keep what an announcement says of a child: its title and description. */
  private describe(child: string, update: AcpSessionNotification['update']): void {
    const fields: Record<string, unknown> = {
      ...update,
    };
    const text = (...names: string[]): string | undefined => {
      for (const name of names) {
        const value = fields[name];
        if (typeof value === 'string') {
          return value;
        }
      }
      return undefined;
    };
    const known = this.childInfo.get(child);
    const title = text('title', 'name') ?? known?.title;
    const description = text('description', 'task') ?? known?.description;
    this.childInfo.set(child, {
      sessionId: child,
      ...(title === undefined
        ? {}
        : {
            title,
          }),
      ...(description === undefined
        ? {}
        : {
            description,
          }),
    });
  }

  /** `sessionId` and the children above it, outermost first. */
  private lineageOf(sessionId: string): AcpChildInfo[] {
    const chain: AcpChildInfo[] = [];
    const seen = new Set<string>();
    for (let at: string | undefined = sessionId; at !== undefined && this.children.has(at); ) {
      if (seen.has(at)) {
        break;
      }
      seen.add(at);
      chain.unshift(
        this.childInfo.get(at) ?? {
          sessionId: at,
        },
      );
      at = this.children.get(at);
    }
    return chain;
  }

  /** A child's updates held before it was announced, routed now as its own, in order. */
  private drainChild(child: string): void {
    const held = this.early.filter((notification) => notification.sessionId === child);
    if (held.length === 0) {
      return;
    }
    this.early = this.early.filter((notification) => notification.sessionId !== child);
    for (const notification of held) {
      this.route(notification);
    }
  }

  /** The sink the client hands every `session/update` notification. */
  get sink(): NotificationSink {
    return (notification) => {
      this.sessions.get(notification.sessionId)?.receive(notification);
    };
  }

  async authenticate(methodId: string): Promise<void> {
    await Promise.race([
      this.agent.authenticate({
        methodId,
      }),
      this.watch.death,
    ]);
  }

  fingerprintFor(opts: AcpNewSessionOptions): string {
    return canonicalJson({
      cwd: opts.cwd,
      fields: this.sessionFields(opts),
      mcpServers: (opts.mcpServers ?? []).map((server) => server.name),
      capabilities: this.settings.capabilities ?? {},
      setup: this.settings.setup ?? {},
    });
  }

  async newSession(opts: AcpNewSessionOptions): Promise<AcpSession> {
    const response = await Promise.race([
      this.agent.newSession({
        cwd: opts.cwd,
        mcpServers: this.sessionMcpServers(opts.mcpServers),
        ...this.sessionFields(opts),
      }),
      this.watch.death,
    ]);
    return this.track(
      new AcpSessionImpl(
        this.agentId,
        this.agent,
        response.sessionId,
        response.modes ?? undefined,
        response.configOptions ?? undefined,
        [],
        this.watch.death,
        this.agentCapabilities.promptCapabilities,
        this.fingerprintFor(opts),
      ),
    );
  }

  async loadSession(opts: AcpLoadSessionOptions): Promise<AcpSession> {
    if (this.agentCapabilities.loadSession !== true || !this.agent.loadSession) {
      throw new AcpCapabilityError({
        agentId: this.agentId,
        capability: 'loadSession',
      });
    }
    const fields = this.sessionFields(opts);
    // Register before the call: `session/load` replays the conversation through
    // `session/update` notifications, which must not be dropped on the floor.
    const session = this.track(
      new AcpSessionImpl(
        this.agentId,
        this.agent,
        opts.sessionId,
        undefined,
        undefined,
        [],
        this.watch.death,
        this.agentCapabilities.promptCapabilities,
        this.fingerprintFor(opts),
      ),
    );
    const response = await Promise.race([
      this.agent.loadSession({
        sessionId: opts.sessionId,
        cwd: opts.cwd,
        mcpServers: this.sessionMcpServers(opts.mcpServers),
        ...fields,
      }),
      this.watch.death,
    ]).catch((error: unknown) => {
      // A failed load leaves nothing behind: no session, no children of it.
      this.forget(opts.sessionId);
      throw error;
    });
    if (response) {
      session.applySettings(response);
    }
    return session;
  }

  /** Set when the transport can let go of an agent that outlives this host. */
  detach?: () => Promise<void>;

  /** Release this host's side, leaving the agent running for a later host. */
  async letGo(): Promise<void> {
    this.sessions.clear();
    this.children.clear();
    this.childInfo.clear();
    this.early = [];
    this.watch.shutdown();
    await this.transport.detach?.().catch(() => undefined);
    await this.client.dispose();
    await this.tools?.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.sessions.clear();
    this.children.clear();
    this.childInfo.clear();
    this.early = [];
    // Reject anything still in flight first. Once the transport is down
    // nothing can answer it, so a pending request would hang forever.
    this.watch.shutdown();
    // Close the transport BEFORE releasing terminals, so the agent cannot ask
    // for another one during teardown.
    await this.transport.close().catch(() => undefined);
    await this.client.dispose();
    await this.tools?.close().catch(() => undefined);
  }

  //#region internals

  private track(session: AcpSessionImpl): AcpSessionImpl {
    this.sessions.set(session.sessionId, session);
    // Everything held while no session was known goes through the routing
    // again, in order: the new session's own updates are delivered, a child
    // announced on it is adopted (dropping that child's held updates), and
    // the rest stays held.
    const held = this.early;
    this.early = [];
    for (const notification of held) {
      this.route(notification);
    }
    return session;
  }

  /** Forget a session and every descendant it announced. */
  private forget(sessionId: string): void {
    this.sessions.delete(sessionId);
    const gone = new Set([
      sessionId,
    ]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [child, parent] of this.children) {
        if (gone.has(parent) && !gone.has(child)) {
          gone.add(child);
          grew = true;
        }
      }
    }
    for (const child of gone) {
      this.children.delete(child);
      this.childInfo.delete(child);
    }
  }

  /**
   * The servers `session/new` carries: the user's plus the tool bridge, or
   * none when the agent was given them all at launch.
   */
  private sessionMcpServers(servers?: ReadonlyArray<acp.McpServer>): acp.McpServer[] {
    if (this.tools?.declare === 'launch') {
      this.checkedMcpServers(servers);
      return [];
    }
    return this.checkedMcpServers([
      ...(servers ?? []),
      ...(this.tools
        ? [
            this.tools.server,
          ]
        : []),
    ]);
  }

  /**
   * The `_meta` and system prompt a session request carries (spec 27
   * § Instructions): instructions as the protocol's `systemPrompt` when the
   * agent advertises it, else through the adapter's extension, else refused
   * rather than dropped; the adapter's `sessionMeta` over that extension.
   */
  private sessionFields(opts: AcpNewSessionOptions): SessionFields {
    const instructions = opts.instructions;
    const native = instructions !== undefined && this.advertisesInstructions();
    const fallback =
      instructions !== undefined && !native ? this.instructionsFallback(instructions) : undefined;
    const sessionMeta = this.settings.sessionMeta;
    const meta =
      fallback || sessionMeta
        ? {
            ...fallback,
            ...sessionMeta,
          }
        : undefined;
    return {
      ...(meta
        ? {
            _meta: meta,
          }
        : {}),
      ...(native && instructions !== undefined
        ? {
            systemPrompt: {
              mode: 'append',
              content: [
                {
                  type: 'text',
                  text: instructions,
                },
              ],
            },
          }
        : {}),
    };
  }

  private advertisesInstructions(): boolean {
    return Boolean(this.agentCapabilities.sessionCapabilities?.systemPrompt);
  }

  private instructionsFallback(instructions: string): Record<string, unknown> {
    const make = this.settings.instructionsMeta;
    if (!make) {
      throw new AcpCapabilityError({
        agentId: this.agentId,
        capability: 'sessionCapabilities.systemPrompt',
      });
    }
    return make(instructions);
  }

  /** Reject HTTP/SSE MCP transports the agent never advertised support for. */
  private checkedMcpServers(servers?: ReadonlyArray<acp.McpServer>): acp.McpServer[] {
    if (!servers || servers.length === 0) {
      return [];
    }
    const mcp = this.agentCapabilities.mcpCapabilities;
    for (const server of servers) {
      if (!('type' in server)) {
        continue;
      }
      if (server.type === 'http' && mcp?.http !== true) {
        throw new AcpCapabilityError({
          agentId: this.agentId,
          capability: 'mcpCapabilities.http',
        });
      }
      if (server.type === 'sse' && mcp?.sse !== true) {
        throw new AcpCapabilityError({
          agentId: this.agentId,
          capability: 'mcpCapabilities.sse',
        });
      }
    }
    return [
      ...servers,
    ];
  }

  //#endregion
}

//#endregion

//#region Public API

/**
 * Open a transport, run the `initialize` handshake, and return the negotiated
 * connection.
 * @public
 */
export async function openAcpConnection(
  opts: OpenAcpConnectionOptions,
): Promise<AcpAgentConnection> {
  // The sink is late-bound: the client needs it at construction, but it can
  // only dispatch once the connection exists to hold the session map. The host
  // is passed through BY REFERENCE — copying it here would freeze the per-turn
  // policy and event sink to whichever step opened the connection, silently
  // ignoring the configuration of every step that later reuses the session.
  let sink: NotificationSink | undefined;
  let connection: AcpAgentConnectionImpl | undefined;
  const host = opts.host;

  const client = new NoeticAcpClient({
    host,
    permitsBridged: opts.tools?.permits,
    onNotify: (notification) => notify(notification),
  });
  // The protocol library never rejects pending responses when the stream ends,
  // so without this a dead agent leaves every request hanging forever.
  const watch = watchTransport(opts.agentId, opts.transport, opts.signal);
  const notify = (notification: AcpSessionNotification): void => {
    // Only this connection's own sessions produce the step's output.
    if (!connection) {
      return;
    }
    connection.route(notification);
  };
  const agent = new ClientSideConnection(
    () => client,
    ndJsonStream(opts.transport.writable, divertNewerUpdates(watch.readable, notify)),
  );

  let initialized: acp.InitializeResponse;
  try {
    initialized = await Promise.race([
      agent.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: clientCapabilitiesFor(host),
      }),
      watch.death,
    ]);
  } catch (error) {
    watch.shutdown('failed the initialize handshake');
    // An agent reached for an earlier host is let go of, never stopped.
    const release =
      opts.reattached && opts.transport.detach
        ? opts.transport.detach.bind(opts.transport)
        : opts.transport.close.bind(opts.transport);
    await release().catch(() => undefined);
    throw new AcpConnectError({
      agentId: opts.agentId,
      message: `ACP agent '${opts.agentId}' failed the initialize handshake.`,
      cause: error,
    });
  }

  connection = new AcpAgentConnectionImpl(
    opts.agentId,
    agent,
    opts.transport,
    client,
    initialized.agentCapabilities ?? {},
    initialized.authMethods ?? [],
    initialized.protocolVersion,
    watch,
    opts.tools,
    opts.reattach,
    opts.reattached === true,
  );
  sink = connection.sink;
  connection.settings = {
    instructionsMeta: opts.instructionsMeta,
    sessionMeta: opts.sessionMeta,
    capabilities: clientCapabilitiesFor(host),
    setup: setupOf(host, opts.tools),
    deliver: (notification) => {
      sink?.(notification);
      host.onSessionUpdate(notification);
    },
    // Read at call time: the runtime rebinds it for every turn.
    toChild: (update) => host.onChildUpdate?.(update),
  };
  return connection;
}

//#endregion
