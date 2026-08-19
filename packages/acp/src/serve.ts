/**
 * The server direction (spec 31): expose a Noetic harness *as* an ACP agent.
 *
 * `toAcpAgent(harness)` returns the `(conn) => acp.Agent` factory shape that
 * `loopbackTransport()` accepts — so a served harness can be mounted as a
 * sub-agent of another harness, driven by Noetic's own ACP client in tests,
 * or bound to process stdio by `serveAcp()` (`@noetic-tools/acp/server`).
 *
 * The adapter maps the protocol onto the harness's existing public surface —
 * `execute`, the streams, `seedSessionHistory`, `abort` — and nothing else.
 */

import type {
  AcpContentBlock,
  AcpToolKind,
  ContextLayer,
  InputContentPart,
  InputMessageItem,
  Item,
  StreamEvent,
  StreamingItem,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import type * as acp from '@zed-industries/agent-client-protocol';
import type { AgentSideConnection } from '@zed-industries/agent-client-protocol';
import { PROTOCOL_VERSION, RequestError } from '@zed-industries/agent-client-protocol';
import { clientFsAdapter, clientShellAdapter } from './client-adapters';
import { contentBlockText } from './items';
import { isAbsolutePath } from './paths';
import type { ServeSessionUpdate, ServeToolCallPresentation } from './serve-events';
import { pumpTurnEvents } from './serve-events';
import type { ServeToolPresentation } from './serve-permissions';
import {
  createServePermissionLayer,
  evaluateServePolicy,
  ServePermissionBroker,
} from './serve-permissions';
import type {
  AcpServeHarness,
  AcpServeHarnessSource,
  AcpServeOptions,
  AcpServePermissionPrompt,
  AcpServePermissionReply,
} from './serve-types';

//#region Session state

interface ServeSession {
  sessionId: string;
  cwd: string;
  harness: AcpServeHarness;
  gateLayer?: ContextLayer;
  /** Set by `session/cancel`; read by the pump to map the abort to `cancelled`. */
  cancelRequested: boolean;
  /** Whether this session's history-save pump is running. */
  pumping: boolean;
  /** Ends the history-save pump's item-stream consumer (set once the pump starts). */
  stopSavePump?: () => void;
  /** Item ids already persisted — the item stream re-emits cumulative snapshots. */
  persistedIds: Set<string>;
}

//#endregion

//#region Presentation

interface Presenter extends ServeToolPresentation {
  present(toolName: string, callId: string, args: unknown): ServeToolCallPresentation;
}

/**
 * A kind-based permission rule resolves kinds through `options.tools`; with
 * no tools declared it silently matches nothing and the policy default
 * applies — a security policy that does nothing must be a loud config error,
 * not a quiet fallback to `allow`.
 */
function assertKindRulesResolvable(options: AcpServeOptions): void {
  const rules = options.permissions?.rules ?? [];
  const hasKindOnlyRule = rules.some((rule) => rule.kind !== undefined && rule.tool === undefined);
  if (hasKindOnlyRule && (!options.tools || options.tools.length === 0)) {
    throw new NoeticConfigError({
      code: 'ACP_SERVE_KIND_RULES_WITHOUT_TOOLS',
      message: 'A kind-based permission rule was given without `tools` to resolve kinds from.',
      hint: "Pass the harness's tools to the serve options — serveAcp(harness, { tools, permissions }) — so rules like { kind: 'execute' } can match their tools.",
    });
  }
}

function buildPresenter(options: AcpServeOptions): Presenter {
  const declarations = new Map(
    options.tools?.map((tool) => [
      tool.name,
      tool.acp,
    ]),
  );

  const kindOf = (toolName: string): AcpToolKind | undefined => declarations.get(toolName)?.kind;

  const titleOf = (toolName: string, args: unknown): string => {
    const title = declarations.get(toolName)?.title;
    if (typeof title === 'string') {
      return title;
    }
    if (typeof title === 'function' && args !== undefined) {
      try {
        return title(args);
      } catch {
        return toolName;
      }
    }
    return toolName;
  };

  const locationsOf = (
    toolName: string,
    args: unknown,
  ):
    | Array<{
        path: string;
      }>
    | undefined => {
    const locations = declarations.get(toolName)?.locations;
    if (!locations || args === undefined) {
      return undefined;
    }
    try {
      return locations(args).map((path) => ({
        path,
      }));
    } catch {
      return undefined;
    }
  };

  const statusOf = (toolName: string): 'pending' | 'in_progress' => {
    if (!options.permissions) {
      return 'in_progress';
    }
    const decision = evaluateServePolicy({
      policy: options.permissions,
      toolName,
      kind: kindOf(toolName),
    });
    return decision === 'ask' ? 'pending' : 'in_progress';
  };

  return {
    kindOf,
    titleOf,
    present: (toolName, _callId, args) => ({
      title: titleOf(toolName, args),
      kind: kindOf(toolName),
      locations: locationsOf(toolName, args),
      status: statusOf(toolName),
    }),
  };
}

//#endregion

//#region Prompt conversion

function contentBlocksToItems(prompt: ReadonlyArray<AcpContentBlock>): Item[] {
  const parts: InputContentPart[] = [];
  for (const block of prompt) {
    if (block.type === 'image') {
      parts.push({
        type: 'input_image',
        imageUrl: block.uri ?? `data:${block.mimeType};base64,${block.data}`,
      });
      continue;
    }
    const text = contentBlockText(block);
    if (text.length > 0) {
      parts.push({
        type: 'input_text',
        text,
      });
    }
  }
  if (parts.length === 0) {
    return [];
  }
  return [
    userMessageItem(parts),
  ];
}

function userMessageItem(parts: InputContentPart[]): Item {
  return frameworkCast<Item>({
    id: `acp-user-${crypto.randomUUID()}`,
    type: 'message',
    role: 'user',
    status: 'completed',
    content: parts,
  } satisfies InputMessageItem);
}

function textInput(text: string): Item[] {
  return [
    userMessageItem([
      {
        type: 'input_text',
        text,
      },
    ]),
  ];
}

//#endregion

//#region History replay

/** Replay stored items to the client, the `session/load` contract. */
function replayUpdates(items: ReadonlyArray<Item>): ServeSessionUpdate[] {
  const updates: ServeSessionUpdate[] = [];
  for (const item of items) {
    const record = frameworkCast<Record<string, unknown>>(item);
    if (record.type === 'message') {
      const text = messageText(record);
      if (text.length === 0) {
        continue;
      }
      updates.push({
        sessionUpdate: record.role === 'assistant' ? 'agent_message_chunk' : 'user_message_chunk',
        content: {
          type: 'text',
          text,
        },
      });
      continue;
    }
    if (record.type === 'function_call' && typeof record.callId === 'string') {
      updates.push({
        sessionUpdate: 'tool_call',
        toolCallId: record.callId,
        title: typeof record.name === 'string' ? record.name : record.callId,
        status: 'completed',
      });
      continue;
    }
    if (record.type === 'function_call_output' && typeof record.callId === 'string') {
      updates.push({
        sessionUpdate: 'tool_call_update',
        toolCallId: record.callId,
        status: record.status === 'failed' ? 'failed' : 'completed',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text:
                typeof record.output === 'string' ? record.output : JSON.stringify(record.output),
            },
          },
        ],
      });
    }
  }
  return updates;
}

function messageText(record: Record<string, unknown>): string {
  if (!Array.isArray(record.content)) {
    return '';
  }
  const texts: string[] = [];
  for (const part of record.content) {
    if (typeof part !== 'object' || part === null) {
      continue;
    }
    const text = frameworkCast<Record<string, unknown>>(part).text;
    if (typeof text === 'string') {
      texts.push(text);
    }
  }
  return texts.join('');
}

//#endregion

//#region The agent adapter

/**
 * The served agent: the protocol surface plus `dispose()`, which cancels
 * every live session when the transport goes away.
 * @public
 */
export interface AcpServedAgent extends acp.Agent {
  dispose(): Promise<void>;
}

/**
 * Adapt a harness (or per-session factory) into an ACP `Agent` factory — the
 * exact shape `loopbackTransport()` and `AgentSideConnection` accept.
 * @public
 */
export function toAcpAgent(
  source: AcpServeHarnessSource,
  options: AcpServeOptions = {},
): (conn: AgentSideConnection) => AcpServedAgent {
  return (conn) => new ServeAgent(conn, source, options);
}

class ServeAgent implements acp.Agent {
  private readonly sessions = new Map<string, ServeSession>();
  private readonly presenter: Presenter;
  private readonly broker: ServePermissionBroker;
  private clientCapabilities: acp.ClientCapabilities | undefined;

  constructor(
    private readonly conn: AgentSideConnection,
    private readonly source: AcpServeHarnessSource,
    private readonly options: AcpServeOptions,
  ) {
    assertKindRulesResolvable(options);
    this.presenter = buildPresenter(options);
    const onPermissionRequest = options.onPermissionRequest;
    const forward = onPermissionRequest
      ? (prompt: AcpServePermissionPrompt) => onPermissionRequest(prompt)
      : this.forwardPermissionToWire.bind(this);
    // The grant→in_progress transition belongs to the broker wrapper, not one
    // forwarder: the gated tool_call went out as `pending`, and it must move
    // whether the wire client or an in-process host answered the ask.
    this.broker = new ServePermissionBroker(async (prompt) => {
      const reply = await forward(prompt);
      if (reply.decision === 'allow') {
        this.sendGrantProgress(prompt);
      }
      return reply;
    });
  }

  //#region Protocol methods

  async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    this.clientCapabilities = params.clientCapabilities;
    return {
      // One supported revision: answer it whatever the client requested (the
      // protocol says respond with the latest supported version otherwise).
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: this.options.history !== undefined,
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
      },
      authMethods: [],
    };
  }

  async authenticate(): Promise<acp.AuthenticateResponse> {
    return {};
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const session = await this.openSession(crypto.randomUUID(), params.cwd, params.mcpServers);
    this.advertiseCommands(session.sessionId);
    return {
      sessionId: session.sessionId,
    };
  }

  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    const history = this.options.history;
    if (!history) {
      throw RequestError.methodNotFound('session/load');
    }
    if (this.sessions.has(params.sessionId)) {
      // Reloading a LIVE session would clobber its entry while its pumps keep
      // running against the old one; the protocol has no reason to do this.
      throw RequestError.invalidParams({
        message: `session is already active: ${params.sessionId}`,
      });
    }
    const items = await history.load(params.sessionId);
    if (items === null) {
      throw RequestError.invalidParams({
        message: `unknown session: ${params.sessionId}`,
      });
    }
    const session = await this.openSession(params.sessionId, params.cwd, params.mcpServers);
    session.harness.seedSessionHistory(session.sessionId, items);
    for (const item of items) {
      const id = itemId(item);
      if (id) {
        session.persistedIds.add(id);
      }
    }
    for (const update of replayUpdates(items)) {
      await this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update,
      });
    }
    this.advertiseCommands(session.sessionId);
    return {};
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.requireSession(params.sessionId);

    const input = await this.resolveInput(session, params.prompt);
    if (input.length === 0) {
      return {
        stopReason: 'end_turn',
      };
    }
    await this.persistItems(session, input);
    this.startSavePump(session);

    // Attach BEFORE execute(): `turn_started` is emitted synchronously inside
    // execute(), and the session broadcaster discards events whenever a
    // previously-consumed stream has no live consumer.
    const events = attachEvents(session.harness, session.sessionId);
    const messageId = crypto.randomUUID();
    try {
      await session.harness.execute(input, {
        threadId: session.sessionId,
        messageId,
        // ADDITIVE: the gate joins the harness's own layers; the override
        // option would silently delete instructions/history/steering.
        extraContextLayers: session.gateLayer
          ? [
              session.gateLayer,
            ]
          : undefined,
      });

      const outcome = await pumpTurnEvents({
        events,
        messageId,
        notify: (update) =>
          this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update,
          }),
        present: this.presenter.present,
        cancelRequested: () => session.cancelRequested,
      });
      if (outcome.kind === 'error') {
        throw RequestError.internalError({
          message: outcome.message,
        });
      }
      return {
        stopReason: outcome.stopReason,
      };
    } finally {
      // Release the broadcaster consumer even when execute() rejects before
      // the pump runs — a leaked live iterator would suppress the discard
      // rule for every later turn on this session.
      await events.close();
      // The flag is NOT reset at prompt start: a fast follow-up prompt must
      // not erase an in-flight turn's cancellation. It is turn-scoped by
      // resetting here, once this turn's outcome is decided.
      session.cancelRequested = false;
    }
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      return;
    }
    session.cancelRequested = true;
    this.broker.cancelSession(session.sessionId);
    await session.harness.abort({
      threadId: session.sessionId,
      reason: 'cancelled',
    });
  }

  /** Cancel every live session — the transport-shutdown path (`serveAcp().close()`). */
  async dispose(): Promise<void> {
    const sessions = [
      ...this.sessions.values(),
    ];
    this.sessions.clear();
    await Promise.all(
      sessions.map(async (session) => {
        session.cancelRequested = true;
        this.broker.cancelSession(session.sessionId);
        session.stopSavePump?.();
        await session.harness
          .abort({
            threadId: session.sessionId,
            reason: 'connection closed',
          })
          .catch(() => undefined);
      }),
    );
  }

  //#endregion

  //#region Internals

  private async openSession(
    sessionId: string,
    cwd: string,
    mcpServers: ReadonlyArray<acp.McpServer>,
  ): Promise<ServeSession> {
    if (!isAbsolutePath(cwd)) {
      throw RequestError.invalidParams({
        message: `cwd must be an absolute path: ${cwd}`,
      });
    }
    const harness =
      typeof this.source === 'function'
        ? await this.source({
            sessionId,
            cwd,
            mcpServers,
            client: {
              fs: clientFsAdapter({
                conn: this.conn,
                sessionId,
                capabilities: this.clientCapabilities,
              }),
              shell: clientShellAdapter({
                conn: this.conn,
                sessionId,
                capabilities: this.clientCapabilities,
              }),
              capabilities: this.clientCapabilities,
            },
          })
        : this.source;
    const session: ServeSession = {
      sessionId,
      cwd,
      harness,
      gateLayer: this.options.permissions
        ? createServePermissionLayer({
            sessionId,
            policy: this.options.permissions,
            broker: this.broker,
            presentation: this.presenter,
          })
        : undefined,
      cancelRequested: false,
      pumping: false,
      persistedIds: new Set(),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  private requireSession(sessionId: string): ServeSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams({
        message: `unknown session: ${sessionId}`,
      });
    }
    return session;
  }

  /**
   * `NewSessionResponse` has no commands field at this protocol revision, so
   * advertised commands follow as an `available_commands_update` notification.
   * Deferred a tick so the notification cannot reach the wire before the
   * response that introduces the session id.
   */
  private advertiseCommands(sessionId: string): void {
    const commands = this.options.commands;
    if (!commands || commands.length === 0) {
      return;
    }
    setTimeout(() => {
      void this.conn
        .sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: commands.map((command) => ({
              name: command.name,
              description: command.description,
              input: command.inputHint
                ? {
                    hint: command.inputHint,
                  }
                : undefined,
            })),
          },
        })
        .catch(() => undefined);
    }, 0);
  }

  /** Route `/name args` prompts through the matching command's `run`. */
  private async resolveInput(
    session: ServeSession,
    prompt: ReadonlyArray<AcpContentBlock>,
  ): Promise<Item[]> {
    const commands = this.options.commands;
    const first = prompt[0];
    if (commands && commands.length > 0 && first?.type === 'text' && first.text.startsWith('/')) {
      // Only the command NAME is tokenized; the argument text is passed RAW
      // (minus one separator character) so newlines, code blocks, and runs of
      // whitespace survive the rewrite.
      const match = /^\/(\S+)([\s\S]*)$/.exec(first.text);
      const command = match ? commands.find((c) => c.name === match[1]) : undefined;
      if (command?.run && match) {
        const argsText = (match[2] ?? '').replace(/^\s/, '');
        const result = await command.run(argsText, {
          sessionId: session.sessionId,
          cwd: session.cwd,
        });
        // Blocks after the command block (images, embedded context) still
        // reach the turn — a command rewrite must not discard client content.
        const rest = contentBlocksToItems(prompt.slice(1));
        return typeof result === 'string'
          ? [
              ...textInput(result),
              ...rest,
            ]
          : [
              ...result,
              ...rest,
            ];
      }
    }
    return contentBlocksToItems(prompt);
  }

  /** Forward an `ask` to the client as `session/request_permission`. */
  private async forwardPermissionToWire(
    prompt: AcpServePermissionPrompt,
  ): Promise<AcpServePermissionReply> {
    const toolCallId = prompt.callId ?? prompt.requestId;
    const response = await this.conn.requestPermission({
      sessionId: prompt.sessionId,
      toolCall: {
        toolCallId,
        title: prompt.title,
        kind: prompt.kind,
        rawInput: asRecord(prompt.args),
        status: 'pending',
      },
      options: [
        {
          optionId: 'allow',
          name: 'Allow',
          kind: 'allow_once',
        },
        {
          optionId: 'reject',
          name: 'Reject',
          kind: 'reject_once',
        },
      ],
    });
    if (response.outcome.outcome === 'cancelled') {
      return {
        decision: 'cancel',
      };
    }
    if (response.outcome.optionId === 'allow') {
      return {
        decision: 'allow',
      };
    }
    return {
      decision: 'deny',
      reason: 'the user rejected the tool call',
    };
  }

  /** Move the pending gated `tool_call` to `in_progress` after a grant, whoever answered. */
  private sendGrantProgress(prompt: AcpServePermissionPrompt): void {
    void this.conn
      .sessionUpdate({
        sessionId: prompt.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: prompt.callId ?? prompt.requestId,
          status: 'in_progress',
        },
      })
      .catch(() => undefined);
  }

  /** Append completed items to the history seam as they stream, deduplicated by id. */
  private startSavePump(session: ServeSession): void {
    const history = this.options.history;
    if (!history || session.pumping) {
      return;
    }
    session.pumping = true;
    void pumpItems(session, history.save.bind(history)).catch(() => {
      // A dead pump only pauses persistence; the next prompt restarts it, and
      // the persisted-id set keeps the replay from duplicating history.
      session.pumping = false;
    });
  }

  private async persistItems(session: ServeSession, items: ReadonlyArray<Item>): Promise<void> {
    const history = this.options.history;
    if (!history) {
      return;
    }
    for (const item of items) {
      const id = itemId(item);
      if (id) {
        if (session.persistedIds.has(id)) {
          continue;
        }
        session.persistedIds.add(id);
      }
      await history.save(session.sessionId, item);
    }
  }

  //#endregion
}

async function pumpItems(
  session: ServeSession,
  save: (sessionId: string, item: Item) => Promise<void>,
): Promise<void> {
  const iterator = session.harness
    .getItemStream({
      threadId: session.sessionId,
    })
    [Symbol.asyncIterator]();
  // The item stream spans turns and never completes on its own; dispose()
  // ends the pump through this handle instead of leaving a consumer parked
  // on the broadcaster for the life of the process.
  session.stopSavePump = () => {
    void iterator.return?.().catch(() => undefined);
  };
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      return;
    }
    const item = next.value;
    if (!item.isComplete) {
      continue;
    }
    // The stream re-emits an assistant message once at text-done (status
    // still in_progress) and again finalized; registering the first copy's id
    // would make the dedupe DISCARD the corrected one, persisting messages
    // permanently marked in_progress.
    if (itemStatus(item) === 'in_progress') {
      continue;
    }
    const id = itemId(item);
    if (id) {
      if (session.persistedIds.has(id)) {
        continue;
      }
      session.persistedIds.add(id);
    }
    await save(session.sessionId, stripIsComplete(item));
  }
}

function itemStatus(item: Item | StreamingItem): string | undefined {
  return 'status' in item && typeof item.status === 'string' ? item.status : undefined;
}

interface AttachedEvents extends AsyncIterable<StreamEvent> {
  /** Release the broadcaster consumer; safe to call after normal exhaustion. */
  close(): Promise<void>;
}

/** Eagerly bind an iterator so the broadcaster registers the consumer now, not at first read. */
function attachEvents(harness: AcpServeHarness, threadId: string): AttachedEvents {
  const iterator = harness
    .getFullStream({
      threadId,
    })
    [Symbol.asyncIterator]();
  return {
    [Symbol.asyncIterator]: () => iterator,
    async close() {
      await iterator.return?.().catch(() => undefined);
    },
  };
}

function itemId(item: Item | StreamingItem): string | null {
  return 'id' in item && typeof item.id === 'string' ? item.id : null;
}

function stripIsComplete(streamingItem: StreamingItem): Item {
  const { isComplete: _isComplete, ...item } = streamingItem;
  return item;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return frameworkCast<Record<string, unknown>>(value);
}

//#endregion
