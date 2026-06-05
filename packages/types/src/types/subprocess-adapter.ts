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
 * Launches an OS-level child process. This is the classic variant used by the
 * tasks runner to spawn planner / implementer children.
 *
 * When `kind` is omitted the request is treated as a process request — this
 * preserves backward compatibility with callers that predate the
 * `StepSubprocessRequest` variant.
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
 * registry via a configured entry point.
 */
export interface StepSubprocessRequest extends SubprocessRequestBase {
  kind: 'step';
  stepId: string;
  /** Serialisable input for the step. Stored in `handle.metadata` when needed. */
  serializedInput: unknown;
  /** Stable id for the execution — used for handle lookup and durable checkpointing. */
  executionId: string;
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
}

/** @public Handle returned by `SubprocessAdapter.spawn()` — a durable reference to a child. */
export interface SubprocessHandle {
  id: string;
  status: SubprocessStatus;
  startedAt: string;
  updatedAt?: string;
  metadata?: SubprocessHandleMetadata;
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

/**
 * @public
 * Contract for dispatching and managing subprocess-style executions — both
 * OS-level child processes and in-process step runs. Implementations own the
 * lifecycle of every handle they return, including persistence when they opt
 * into durable execution via `reattach` / `listLive`.
 */
export interface SubprocessAdapter {
  /** Dispatches a new request and returns its handle. */
  spawn(request: SubprocessRequest): Promise<SubprocessHandle>;
  /** Fetches the current handle by id, or `null` when unknown. */
  get(handleId: string): Promise<SubprocessHandle | null>;
  /** Requests cancellation of a running handle. */
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
}

//#endregion
