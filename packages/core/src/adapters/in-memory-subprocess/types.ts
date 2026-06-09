import type { StorageAdapter } from '@noetic-tools/memory';
import type {
  ProcessSubprocessRequest,
  StepSubprocessRequest,
  SubprocessHandle,
  SubprocessHandleMetadata,
  SubprocessRequest,
} from '@noetic-tools/types';

//#region Factory options

/**
 * @public
 * Options for `createInMemorySubprocessAdapter`. All hooks are optional;
 * when none is provided the adapter still handles `spawn` + `stop` +
 * lifecycle transitions for test-double purposes.
 */
export interface CreateInMemorySubprocessAdapterOptions {
  /**
   * Invoked for `kind: 'process'` requests (the classic test-double hook).
   * When absent the adapter marks the handle `completed` on the next
   * microtask without running any body.
   */
  run?: (request: SubprocessRequest, handle: SubprocessHandle) => Promise<void>;
  /**
   * Invoked for `kind: 'step'` requests that do not already carry a
   * `_localExecutor` closure. Callers swap this out to simulate step
   * execution in tests; the default harness-bound adapter provides an
   * implementation that invokes the in-process execute pipeline.
   */
  stepRunner?: (request: StepSubprocessRequest, handle: SubprocessHandle) => Promise<unknown>;
  /**
   * Optional synchronous metadata injector. Called during `spawn()` before
   * the handle is returned, its result is merged on top of the adapter's
   * intrinsic metadata (runtime, command/args/cwd, etc.). Use this to stamp
   * pid / pidStarttime / test-only fields without having to wrap the adapter.
   *
   * Keys returned here win over the adapter's defaults — tests can override
   * `runtime` if they need to simulate a different adapter variant.
   */
  metadataInjector?: (request: SubprocessRequest) => Partial<SubprocessHandleMetadata>;
  /**
   * Optional `StorageAdapter` that gives the in-memory adapter a durable
   * handle manifest. When supplied, `spawn()` persists a manifest per
   * handle and `reattach(handleId)` / `listLive()` consult it across adapter
   * restarts. When absent the adapter is purely ephemeral — matching the
   * test-double semantics established in Phase A.
   *
   * For in-memory the "reattached" handle is an idempotent re-run of the
   * step from the persisted `serializedInput`. We're honest about that in
   * the manifest (`reattachMode: 'replay'`) — this is the sanest in-memory
   * semantic because there is no long-lived process to bind back to.
   */
  storage?: StorageAdapter;
}

//#endregion

//#region Completion params

export interface CompleteProcessRunParams {
  request: ProcessSubprocessRequest;
  handle: SubprocessHandle;
  run: CreateInMemorySubprocessAdapterOptions['run'];
  handles: Map<string, SubprocessHandle>;
  active: Set<string>;
  save: (handle: SubprocessHandle) => Promise<SubprocessHandle>;
  /** Invoked on terminal transitions so the durable handle manifest
   *  does not linger after the step is done — otherwise `listLive()`
   *  would return phantom handles for every step ever completed
   *  against this storage. No-op when no storage was configured. */
  clearIfDurable: (handleId: string) => Promise<void>;
}

export interface CompleteStepRunParams {
  request: StepSubprocessRequest;
  handle: SubprocessHandle;
  stepRunner: CreateInMemorySubprocessAdapterOptions['stepRunner'];
  handles: Map<string, SubprocessHandle>;
  active: Set<string>;
  save: (handle: SubprocessHandle) => Promise<SubprocessHandle>;
  /** See `CompleteProcessRunParams.clearIfDurable`. */
  clearIfDurable: (handleId: string) => Promise<void>;
}

//#endregion

//#region Manifest

/**
 * Persistable manifest for an in-memory handle. Written to the
 * StorageAdapter on spawn and cleared on stop — a restart can list live
 * handles via this prefix and re-run the step from `serializedInput`.
 *
 * Scoped to `step`-kind requests because `process`-kind handles carry no
 * replayable body (they represent already-launched OS processes whose state
 * is not ours to recreate).
 */
export interface InMemoryStepManifest {
  kind: 'step';
  handleId: string;
  stepId: string;
  executionId: string;
  serializedInput: unknown;
  overrides: StepSubprocessRequest['overrides'];
  startedAt: string;
  reattachMode: 'replay';
}

//#endregion
