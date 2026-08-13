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

import type {
  AcpAgentConnection,
  AcpClientHost,
  AcpContentBlock,
  AcpLoadSessionOptions,
  AcpNewSessionOptions,
  AcpPromptOptions,
  AcpSession,
  AcpSessionNotification,
  AcpTransport,
  AcpTurnResult,
} from '@noetic-tools/types';
import { AcpCapabilityError, AcpConnectError } from '@noetic-tools/types';
import type * as acp from '@zed-industries/agent-client-protocol';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@zed-industries/agent-client-protocol';
import { clientCapabilitiesFor, NoeticAcpClient } from './client';
import { AcpTurnAccumulator } from './turn';

//#region Types

/** @public Options for {@link openAcpConnection}. */
export interface OpenAcpConnectionOptions {
  agentId: string;
  transport: AcpTransport;
  host: AcpClientHost;
  signal?: AbortSignal;
}

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

//#endregion

//#region Session

class AcpSessionImpl implements AcpSession {
  /** Set for the duration of a turn; notifications fan out to it. */
  private activeTurn?: AcpTurnAccumulator;

  constructor(
    private readonly agentId: string,
    private readonly agent: acp.Agent,
    readonly sessionId: string,
    readonly modes: acp.SessionModeState | undefined,
    private readonly models: acp.SessionModelState | undefined,
    private commands: acp.AvailableCommand[],
  ) {}

  get availableCommands(): ReadonlyArray<acp.AvailableCommand> {
    return this.commands;
  }

  /** Feed a notification to the running turn, if any. */
  receive(notification: AcpSessionNotification): void {
    const update = notification.update;
    if (update.sessionUpdate === 'available_commands_update') {
      this.commands = [
        ...update.availableCommands,
      ];
    }
    this.activeTurn?.push(notification);
  }

  async prompt(opts: AcpPromptOptions): Promise<AcpTurnResult> {
    const accumulator = new AcpTurnAccumulator();
    this.activeTurn = accumulator;
    const onAbort = () => {
      // Fire-and-forget: the specification says the agent still answers the
      // original `session/prompt` with the `cancelled` stop reason.
      void this.cancel();
    };
    opts.signal?.addEventListener('abort', onAbort, {
      once: true,
    });
    try {
      const response = await this.agent.prompt({
        sessionId: this.sessionId,
        prompt: [
          ...opts.content,
        ],
      });
      return accumulator.result({
        stopReason: response.stopReason,
      });
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
    if (!this.modes || !this.agent.setSessionMode) {
      throw new AcpCapabilityError({
        agentId: this.agentId,
        capability: 'session/set_mode',
      });
    }
    await this.agent.setSessionMode({
      sessionId: this.sessionId,
      modeId,
    });
  }

  async setModel(modelId: string): Promise<void> {
    if (!this.models || !this.agent.setSessionModel) {
      throw new AcpCapabilityError({
        agentId: this.agentId,
        capability: 'session/set_model',
      });
    }
    await this.agent.setSessionModel({
      sessionId: this.sessionId,
      modelId,
    });
  }
}

//#endregion

//#region Connection

class AcpAgentConnectionImpl implements AcpAgentConnection {
  private readonly sessions = new Map<string, AcpSessionImpl>();

  constructor(
    private readonly agentId: string,
    private readonly agent: acp.Agent,
    private readonly transport: AcpTransport,
    private readonly client: NoeticAcpClient,
    readonly agentCapabilities: acp.AgentCapabilities,
    readonly authMethods: ReadonlyArray<acp.AuthMethod>,
    readonly protocolVersion: number,
  ) {}

  /** The sink the client hands every `session/update` notification. */
  get sink(): NotificationSink {
    return (notification) => {
      this.sessions.get(notification.sessionId)?.receive(notification);
    };
  }

  async authenticate(methodId: string): Promise<void> {
    await this.agent.authenticate({
      methodId,
    });
  }

  async newSession(opts: AcpNewSessionOptions): Promise<AcpSession> {
    const response = await this.agent.newSession({
      cwd: opts.cwd,
      mcpServers: this.checkedMcpServers(opts.mcpServers),
    });
    return this.track(
      new AcpSessionImpl(
        this.agentId,
        this.agent,
        response.sessionId,
        response.modes ?? undefined,
        response.models ?? undefined,
        [],
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
    // Register before the call: `session/load` replays the conversation through
    // `session/update` notifications, which must not be dropped on the floor.
    const session = this.track(
      new AcpSessionImpl(this.agentId, this.agent, opts.sessionId, undefined, undefined, []),
    );
    await this.agent.loadSession({
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      mcpServers: this.checkedMcpServers(opts.mcpServers),
    });
    return session;
  }

  async close(): Promise<void> {
    this.sessions.clear();
    await this.client.dispose();
    await this.transport.close();
  }

  //#region internals

  private track(session: AcpSessionImpl): AcpSessionImpl {
    this.sessions.set(session.sessionId, session);
    return session;
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
  const host = opts.host;

  const client = new NoeticAcpClient({
    host,
    onNotify: (notification) => {
      sink?.(notification);
      host.onSessionUpdate(notification);
    },
  });
  const agent = new ClientSideConnection(
    () => client,
    ndJsonStream(opts.transport.writable, opts.transport.readable),
  );

  let initialized: acp.InitializeResponse;
  try {
    initialized = await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: clientCapabilitiesFor(host),
    });
  } catch (error) {
    await opts.transport.close().catch(() => undefined);
    throw new AcpConnectError({
      agentId: opts.agentId,
      message: `ACP agent '${opts.agentId}' failed the initialize handshake.`,
      cause: error,
    });
  }

  const connection = new AcpAgentConnectionImpl(
    opts.agentId,
    agent,
    opts.transport,
    client,
    initialized.agentCapabilities ?? {},
    initialized.authMethods ?? [],
    initialized.protocolVersion,
  );
  sink = connection.sink;
  return connection;
}

//#endregion
