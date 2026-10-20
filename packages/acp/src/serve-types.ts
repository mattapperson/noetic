/**
 * Public types for the server direction: serving a Noetic harness *as* an ACP
 * agent (spec 31). The adapter drives any harness through `AcpServeHarness`, a
 * structural subset of `AgentHarnessContract` — the same pattern
 * `@noetic-tools/chat-sdk` uses — so this package keeps depending only on
 * `@noetic-tools/types`.
 */

import type {
  AcpMcpServer,
  AcpToolKind,
  ExecuteInput,
  ExecuteOptions,
  FsAdapter,
  Item,
  SessionScope,
  ShellAdapter,
  StreamEvent,
  StreamingItem,
  ToolAcpDeclaration,
} from '@noetic-tools/types';
import type * as acp from '@zed-industries/agent-client-protocol';

//#region Harness contract

/**
 * The slice of `AgentHarnessContract` the ACP server drives. Any harness (or
 * structural stand-in, in tests) satisfying this can be served.
 * @public
 */
export interface AcpServeHarness {
  execute(input: ExecuteInput, options?: ExecuteOptions): Promise<void>;
  getFullStream(scope?: SessionScope): AsyncIterable<StreamEvent>;
  getItemStream(scope?: SessionScope): AsyncIterable<StreamingItem>;
  seedSessionHistory(threadId: string, items: ReadonlyArray<Item>): void;
  abort(
    scope?: SessionScope & {
      reason?: string;
    },
  ): Promise<void>;
}

/**
 * What a per-session harness factory receives when the client opens a session.
 * @public
 */
export interface AcpServeSessionInit {
  /** The minted ACP session id — also the harness `threadId`. */
  sessionId: string;
  /** Absolute working directory the client established for the session. */
  cwd: string;
  /** MCP servers the client asked the agent to connect to (not yet mounted; see spec 31 Future Considerations). */
  mcpServers: ReadonlyArray<AcpMcpServer>;
  /**
   * Adapters backed by the ACP client's own `fs/*` and `terminal/*` methods,
   * built from the capabilities it advertised. Wire them into the harness's
   * `environment` and the agent sees unsaved editor buffers instead of disk.
   * Operations the client did not advertise (or the wire cannot express)
   * reject with `AcpCapabilityError`.
   */
  client: {
    fs: FsAdapter;
    shell: ShellAdapter;
    capabilities?: acp.ClientCapabilities;
  };
}

/**
 * A harness shared across sessions, or a factory called once per
 * `session/new` for per-session cwd/adapters isolation.
 * @public
 */
export type AcpServeHarnessSource =
  | AcpServeHarness
  | ((session: AcpServeSessionInit) => AcpServeHarness | Promise<AcpServeHarness>);

//#endregion

//#region Permissions

/** @public What the policy says about one first-party tool. */
export type AcpServePermissionDecision = 'allow' | 'ask' | 'deny';

/**
 * One policy rule, matched on the tool's name or its declared ACP kind.
 * A rule naming both matches when either does.
 * @public
 */
export interface AcpServePermissionRule {
  tool?: string;
  kind?: AcpToolKind;
  decision: AcpServePermissionDecision;
}

/**
 * Declarative gate over first-party tool calls. Decisions are checked in
 * order `deny` → `ask` → `allow`, so an explicit refusal beats a required
 * ask, which beats a broad grant. The default is **`allow`** — deliberately
 * the opposite of the client direction's `deny`: the harness author curated
 * every tool on the harness, and the editor user is supervising work they
 * initiated, not sandboxing a stranger.
 * @public
 */
export interface AcpServePermissionPolicy {
  default?: AcpServePermissionDecision;
  rules?: ReadonlyArray<AcpServePermissionRule>;
  /**
   * How long an `ask` waits for the client's answer, in milliseconds.
   * Defaults to 5 minutes. On expiry the call is denied — waiting must not
   * become approval.
   */
  askTimeoutMs?: number;
}

/** @public A permission ask on its way to the client (or an embedding host). */
export interface AcpServePermissionPrompt {
  /** Correlates the answer with this ask. */
  requestId: string;
  /** The ACP session (= harness thread) the call belongs to. */
  sessionId: string;
  /** The tool's machine name. */
  toolName: string;
  /** The pending call's id — the same id its `tool_call` notification carries. */
  callId?: string;
  /** Presentation title resolved from the tool's `acp` declaration. */
  title: string;
  /** Declared ACP kind, when the tool has one. */
  kind?: AcpToolKind;
  /** Parsed tool arguments. */
  args?: unknown;
}

/** @public The answer to an {@link AcpServePermissionPrompt}. */
export interface AcpServePermissionReply {
  decision: 'allow' | 'deny' | 'cancel';
  reason?: string;
}

//#endregion

//#region Commands and history

/** @public Session context handed to a slash command's `run`. */
export interface AcpServeCommandContext {
  sessionId: string;
  cwd: string;
}

/**
 * A slash command advertised to the client as `availableCommands`. A prompt
 * beginning with `/name` routes to `run`, whose return value becomes the
 * turn's input; a command without `run` forwards its text unchanged.
 * @public
 */
export interface AcpServeCommand {
  name: string;
  description: string;
  /** Hint shown by clients for the command's free-text argument. */
  inputHint?: string;
  run?(argsText: string, ctx: AcpServeCommandContext): string | Item[] | Promise<string | Item[]>;
}

/**
 * Two-method persistence seam. Providing it advertises the `loadSession`
 * capability: `session/load` seeds the harness from `load` and replays the
 * conversation to the client, and every completed item is appended through
 * `save` as it streams.
 * @public
 */
export interface AcpServeHistory {
  load(sessionId: string): Promise<ReadonlyArray<Item> | null>;
  save(sessionId: string, item: Item): Promise<void>;
}

//#endregion

//#region Options

/** @public A tool's name plus its ACP presentation, for `AcpServeOptions.tools`. */
export interface AcpPresentableTool {
  name: string;
  acp?: ToolAcpDeclaration;
}

/** @public Options for `toAcpAgent` / `serveAcp`. */
export interface AcpServeOptions {
  /**
   * The harness's tools (or any subset), read for their `acp` presentation
   * declarations. Pass the same array the harness was built with; an
   * undeclared or unlisted tool renders as kind `other` with its name as the
   * title.
   */
  tools?: ReadonlyArray<AcpPresentableTool>;
  /** Declarative gate over first-party tool calls. Absent: everything is allowed. */
  permissions?: AcpServePermissionPolicy;
  /**
   * Answer permission asks in-process instead of forwarding them to the ACP
   * client over the wire — the hatch for hosts that embed the server and own
   * their own approval surface.
   */
  onPermissionRequest?(prompt: AcpServePermissionPrompt): Promise<AcpServePermissionReply>;
  /** Persistence seam; presence advertises `loadSession`. */
  history?: AcpServeHistory;
  /** Slash commands advertised to the client. */
  commands?: ReadonlyArray<AcpServeCommand>;
}

//#endregion
