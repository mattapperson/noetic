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
import type { FsAdapter } from './fs-adapter';
import type { Item } from './items';
import type { ShellAdapter } from './shell-adapter';

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
export interface AcpTransport {
  /** Frames arriving from the agent. */
  readonly readable: ReadableStream<Uint8Array>;
  /** Frames sent to the agent. */
  readonly writable: WritableStream<Uint8Array>;
  /** Tear the stream down and release the underlying resource (process, socket, …). */
  close(): Promise<void>;
}

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
 * @public
 */
export type AcpPermissionHandler = (
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
  onPermissionRequest?: AcpPermissionHandler;
  /**
   * Receive every `session/update` notification for the active session. Also
   * per-turn — it routes to the running step's event bridge, so a reused
   * session's output is attributed to the step that actually asked for it.
   */
  onSessionUpdate: (notification: acp.SessionNotification) => void;
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
  /** Concatenated assistant text of the turn. */
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
}

/** @public Options handed to {@link AcpAgent.connect}. */
export interface AcpConnectOptions {
  /** The runtime surface backing client-side ACP methods. */
  host: AcpClientHost;
  signal?: AbortSignal;
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
}

//#endregion

//#region Session policy

/**
 * Controls how an ACP connection is reused and torn down across steps.
 * @public
 */
export interface AcpSessionPolicy {
  /**
   * Reuse a live connection + session keyed by this id across steps. When
   * omitted, each step gets a fresh session that is closed on completion.
   */
  reuse?: string;
  /**
   * Lifecycle action when the step completes. `'close'` ends the connection and
   * stops the agent; `'keep'` leaves it live for a later step. Defaults to
   * `'close'` for a fresh session and `'keep'` for a reused one.
   *
   * `'keep'` is scoped to the run: the harness closes every session it still
   * holds when the root run finishes. A connection owns a live agent process,
   * so one held past its run would keep the host from exiting.
   */
  onComplete?: 'close' | 'keep';
  /**
   * Resume this ACP session id via `session/load` instead of creating a new one.
   * Requires the agent's `loadSession` capability.
   */
  load?: string;
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
