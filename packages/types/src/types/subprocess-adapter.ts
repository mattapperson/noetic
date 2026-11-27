import type { AdapterSet } from './adapter-set';

//#region Status

/** @public Lifecycle states for a subprocess handle. */
export type SubprocessStatus =
  | 'starting'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'stale';

//#endregion

//#region Serialized error

/**
 * @public
 * Plain-object shape used to transport an error from a subprocess back to the
 * parent via `SubprocessHandle.metadata.error`. Non-serialisable fields (e.g.
 * `Error.cause` chains with functions or cyclic data) are dropped at the
 * producer boundary.
 */
export interface SerializedError {
  /** Human-readable message; always present. */
  message: string;
  /** Constructor `name` of the underlying error (`Error`, `NoeticError`, etc.). */
  name?: string;
  /** Best-effort stack trace, when the producing runtime retained one. */
  stack?: string;
  /**
   * Structured `NoeticError` payload carried through for in-process
   * transport. Consumers may reconstruct `NoeticErrorImpl` from this when
   * they need typed error kinds.
   */
  noeticError?: unknown;
}

//#endregion

//#region Request variants

/** @public Fields common to every subprocess request variant. */
interface SubprocessRequestBase {
  metadata?: Record<string, unknown>;
}

/**
 * @public
 * Runs a command to completion. With `stdin` the adapter writes it, closes
 * the input and stores the command's stdout as the handle's `result` when it
 * exits 0; any other exit fails the handle. A request with no `kind` is a
 * process request.
 */
export interface ProcessSubprocessRequest extends SubprocessRequestBase {
  kind?: 'process';
  command: string;
  args?: ReadonlyArray<string>;
  cwd?: string;
  env?: Record<string, string | undefined>;
  detached?: boolean;
  stdin?: string;
}

/** @public Overrides applied to the child context when executing a step request. */
export interface StepSubprocessOverrides {
  /** Override the child's thread id. */
  threadId?: string;
  /** Override the child's resource id. */
  resourceId?: string;
  /** Override the child's initial cwd. */
  cwdInit?: string;
}

/**
 * @public
 * Dispatches a step through the adapter. `stepId` resolves against the shared
 * step registry — the in-memory adapter invokes the in-process execute pipeline,
 * while out-of-process adapters spawn a child runtime that re-imports the same
 * registry via a configured entry point. The far side therefore needs the
 * Noetic runtime and the program's code; an adapter that reaches only a
 * remote runner refuses the request with `NoeticConfigError`
 * `SUBPROCESS_RUNS_NO_STEPS`.
 */
export interface StepSubprocessRequest extends SubprocessRequestBase {
  kind: 'step';
  stepId: string;
  /** Serialisable input for the step. Stored in `handle.metadata` when needed. */
  serializedInput: unknown;
  /** Stable id for the execution — used for handle lookup and durable checkpointing. */
  executionId: string;
  /**
   * Id of the context that created this child (`spawn`, `detachedSpawn`).
   * Durable adapters persist it so a host can `harness.restore()` the parent
   * after a restart. Absent for a `runCode`, which runs on the dispatching
   * context itself.
   */
  parentExecutionId?: string;
  /** Child-context overrides (thread, resource, cwd). */
  overrides: StepSubprocessOverrides;
  /**
   * @internal
   * Closure used by the default in-memory adapter to run the step in the same
   * process as the caller. Non-serialisable — adapters that cross a process
   * boundary MUST ignore this field. Framework-internal callers set it; public
   * consumers should not.
   */
  _localExecutor?: () => Promise<unknown>;
}

/** @public Discriminated union covering every shape `SubprocessAdapter.spawn()` accepts. */
export type SubprocessRequest = ProcessSubprocessRequest | StepSubprocessRequest;

//#endregion

//#region Handle

/**
 * @public
 * Well-known keys carried on `SubprocessHandle.metadata`. Adapters populate
 * these during their lifecycle; consumers read them via the helpers exported
 * alongside the adapter types.
 */
export interface SubprocessHandleMetadata extends Record<string, unknown> {
  /** Awaited step result, stored when a step request completes successfully. */
  result?: unknown;
  /** Serialised error, stored when a step request fails. */
  error?: SerializedError;
  /** Execution id echoed from the originating `StepSubprocessRequest`. */
  executionId?: string;
  /** Parent execution id echoed from the originating `StepSubprocessRequest`. */
  parentExecutionId?: string;
}

/** @public A durable reference to a child, as `SubprocessAdapter.spawn()` reports it. */
export interface SubprocessHandle {
  id: string;
  status: SubprocessStatus;
  startedAt: string;
  updatedAt?: string;
  metadata?: SubprocessHandleMetadata;
}

/**
 * @public
 * What `SubprocessAdapter.spawn()` returns. `settled` resolves with the
 * handle in its final status (`completed`, `failed`, `stopped`, `stale`) the
 * moment the child finishes, so callers wait on the child instead of polling
 * `get()`. The adapter creates `settled` before the child can finish, so a
 * child that finishes at once still delivers its result.
 */
export interface SpawnedSubprocess {
  handle: SubprocessHandle;
  settled: Promise<SubprocessHandle>;
}

//#endregion

//#region Control results

/** @public Outcome of `pause` / `resume` calls on a subprocess handle. */
export type SubprocessControlResult =
  | {
      kind: 'ok';
      handle: SubprocessHandle;
    }
  | {
      kind: 'unsupported';
      handle: SubprocessHandle;
      message: string;
    }
  | {
      kind: 'not_found';
      handleId: string;
    };

/** @public Outcome of a `stop()` call on a subprocess handle. */
export interface SubprocessStopResult {
  kind: 'stopped' | 'not_found';
  handleId: string;
  handle?: SubprocessHandle;
}

//#endregion

//#region Adapter

/** @public A launch rejection that guarantees no child accepted the request. */
export class SubprocessLaunchError extends Error {
  override readonly name = 'SubprocessLaunchError';
}

/**
 * @public
 * Contract for dispatching and managing subprocess-style executions — both
 * OS-level child processes and in-process step runs. Implementations own the
 * lifecycle of every handle they return, including persistence when they opt
 * into durable execution via `reattach` / `listLive`.
 *
 * An adapter holds a handle only while its child runs. When the child
 * finishes, the adapter resolves the handle's `settled` promise and forgets
 * it: `get`, `stop`, `pause`, and `resume` then treat the id as unknown.
 */
export interface SubprocessAdapter {
  /**
   * Dispatch a request and return its handle and settlement promise.
   * Use `SubprocessLaunchError` for a refusal known to precede acceptance.
   * A generic rejection leaves acceptance uncertain and cannot trigger a launch retry.
   */
  spawn(request: SubprocessRequest): Promise<SpawnedSubprocess>;
  /** Fetches a running handle by id, or `null` once it has finished or when unknown. */
  get(handleId: string): Promise<SubprocessHandle | null>;
  /** Requests cancellation of a running handle; its `settled` resolves as `stopped`. */
  stop(handleId: string, reason?: string): Promise<SubprocessStopResult>;
  /** Pauses a running handle (when the adapter supports it). */
  pause(handleId: string): Promise<SubprocessControlResult>;
  /** Resumes a paused handle (when the adapter supports it). */
  resume(handleId: string): Promise<SubprocessControlResult>;
  /** Returns true when the underlying execution is still alive. */
  isAlive(handle: SubprocessHandle): Promise<boolean>;
  /**
   * Rebinds to a handle persisted across a host restart. Returns `null` when
   * no manifest exists for the given id. Durability is an adapter-level
   * concern — the in-memory adapter returns `null` by default (handles are
   * ephemeral), while the local adapter consults its storage.
   */
  reattach(handleId: string): Promise<SubprocessHandle | null>;
  /**
   * Lists every handle the adapter currently treats as live. Used by host
   * recovery to rediscover running children on startup. The in-memory adapter
   * returns the set of active in-process handles; the local adapter scans its
   * persisted manifest.
   */
  listLive(): Promise<ReadonlyArray<SubprocessHandle>>;
  /**
   * Opens a link to where this adapter's processes run: through it a caller
   * starts a process and holds its stdio. A process that outlived its host is
   * reached again through the link's `attach`. Absent on an adapter that
   * hands back no stdio.
   */
  open?: SubprocessOpen;
}

//#endregion

//#region Document grants

/**
 * @public
 * The most a document's `runCode` nodes may ask
 * (`dynamicWorkflow({ runCode })`, `parseAndRunWorkflow({ runCode })`). A
 * node asking for more fails validation with `CONNECTION_NOT_ALLOWED`.
 */
export interface RunCodeGrant {
  /**
   * The harness subprocess adapters a node may name. A name moves the code
   * to another host, so the default is none: a node runs on the default.
   */
  readonly subprocess?: ReadonlyArray<string>;
}

//#endregion

//#region Processes whose stdio the caller holds

/**
 * A duplex byte stream: a process's stdio, or a socket.
 * @public
 */
export interface ByteStream {
  /** Bytes arriving from the far end (a process's stdout). */
  readonly readable: ReadableStream<Uint8Array>;
  /** Bytes sent to the far end (a process's stdin). */
  readonly writable: WritableStream<Uint8Array>;
  /** Tear the stream down and release what holds it (process, socket, …). */
  close(): Promise<void>;
  /**
   * For a process's stdio: settles with its exit code once it has exited,
   * `null` when a signal ended it. Absent where the far end reports no exit.
   */
  readonly exited?: Promise<number | null>;
}

/** @public A process to start. */
export interface SpawnCommand {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  /**
   * Added to the environment where the process runs: for an agent
   * (`SubprocessLink.launch`) all of it; for an MCP server
   * (`SubprocessLink.spawn`, a `Spawn`) only the MCP SDK's default list
   * (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`), as the SDK starts a
   * local server.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Working directory where the process runs. */
  readonly cwd?: string;
}

/**
 * @public
 * Where a process may run: the harness's subprocess adapters, and the one a
 * step names among them.
 */
export interface SubprocessChoice {
  /** The harness's `environment.subprocess`. */
  readonly adapters: AdapterSet<SubprocessAdapter>;
  /** The adapter a step names. It comes before the one the process's owner names. */
  readonly name?: string;
}

/** @public What the caller of a {@link Spawn} knows about where processes run. */
export interface SpawnOptions {
  /**
   * A `Spawn` bound to no adapter of its own starts the process through the
   * named adapter, else the default. The one it lands on must have `open`.
   */
  readonly subprocess?: SubprocessChoice;
}

/**
 * Starts a process and returns its stdio as a byte stream: how a stdio MCP
 * server that must run where an ACP agent runs is started, with noetic still
 * its MCP client. `@noetic-tools/acp` implements it (`spawnOn(adapter)`,
 * `AcpAgent.spawn`); `@noetic-tools/mcp` takes it (`mcp({ command, spawn })`).
 * @public
 */
export type Spawn = (command: SpawnCommand, options?: SpawnOptions) => Promise<ByteStream>;

/**
 * The stdio of a process a {@link SubprocessLink} launched, which may outlive
 * its host: the byte stream an ACP agent's JSON-RPC frames ride on.
 * @public
 */
export type AcpTransport = ByteStream & {
  /**
   * Set when the agent behind this stream outlives the host and can be
   * reattached (a local agent run by its keeper). JSON, opaque outside the
   * package that made it.
   */
  readonly reattach?: AcpReattachHandle;
  /**
   * Let go of the agent without stopping it, as a host that goes away does,
   * so a later host can still reattach. Present only with {@link reattach}.
   * Closing the stream or its link afterwards leaves the agent running.
   */
  detach?(): Promise<void>;
};

/**
 * How to reach an agent that outlived its host: JSON a durable run stores with
 * the step and hands back to `AcpConnectOptions.reattach` on resume. Opaque to
 * everything but the package that made it.
 * @public
 */
export type AcpReattachHandle = Readonly<Record<string, unknown>>;

/**
 * What happens to an agent when its host goes away without closing it — a
 * crash, Ctrl-C, a killed process. `'keep'` (the default) keeps the agent
 * working and holds everything it sends until a host reattaches; `'stop'`
 * stops its whole process tree as soon as the host is gone.
 * @public
 */
export type AcpWhenHostExits = 'keep' | 'stop';

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

/** @public What {@link SubprocessAdapter.open} is given. */
export interface SubprocessOpenOptions {
  /** Aborting this signal closes the link. */
  signal?: AbortSignal;
  /** See {@link AcpWhenHostExits}. */
  whenHostExits?: AcpWhenHostExits;
}

/** @public {@link SubprocessAdapter.open}: opens one {@link SubprocessLink}. */
export type SubprocessOpen = (options: SubprocessOpenOptions) => Promise<SubprocessLink>;

/**
 * One link to where an adapter's processes run. Everything started through
 * it stops when it closes. An ACP connection opens one before its agent
 * starts: the tool bridge listens on the host's loopback interface, so the
 * link first carries it to where the agent can reach it (`reach`), then
 * starts the agent with launch settings that may name that address
 * (`launch`).
 * @public
 */
export interface SubprocessLink {
  /**
   * An address the agent can use to reach `bridge`. The same address when the
   * agent runs beside the host; a channel to it from anywhere else. A
   * non-loopback hop is TLS.
   */
  reach(bridge: ToolBridgeAddress): Promise<ToolBridgeAddress>;
  /**
   * Start a process that may outlive this host — an ACP agent — and return
   * its stdio. It gets the whole environment where it runs, plus `env`.
   */
  launch(command: SpawnCommand): Promise<AcpTransport>;
  /**
   * Start a process that lives no longer than the link — a stdio MCP server
   * beside an agent, a command run to completion — and carry its stdio back.
   * It gets the MCP SDK's default environment there plus `env`, as a local
   * MCP server does.
   */
  spawn: Spawn;
  /**
   * The stream to an agent an earlier host launched through this adapter,
   * which outlived it ({@link AcpTransport.reattach}). Rejects with
   * `AcpConnectError` when that agent is gone. Absent where agents never
   * outlive their host.
   */
  attach?(handle: AcpReattachHandle): Promise<AcpTransport>;
  /**
   * Release the link and everything started through it that it still holds:
   * not an agent whose stream was let go of ({@link AcpTransport.detach}).
   */
  close(): Promise<void>;
}

//#endregion
