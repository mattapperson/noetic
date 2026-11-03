/**
 * Agent Client Protocol (ACP) contract.
 *
 * Noetic drives external coding agents — Claude Code, Codex, Gemini CLI, any
 * ACP-speaking binary — as an **ACP Client**. The agent is a JSON-RPC 2.0 peer
 * reached over a duplex byte stream, so there is no vendor SDK per agent and no
 * closed set of supported agents.
 *
 * This file is the direct analogue of the `ContextLayer` contract: defined in
 * the foundation package so both `@noetic-tools/core` (which executes ACP steps)
 * and `@noetic-tools/acp` (which implements the protocol) depend on it without
 * forming a cycle. Core calls only the methods declared here — the ACP library's
 * `ClientSideConnection` never enters core's dependency graph.
 *
 * Protocol types are re-used verbatim from `@zed-industries/agent-client-protocol`
 * (spec version 1) rather than mirrored, so the wire surface cannot drift from
 * the specification.
 *
 * @see https://agentclientprotocol.com/
 */

import type * as acp from '@zed-industries/agent-client-protocol';
import type { TokenUsage } from './common';
import type { Context } from './context';
import type { FsAdapter } from './fs-adapter';
import type { Item } from './items';
import type { ShellAdapter } from './shell-adapter';
import type { ByteStream, Spawn, SpawnCommand } from './spawn';

//#region Step-kind discriminator

/**
 * The single step kind backing every ACP agent. Unlike the closed harness enum
 * it replaces, the *agent* is identified by a free-form `agentId` on the
 * adapter — so adding an agent never touches core or the published JSON Schema.
 * @public
 */
export const ACP_AGENT_STEP_KIND = 'acp-agent';

//#endregion

//#region Transport

/**
 * A bidirectional byte stream to an ACP agent — the substrate JSON-RPC frames
 * ride on.
 *
 * This is deliberately *not* built on {@link SubprocessAdapter}: that contract
 * returns a durable handle (`id`/`status`/`metadata`) with no attached stdio,
 * and {@link ShellAdapter} is one-shot. ACP needs a long-lived duplex pipe.
 * @public
 */
export type AcpTransport = ByteStream;

/** @public Options a transport factory receives when a step opens a connection. */
export interface AcpTransportOptions {
  /** Working directory the agent process should start in. */
  cwd: string;
  /** Environment overrides layered onto the host environment. */
  env?: Record<string, string | undefined>;
  /** Aborting this signal closes the transport. */
  signal?: AbortSignal;
}

/**
 * Opens a transport on demand. Local agents use a stdio transport over a child
 * process; tests use an in-memory loopback; remote agents can use anything that
 * yields a duplex byte stream.
 * @public
 */
export type AcpTransportFactory = (opts: AcpTransportOptions) => Promise<AcpTransport>;

/**
 * Where a tool bridge can be reached: an MCP streamable HTTP endpoint and the
 * headers every request must carry (always the bridge's bearer token).
 * @public
 */
export interface ToolBridgeAddress {
  readonly serverName: string;
  readonly url: string;
  readonly headers: ReadonlyArray<{
    name: string;
    value: string;
  }>;
}

/**
 * The machine an ACP agent runs on, opened once per connection before the
 * agent starts. The tool bridge listens on the host's loopback interface, so
 * the machine first carries it to where the agent can reach it, then starts
 * the agent with launch settings that may name that address.
 * @public
 */
export interface AcpMachine {
  /**
   * An address the agent can use to reach `bridge`. The same address on this
   * machine; a channel to it from anywhere else. A non-loopback hop is TLS.
   */
  reach(bridge: ToolBridgeAddress): Promise<ToolBridgeAddress>;
  /** Start the agent and return its ACP byte stream. */
  launch(command: SpawnCommand): Promise<AcpTransport>;
  /**
   * Start a process beside the agent — a stdio MCP server that depends on
   * this machine — and carry its stdio back, so noetic stays its client.
   */
  spawn: Spawn;
  /** Release the machine and everything started on it. */
  close(): Promise<void>;
}

/** @public Opens an {@link AcpMachine} for one connection. */
export type AcpMachineFactory = (opts: { signal?: AbortSignal }) => Promise<AcpMachine>;

//#endregion

//#region Permissions

/** @public How a permission request was resolved. */
export const AcpPermissionDecision = {
  Allow: 'allow',
  Deny: 'deny',
  Cancel: 'cancel',
} as const;

/** @public Union of permission decisions. */
export type AcpPermissionDecision =
  (typeof AcpPermissionDecision)[keyof typeof AcpPermissionDecision];

/**
 * The resolved answer to an ACP `session/request_permission` call. The client
 * translates it into the concrete {@link acp.PermissionOption} the agent
 * offered — `optionId` pins an exact option when the resolver picked one.
 * @public
 */
export interface AcpPermissionOutcome {
  decision: AcpPermissionDecision;
  /** Exact option id to select. When omitted the client picks by `decision`. */
  optionId?: string;
  /** Why this decision was made — surfaced on framework events and the steering ledger. */
  reason?: string;
}

/**
 * Matches a tool call the agent wants to run. An omitted field matches anything;
 * all present fields must match.
 * @public
 */
export interface AcpPermissionRule {
  /** ACP tool classification (`read`, `edit`, `execute`, …). */
  kind?: acp.ToolKind;
  /** Matches the tool call title — substring (case-insensitive) or pattern. */
  title?: string | RegExp;
}

/**
 * Declarative permission policy evaluated before the steering pipeline and the
 * `onPermissionRequest` handler.
 * @public
 */
export interface AcpPermissionPolicy {
  /**
   * Decision when no rule matches and no later resolver decides. Defaults to
   * `'deny'` — an unattended agent must not get blanket approval by omission.
   */
  default?: AcpPermissionDecision;
  /** Rules granting permission. Evaluated before {@link deny}. */
  allow?: ReadonlyArray<AcpPermissionRule>;
  /** Rules refusing permission. */
  deny?: ReadonlyArray<AcpPermissionRule>;
  /**
   * Prefer the agent's `allow_always` / `reject_always` options over the
   * `*_once` variants, so a decision persists for the rest of the session.
   */
  persist?: boolean;
}

/**
 * Async escape hatch for decisions a declarative policy cannot express —
 * human-in-the-loop approval, a remote policy service, an LLM judge.
 *
 * Receives the executing {@link Context} because reaching a human almost always
 * means reaching a channel: `ctx.send` the request out, `ctx.recv` the decision
 * back. Without it a handler could only answer from what it closed over.
 * @public
 */
export type AcpPermissionHandler = (
  request: acp.RequestPermissionRequest,
  ctx: Context,
  info: AcpPermissionRequestInfo,
) => Promise<AcpPermissionOutcome>;

/**
 * Which agent and step raised a permission request. The protocol request says
 * what the agent wants to do but not who is asking, and a human answering
 * needs both to make sense of the prompt.
 * @public
 */
export interface AcpPermissionRequestInfo {
  /** `agentId` of the adapter whose turn raised the request. */
  agentId: string;
  /** Id of the step whose turn raised it. */
  stepId: string;
}

/**
 * The handler as the protocol client sees it — already bound to the executing
 * context by the runtime. Keeps `Context` out of the client, which only needs
 * to ask the question and get an answer.
 * @public
 */
export type AcpBoundPermissionHandler = (
  request: acp.RequestPermissionRequest,
) => Promise<AcpPermissionOutcome>;

/**
 * The steering tier of permission resolution. Returning `undefined` abstains,
 * handing the decision to the next tier. The runtime wires this to the same
 * `beforeToolCall` pipeline that governs first-party tool calls, so one rule set
 * covers both.
 * @public
 */
export type AcpPermissionSteerer = (
  request: acp.RequestPermissionRequest,
) => Promise<AcpPermissionOutcome | undefined>;

//#endregion

//#region Client host

/**
 * Which ACP client capabilities to advertise during `initialize`. Every flag
 * defaults to enabled when the host can back it; setting one to `false`
 * withdraws it, so the agent never attempts the call.
 * @public
 */
export interface AcpClientCapabilityConfig {
  /** Serve `fs/read_text_file` from the host's {@link FsAdapter}. */
  readTextFile?: boolean;
  /** Serve `fs/write_text_file` from the host's {@link FsAdapter}. */
  writeTextFile?: boolean;
  /** Serve the `terminal/*` family from the host's {@link ShellAdapter}. */
  terminal?: boolean;
  /**
   * Directories the agent may reach in addition to the session working
   * directory, which is always allowed. Use for a monorepo sibling, a shared
   * cache, or a scratch dir outside the workspace.
   */
  additionalDirectories?: ReadonlyArray<string>;
  /**
   * Lift filesystem confinement entirely, letting the agent read and write any
   * absolute path the host process can.
   *
   * Off by default, and worth leaving off: ACP places boundary enforcement on
   * the client, and a `permissions` policy does not substitute for it — that
   * answers `session/request_permission`, which covers the agent's tool calls,
   * not the `fs/*` methods it invokes on the client directly.
   */
  allowAnyPath?: boolean;
}

/**
 * The client methods an agent can invoke on us. Closed by ACP spec version 1,
 * so a literal union rather than `string`: a typo in a descriptor is a compile
 * error, and consumers narrowing on `activity.method` get exhaustiveness.
 * @public
 */
export type AcpClientMethod =
  | 'fs/read_text_file'
  | 'fs/write_text_file'
  | 'terminal/create'
  | 'terminal/output'
  | 'terminal/wait_for_exit'
  | 'terminal/kill'
  | 'terminal/release';

/**
 * One client-side operation an agent performed — or was refused. Emitted for
 * every `fs/*` and `terminal/*` call the agent makes.
 *
 * This is an *observed* record, not the agent's self-report: `tool_call`
 * updates say what the agent claims it did, while this says what it actually
 * asked the client to do, including the calls that were turned down.
 * @public
 */
export interface AcpClientActivity {
  /** The ACP client method invoked, e.g. `fs/read_text_file`. */
  method: AcpClientMethod;
  /** Path involved, for the `fs/*` family and `terminal/create`'s cwd. */
  path?: string;
  /** Command line, for `terminal/create`. */
  command?: string;
  /** Terminal handle, for the `terminal/*` family. */
  terminalId?: string;
  /** False when the call was refused — by a withdrawn capability or confinement. */
  allowed: boolean;
  /** Why it was refused. */
  reason?: string;
}

/**
 * The runtime surface an ACP connection is given to satisfy client-side
 * requests. Because file reads/writes and terminal commands are served from
 * Noetic's own adapters, everything the sub-agent touches passes through the
 * same sandboxing, virtual-filesystem, and audit machinery as first-party steps.
 * @public
 */
export interface AcpClientHost {
  /** Working directory for the session (resolved from `ctx.cwdState.cwd`). */
  readonly cwd: string;
  readonly fs: FsAdapter;
  readonly shell: ShellAdapter;
  /** Conversation thread id, for hosts that scope state per thread. */
  readonly threadId: string;
  /** Abort signal for the surrounding execution. */
  readonly signal?: AbortSignal;
  /**
   * Capability advertisement overrides. Connection-level: ACP negotiates the
   * client capability set once during `initialize`, so this cannot change for
   * the life of a connection.
   */
  readonly capabilities?: AcpClientCapabilityConfig;
  /**
   * Permission resolution, in the order it is consulted: the declarative
   * policy, then steering, then the async handler. The protocol client owns the
   * resolution logic; the host only supplies the inputs.
   *
   * These are **per-turn**, and deliberately mutable: a session reused across
   * several steps must answer with the CURRENT step's policy, not the one that
   * happened to open the connection. The client reads them at call time, so
   * the runtime updates them before each turn.
   */
  permissions?: AcpPermissionPolicy;
  steerPermission?: AcpPermissionSteerer;
  onPermissionRequest?: AcpBoundPermissionHandler;
  /**
   * Receive every `session/update` notification for the active session. Also
   * per-turn — it routes to the running step's event bridge, so a reused
   * session's output is attributed to the step that actually asked for it.
   */
  onSessionUpdate: (notification: acp.SessionNotification) => void;
  /**
   * Receive every `fs/*` and `terminal/*` call the agent makes, allowed or
   * refused. Per-turn like {@link onSessionUpdate}, so activity is attributed
   * to the step that actually caused it.
   */
  onClientActivity?: (activity: AcpClientActivity) => void;
  /**
   * Noetic tools to serve to the agent over MCP. Set before `connect`: agents
   * that read their MCP settings at launch need the bridge to exist first.
   */
  tools?: AcpToolHost;
}

//#endregion

//#region Bridged tools

/**
 * A Noetic tool as an ACP agent sees it: one entry in the `tools/list` answer
 * of the MCP server the bridge serves to the agent.
 * @public
 */
export interface AcpTool {
  /** Wire name, already reduced to `[A-Za-z0-9_-]` so every agent keeps it as-is. */
  readonly name: string;
  readonly description: string;
  /** JSON Schema of the arguments. Always `type: "object"` at the root, as MCP requires. */
  readonly inputSchema: Record<string, unknown>;
  /** Display title, from the tool's `acp.title` when it is a plain string. */
  readonly title?: string;
}

/** @public One `tools/call` the agent made, as the bridge hands it to the host. */
export interface AcpToolCall {
  /** Wire name the agent called. */
  readonly name: string;
  readonly args: unknown;
  /**
   * The agent's own id for the call, when it sends one in the MCP request
   * `_meta`. It equals the `toolCallId` of the ACP `tool_call` update for the
   * same call, which is how the two records are joined.
   */
  readonly agentCallId?: string;
  /** Aborted when the agent cancels the call. */
  readonly signal: AbortSignal;
}

/** @public What a bridged tool call returns to the agent. */
export interface AcpToolResult {
  /** The exact string a model would receive for the same call. */
  readonly output: string;
  readonly isError: boolean;
}

/**
 * The Noetic tools a connection serves to its agent over MCP.
 *
 * `tools` is fixed for the life of a connection: agents fetch the list once.
 * `call` is per-turn and mutable, like the permission fields on
 * {@link AcpClientHost}: a session reused by several steps runs each call in
 * the context of the step whose turn is in flight.
 * @public
 */
export interface AcpToolHost {
  /** MCP server name the agent sees, and the prefix it puts on tool names. */
  readonly serverName: string;
  readonly tools: ReadonlyArray<AcpTool>;
  call: (call: AcpToolCall) => Promise<AcpToolResult>;
}

/**
 * The exact titles agents give a call to `wireName` on the MCP server
 * `serverName`: Claude Code's `mcp__<server>__<tool>`, Codex's
 * `mcp.<server>.<tool>`, and opencode's `<server>_<tool>`.
 * @public
 */
export function bridgedToolTitles(serverName: string, wireName: string): ReadonlyArray<string> {
  return [
    `mcp__${serverName}__${wireName}`,
    `mcp.${serverName}.${wireName}`,
    `${serverName}_${wireName}`,
  ];
}

/**
 * True when an agent's tool call is a call to `wireName` on the MCP server
 * `serverName`, by what the agent itself puts in the call: one of
 * {@link bridgedToolTitles}, or Gemini CLI's id `mcp_<server>_<tool>__call_<n>`.
 * Gemini shortens a long `mcp_<server>_<tool>` with `...` in the middle; the
 * shortened form matches when the tool name starts and ends as it does.
 * @public
 */
export function namesBridgedToolCall(
  serverName: string,
  wireName: string,
  call: {
    toolCallId: string;
    title?: string | null;
  },
): boolean {
  if (call.title && bridgedToolTitles(serverName, wireName).includes(call.title)) {
    return true;
  }
  return geminiToolNameMatches(serverName, wireName, call.toolCallId);
}

/** Whether a Gemini CLI tool call id names `wireName` on `serverName`. */
export function geminiToolNameMatches(
  serverName: string,
  wireName: string,
  toolCallId: string,
): boolean {
  const prefix = `mcp_${serverName}_`;
  const end = toolCallId.lastIndexOf('__call_');
  if (!toolCallId.startsWith(prefix) || end < prefix.length) {
    return false;
  }
  const registered = toolCallId.slice(prefix.length, end);
  if (registered === wireName) {
    return true;
  }
  const gap = registered.indexOf('...');
  if (gap < 0) {
    return false;
  }
  const head = registered.slice(0, gap);
  const tail = registered.slice(gap + 3);
  return (
    wireName.length > head.length + tail.length &&
    wireName.startsWith(head) &&
    wireName.endsWith(tail)
  );
}

//#endregion

//#region Turn IO

/**
 * Why the agent stopped a turn. Derived from `PromptResponse` because the
 * protocol package inlines the union rather than exporting it by name.
 * @public
 */
export type AcpStopReason = acp.PromptResponse['stopReason'];

/** @public Input for one `session/prompt` turn. */
export interface AcpPromptOptions {
  /**
   * Prompt content blocks. Validated against the agent's advertised
   * `promptCapabilities` before sending — the spec requires clients to restrict
   * content types to what the agent accepts.
   */
  content: ReadonlyArray<acp.ContentBlock>;
  /** Aborting this signal issues `session/cancel` and awaits the `cancelled` stop reason. */
  signal?: AbortSignal;
}

/**
 * Result of a completed turn. The interpreter appends `items` to the item log,
 * charges `usage`/`cost`, records `stopReason`, and returns `text` (or parses it
 * through the step's output schema).
 * @public
 */
export interface AcpTurnResult {
  /** Why the agent stopped — drives the interpreter's success/error decision. */
  stopReason: AcpStopReason;
  /** Noetic Items produced this turn (assistant message, tool calls, tool results). */
  items: Item[];
  /** The agent's final message: its text after the last tool call of the turn. */
  text: string;
  usage?: TokenUsage;
  cost?: number;
  /** Plan entries reported via `plan` updates, latest snapshot wins. */
  plan?: ReadonlyArray<acp.PlanEntry>;
  /** Slash commands the agent advertised during the turn. */
  availableCommands?: ReadonlyArray<acp.AvailableCommand>;
  /** Mode the session ended the turn in, when the agent reports modes. */
  currentModeId?: string;
}

//#endregion

//#region Session + connection

/** @public Options for creating a session. */
export interface AcpNewSessionOptions {
  /** Absolute working directory for the session. */
  cwd: string;
  /** MCP servers the agent should connect to, gated by its `mcpCapabilities`. */
  mcpServers?: ReadonlyArray<acp.McpServer>;
}

/** @public Options for resuming a previously created session via `session/load`. */
export interface AcpLoadSessionOptions extends AcpNewSessionOptions {
  sessionId: string;
}

/**
 * One ACP session: a conversation with its own history and state, living on the
 * far side of a connection.
 * @public
 */
export interface AcpSession {
  readonly sessionId: string;
  /** Mode state when the agent supports session modes. */
  readonly modes?: acp.SessionModeState;
  /** Slash commands currently offered, refreshed by `available_commands_update`. */
  readonly availableCommands: ReadonlyArray<acp.AvailableCommand>;
  /** Run one prompt turn to completion. */
  prompt(opts: AcpPromptOptions): Promise<AcpTurnResult>;
  /** Send `session/cancel` for an in-flight turn. */
  cancel(): Promise<void>;
  /** Switch mode. Throws when the agent advertised no modes. */
  setMode(modeId: string): Promise<void>;
  /** Switch model. Throws when the agent advertised no models. */
  setModel(modelId: string): Promise<void>;
}

/**
 * A negotiated connection to an ACP agent — one `initialize` handshake and one
 * transport, able to carry several sessions.
 * @public
 */
export interface AcpAgentConnection {
  /** Everything the agent advertised during `initialize`. */
  readonly agentCapabilities: acp.AgentCapabilities;
  /** Authentication methods the agent offers, empty when it needs none. */
  readonly authMethods: ReadonlyArray<acp.AuthMethod>;
  /** Protocol version agreed with the agent. */
  readonly protocolVersion: number;
  /** Run the `authenticate` flow for one of {@link authMethods}. */
  authenticate(methodId: string): Promise<void>;
  /** Create a session (`session/new`). */
  newSession(opts: AcpNewSessionOptions): Promise<AcpSession>;
  /**
   * Resume a session (`session/load`). Throws {@link AcpCapabilityError} when
   * the agent did not advertise `loadSession`.
   */
  loadSession(opts: AcpLoadSessionOptions): Promise<AcpSession>;
  /** Close the connection and release the transport. */
  close(): Promise<void>;
}

/**
 * A live connection plus the session running on it. The runtime keeps these
 * keyed by {@link AcpSessionPolicy.reuse} so a session can span several steps.
 * @public
 */
export interface AcpLiveSession {
  connection: AcpAgentConnection;
  session: AcpSession;
  /**
   * The host this connection was opened with. The runtime rebinds its
   * per-turn fields before every turn, so a session shared by several steps
   * honours each step's own permissions, steering, and event stream.
   */
  host: AcpClientHost;
  /** `agentId` of the adapter that opened this connection, for reuse conflict checks. */
  agentId: string;
  /** How long this connection is kept alive; decides who closes it and when. */
  keepAlive: AcpKeepAlive;
  /** Working directory the session was created in — fixed for its lifetime. */
  cwd: string;
  /** MCP servers attached at creation — also fixed for its lifetime. */
  mcpServers?: ReadonlyArray<acp.McpServer>;
  /** Noetic tools served to the agent at creation — also fixed for its lifetime. */
  tools?: ReadonlyArray<AcpTool>;
}

/** @public Options handed to {@link AcpAgent.connect}. */
export interface AcpConnectOptions {
  /** The runtime surface backing client-side ACP methods. */
  host: AcpClientHost;
  signal?: AbortSignal;
  /**
   * The MCP servers the step will attach. Agents that must declare servers at
   * launch (to give the tool bridge its settings) read them here; every other
   * agent receives them in `session/new` as usual.
   */
  mcpServers?: ReadonlyArray<acp.McpServer>;
}

/**
 * An ACP agent adapter. `@noetic-tools/acp` exports presets (`claudeCode()`,
 * `codex()`, `gemini()`, `customAcpAgent()`) that return one of these.
 * @public
 */
export interface AcpAgent {
  /** Spec tag for forward-compatibility. */
  readonly specificationVersion: 'acp-v1';
  /**
   * Stable identifier for the agent (`'claude-code'`, `'codex'`, …). Free-form:
   * the set of agents is open, and this is only used for registry lookup,
   * observability, and error messages.
   */
  readonly agentId: string;
  /** Open a transport, run `initialize`, and return the negotiated connection. */
  connect(opts: AcpConnectOptions): Promise<AcpAgentConnection>;
  /**
   * Why this agent cannot take tools — an agent attached through a transport
   * the bridge cannot reach, or Gemini CLI in a folder it does not trust. A
   * step that gives it `tools` fails with this error before anything spawns.
   * Otherwise `connect` serves {@link AcpClientHost.tools} to the agent.
   */
  readonly refusesTools?: AcpToolRefusal;
  /**
   * Starts a process on the machine this agent runs on and carries its stdio
   * back. A stdio `mcp()` server in the step's `tools` starts through it, so
   * it runs where the agent runs while noetic stays its MCP client. Absent
   * for an agent attached through a transport, which names no machine.
   */
  readonly spawn?: Spawn;
}

/**
 * Why an agent cannot take tools, and the fix it is missing.
 * @public
 */
export interface AcpToolRefusal {
  readonly code:
    | 'ACP_TRANSPORT_CANNOT_REACH'
    | 'ACP_TRANSPORT_CANNOT_LAUNCH'
    | 'ACP_AGENT_CANNOT_TAKE_TOOLS';
  /** Completes "the agent cannot take tools: …". */
  readonly reason: string;
  readonly hint: string;
}

//#endregion

//#region Session policy

/**
 * Controls how an ACP connection is reused and torn down across steps.
 * @public
 */
/**
 * How long an ACP connection outlives the step that opened it.
 *
 * A connection owns a live agent — usually a child process whose stdio keeps
 * the event loop alive — so keeping one is never inferred. Every level beyond
 * the default is something the step asks for explicitly.
 * @public
 */
export const AcpKeepAlive = {
  /** Closed when the step finishes. The default. */
  Step: 'step',
  /** Kept for the rest of the root run, then closed by the harness. */
  Run: 'run',
  /** Kept until {@link AcpSessionDisposer.closeAcpSessions} is called. Nothing closes it for you. */
  Harness: 'harness',
} as const;

/** @public Union of connection keep-alive scopes. */
export type AcpKeepAlive = (typeof AcpKeepAlive)[keyof typeof AcpKeepAlive];

/**
 * Controls how an ACP connection is shared and how long it is kept alive.
 * @public
 */
export interface AcpSessionPolicy {
  /**
   * Share one live connection + session under this id, so later steps take
   * their turns against the same agent. Requires {@link keepAlive} `'run'` or
   * `'harness'` — a connection closed at the end of its step has nothing left
   * to share.
   */
  reuse?: string;
  /**
   * How long to keep the connection alive. Defaults to `'step'`: the
   * connection is closed as soon as the step finishes, so nothing is
   * maintained unless the step says so.
   *
   * `'harness'` hands ownership to the caller — the runtime will not close it,
   * and an undisposed connection keeps the host process from exiting. Call
   * `harness.closeAcpSessions()` when the work is done.
   */
  keepAlive?: AcpKeepAlive;
  /**
   * Resume this ACP session id via `session/load` instead of creating a new one.
   * Requires the agent's `loadSession` capability.
   */
  load?: string;
}

/**
 * A snapshot of one live ACP sub-agent — what a UI needs to show it and offer
 * actions on it, without handing out the connection itself.
 * @public
 */
export interface AcpSessionInfo {
  /** Opaque handle for this session — pass it back to `getAcpSession`/`cancelAcpSession`. */
  key: string;
  /** The `session.reuse` key the step named, when it named one. */
  reuseKey?: string;
  /** `agentId` of the adapter driving it. */
  agentId: string;
  /** The agent's own session id. */
  sessionId: string;
  keepAlive: AcpKeepAlive;
  /** Current mode, when the agent supports modes. */
  currentModeId?: string;
  /** Modes the agent offers, for a mode switcher. */
  availableModes: ReadonlyArray<acp.SessionMode>;
  /** Slash commands the agent currently advertises. */
  availableCommands: ReadonlyArray<acp.AvailableCommand>;
}

/**
 * The disposal surface for connections kept past their run. Implemented by
 * `AgentHarness`; declared here so callers can hold the capability without
 * depending on the concrete runtime.
 * @public
 */
export interface AcpSessionDisposer {
  /** Close every ACP connection this harness still holds. Idempotent. */
  closeAcpSessions(): Promise<void>;
}

//#endregion

//#region Document grants

/**
 * @public
 * The most a document's `acp-agent` nodes may ask of each agent, keyed by
 * agent id (`dynamicWorkflow({ acp })`, `parseAndRunWorkflow({ acp })`). An
 * agent without an entry gets the defaults each field names. A node asking for
 * more fails validation with `CONNECTION_NOT_ALLOWED`.
 */
export type AcpAllowlist = Readonly<Record<string, AcpAgentGrant>>;

/** @public The most a document's `acp-agent` nodes may ask of one agent. */
export interface AcpAgentGrant {
  /** The widest `permissions` policy a node may set. Default: a node may only deny. */
  readonly permissions?: AcpPermissionGrant;
  /**
   * The absolute directory a node's `cwd` must be or sit under. Default: the
   * harness's working directory.
   */
  readonly cwd?: string;
  /**
   * The client capabilities a node may turn on. A capability the node leaves
   * out takes the grant's value. Default: `{ readTextFile: true }`.
   */
  readonly clientCapabilities?: AcpCapabilityGrant;
  /** How a node may keep and resume sessions. Default: `keepAlive` up to `'run'`, no `load`. */
  readonly session?: AcpSessionGrant;
  /**
   * The session modes a node may set. A mode can lift the agent's own
   * permission prompts (`bypassPermissions`, `acceptEdits`), so the default is
   * none: a node may not set `mode`.
   */
  readonly modes?: ReadonlyArray<string>;
  /** The models a node may select. Default: any, since a model changes no permission. */
  readonly models?: ReadonlyArray<string>;
}

/** @public The widest permission policy a node may set. */
export interface AcpPermissionGrant {
  /** `'allow'` lets a node set `default: 'allow'`; anything else lets it deny or cancel only. */
  readonly default?: AcpPermissionDecision;
  /**
   * Each of a node's `allow` rules must fall within one of these: the same
   * `kind` when this sets one, and a `title` containing this one when this
   * sets one. Default: none, so a node may set no `allow` rules.
   */
  readonly allow?: ReadonlyArray<{
    readonly kind?: acp.ToolKind;
    readonly title?: string;
  }>;
  /** Lets a node set `persist`. */
  readonly persist?: boolean;
}

/** @public The client capabilities a node may turn on. Each defaults to off. */
export interface AcpCapabilityGrant {
  readonly readTextFile?: boolean;
  readonly writeTextFile?: boolean;
  readonly terminal?: boolean;
}

/**
 * @public
 * How a node may keep and resume sessions. A document's sessions never join
 * the host's: their `reuse` keys live in a namespace of their own, one per run
 * of the document. That namespace dies with the run, so a node may keep a
 * session no longer than `'run'`: a `'harness'` session would only leak its
 * agent process.
 */
export interface AcpSessionGrant {
  /** The longest `keepAlive` a node may set. Default: `'run'`. */
  readonly keepAlive?: Exclude<AcpKeepAlive, 'harness'>;
  /** Lets a node resume an agent session by id with `session.load`. */
  readonly load?: boolean;
}

//#endregion

//#region Errors

/**
 * Thrown when an ACP agent is asked for a capability it did not advertise
 * during `initialize` — loading a session, switching mode, sending image
 * content. Raised before anything reaches the wire.
 * @public
 */
export class AcpCapabilityError extends Error {
  readonly agentId: string;
  readonly capability: string;

  constructor(opts: {
    agentId: string;
    capability: string;
    message?: string;
  }) {
    super(
      opts.message ??
        `ACP agent '${opts.agentId}' did not advertise the '${opts.capability}' capability.`,
    );
    this.name = 'AcpCapabilityError';
    this.agentId = opts.agentId;
    this.capability = opts.capability;
  }
}

/** @public Type guard for {@link AcpCapabilityError}. */
export function isAcpCapabilityError(e: unknown): e is AcpCapabilityError {
  return e instanceof AcpCapabilityError;
}

/**
 * Thrown when a connection cannot be established — the agent binary is missing,
 * the handshake fails, or authentication is required and unsatisfied.
 * @public
 */
export class AcpConnectError extends Error {
  readonly agentId: string;
  readonly connectCause?: unknown;

  constructor(opts: {
    agentId: string;
    message: string;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = 'AcpConnectError';
    this.agentId = opts.agentId;
    this.connectCause = opts.cause;
  }
}

/** @public Type guard for {@link AcpConnectError}. */
export function isAcpConnectError(e: unknown): e is AcpConnectError {
  return e instanceof AcpConnectError;
}

//#endregion

//#region Re-exported protocol types

/**
 * The ACP protocol surface, re-exported so consumers get the wire types without
 * taking a direct dependency on the protocol package.
 * @public
 */
export type {
  AgentCapabilities as AcpAgentCapabilities,
  AuthMethod as AcpAuthMethod,
  AvailableCommand as AcpAvailableCommand,
  ContentBlock as AcpContentBlock,
  McpServer as AcpMcpServer,
  PermissionOption as AcpPermissionOption,
  PlanEntry as AcpPlanEntry,
  PromptCapabilities as AcpPromptCapabilities,
  RequestPermissionRequest as AcpRequestPermissionRequest,
  SessionMode as AcpSessionMode,
  SessionModeState as AcpSessionModeState,
  SessionNotification as AcpSessionNotification,
  ToolCallContent as AcpToolCallContent,
  ToolCallStatus as AcpToolCallStatus,
  ToolKind as AcpToolKind,
} from '@zed-industries/agent-client-protocol';

//#endregion
