/**
 * The connection registry contract inside core (spec 35 § Connection registry).
 *
 * Steps, tools and documents never hold a provider's `Connection`. They resolve
 * connections by name through the harness registry when they run; the registry
 * wraps each one with the gates, refs, blobs, secrets, identity tracking,
 * reconnection and pool leases, so a step that runs after a reconnect uses the
 * new connection and nothing reaches a server around the harness.
 *
 * This file is the seam between the slices that implement connection steps,
 * verification and the registry itself: they code against these types.
 */

import type {
  AnyProfile,
  ConnectionEvent,
  ConnectionIdentity,
  ConnectionLease,
  ConnectionManifest,
  ConnectionRequirement,
  ConnectionStatus,
  ConnectionTaskStatus,
  Context,
  EventStream,
  FreshScope,
} from '@noetic-tools/types';

//#region Types

/** Who is calling: the gates differ only in what each may use (secrets never from the model). */
export type ConnectionCaller = 'model' | 'step' | 'document';

/** Where a resolution happens: identifies the lease scope and the thread refs are sealed to. */
export interface ConnectionScope {
  readonly executionId: string;
  /** Refs are sealed to this thread; spawned children and parallel paths share their parent's. */
  readonly threadId: string;
  /**
   * The lease holder for a fresh connection: the run id for `fresh: 'run'`, the
   * parallel path key for `fresh: 'path'`. Released by `releaseScope`.
   */
  readonly scopeKey: string;
  readonly signal: AbortSignal;
}

/** One request to resolve a connection by name. */
export interface ResolveRequest {
  /** A harness connection name (after document `bindings` are applied). */
  readonly name: string;
  readonly scope: ConnectionScope;
  /** What the caller needs; checked at negotiation. Absent for model tools. */
  readonly requirement?: ConnectionRequirement;
  /** Draw a fresh connection from the pool `from` (default `name`) for this scope. */
  readonly fresh?: FreshScope;
  readonly from?: string;
  /** Passed to the pool's provider; `hostOnly` fields are refused (`CONNECTION_NOT_ALLOWED`). */
  readonly setup?: Readonly<Record<string, unknown>>;
  /** The profile the handle names: ref kinds, parent ranges, setup schema and host-only fields. */
  readonly profile?: AnyProfile;
  /** The context resolving it, so gates and framework events reach its run. */
  readonly ctx?: Context;
}

/** Options for one gated call. */
export interface GatedCallOptions {
  readonly signal: AbortSignal;
  readonly caller: ConnectionCaller;
  /** Derived from the run and the step's ledger key, or the turn and tool call id. */
  readonly idempotencyKey: string;
  readonly stepId?: string;
  readonly toolCallId?: string;
  /**
   * For steps and documents: the operations the handle or manifest declares
   * (gate 1). Absent for model tools, which may call anything exposed.
   */
  readonly declaredOps?: ReadonlyArray<string>;
  /**
   * For documents: the secrets the node's arguments write out, each with the
   * dotted field it fills. A document call sending any other secret (one an
   * expression produced) is refused — it was never checked against the allowlist.
   */
  readonly documentSecrets?: ReadonlyArray<{
    readonly name: string;
    readonly field: string;
  }>;
  /** Progress of a long operation, also emitted as `connection_task`. */
  readonly onTask?: (status: ConnectionTaskStatus) => void;
  /**
   * The calling context: gate 5 runs its `beforeToolCall` layers and passes it
   * to the harness approver, and framework events reach its stream.
   */
  readonly ctx?: Context;
}

/**
 * A connection as steps and tools see it. Every method runs through the
 * registry: gates 1–6 on `call`, ref sealing/unsealing, secret resolution and
 * redaction, blob storage, and long-operation waiting.
 *
 * `call` throws `NoeticErrorImpl` with kind `steering_denied` (a gate refused),
 * `connection_failed`, `connection_unavailable`, `connection_ref_invalid`,
 * `connection_secret_refused` or `connection_input_required`.
 */
export interface ResolvedConnection {
  /** The harness connection name. */
  readonly name: string;
  readonly manifest: ConnectionManifest;
  /** The current identity; changes when the thing is replaced. */
  identity(): ConnectionIdentity;
  /** Present when this resolution holds a pool lease. */
  readonly lease?: ConnectionLease;
  /** Runs one operation and returns its output, waiting on long operations. */
  call(op: string, args: unknown, opts: GatedCallOptions): Promise<unknown>;
  read(
    resource: string,
    opts: {
      signal: AbortSignal;
    },
  ): Promise<unknown>;
  /** Listens in memory; events arrive stamped with `connection`, buffered up to `WAIT_BUFFER_LIMIT`. */
  listen(req: {
    event: string;
    arguments?: Readonly<Record<string, unknown>>;
    cursor?: string | null;
    signal: AbortSignal;
  }): EventStream<ConnectionEvent>;
  /** Resets the connection (`determinism.reset` not `'none'`). */
  reset?(opts: { signal: AbortSignal }): Promise<void>;
  /**
   * Waits on a long operation a previous attempt started (`taskId` from its
   * pending entry) instead of sending it again, with the same output handling
   * as `call` (spec 35 § Durability).
   */
  awaitTask?(taskId: string, op: string, opts: GatedCallOptions): Promise<unknown>;
}

/** The harness's connection registry. */
export interface ConnectionRegistry {
  /** Harness connection names, pools included. */
  names(): ReadonlyArray<string>;
  /**
   * Resolves a connection by name.
   *
   * @throws NoeticConfigError `CONNECTION_UNKNOWN` for an unknown name,
   * `ConnectionUnsatisfiedError` (`CONNECTION_UNSATISFIED`) when `requirement` is not met,
   * `CONNECTION_NOT_ALLOWED` for a host-only setup field;
   * NoeticErrorImpl `connection_unavailable` when it is down or its pool stayed full past `waitMs`.
   */
  resolve(request: ResolveRequest): Promise<ResolvedConnection>;
  /** Returns every lease a scope holds to its pool. */
  releaseScope(scopeKey: string): Promise<void>;
  /**
   * Returns every lease a run holds: its `fresh: 'run'` lease (scope key = the
   * root context id) and each of its `fresh: 'path'` leases (`<rootId>:path:<id>`).
   */
  releaseRun(rootId: string): Promise<void>;
  /** Stops renewing a failed run's leases so they are reclaimed unless a resume takes them back. */
  orphanRun?(rootId: string): void;
  /** `harness.getConnectionStatus(name?)`. */
  status(name?: string): ReadonlyArray<ConnectionStatus>;
  /** Whether `harness.restore(executionId, { rerun })` named connection `name`. */
  rerunAllowed?(executionId: string, name: string): boolean;
}

//#endregion
