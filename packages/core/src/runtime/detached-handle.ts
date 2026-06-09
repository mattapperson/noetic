import type {
  DetachedHandle,
  NoeticError,
  SerializedError,
  SubprocessAdapter,
  SubprocessHandle,
  SubprocessStatus,
} from '@noetic-tools/types';
import { DetachedStatus, frameworkCast, NoeticErrorImpl } from '@noetic-tools/types';

//#region Types

interface DetachedHandleOpts {
  /** Id surfaced to callers — usually the execution id (childCtx.id in
   *  `detachedSpawn`) so consumers can correlate it with their own state. */
  id: string;
  /** Step id — used when the adapter surfaces a generic failure and we need
   *  to produce a `NoeticError` with a meaningful `stepId`. */
  stepId: string;
  /** Adapter that produced the handle. */
  adapter: SubprocessAdapter;
  /**
   * Promise that resolves to the adapter-assigned handle. `detachedSpawn`
   * passes the in-flight `adapter.spawn(request)` promise here so `.await()`
   * is reachable even before the spawn itself has settled.
   */
  spawnPromise: Promise<SubprocessHandle>;
}

//#endregion

//#region Helpers

const INITIAL_POLL_MS = 10;
const MAX_POLL_MS = 100;
const POLL_RAMP_AFTER_MS = 1_000;
/** Upper bound on microtask yields before falling back to timer-based
 *  polling. Chosen empirically: in-memory step bodies settle within a
 *  handful of microtasks, and 64 gives plenty of headroom for chained
 *  awaits inside complex step trees without busy-spinning. */
const MAX_MICROTASK_YIELDS = 64;
/** Grace period before treating persistent null `adapter.get(handleId)`
 *  results as an eviction. Tolerates transient nulls from adapters that
 *  register the handle asynchronously relative to the spawn promise
 *  settling, but bounds the worst case so a corrupt adapter doesn't
 *  produce an infinite poll. */
const HANDLE_EVICTED_GRACE_MS = 500;

/**
 * Yield control to the timer queue so the adapter has a chance to
 * transition the handle before we issue the next `adapter.get()` call.
 * Using a timer (even 0ms) ensures we don't spin-lock when the adapter
 * schedules its completion on a later microtask.
 */
function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminalStatus(status: SubprocessStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'stopped' || status === 'stale'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNoeticErrorPayload(value: unknown): value is NoeticError {
  return isRecord(value) && typeof value.kind === 'string';
}

/** Rehydrate a thrown error from the handle metadata. Preserves the
 *  structured NoeticError shape when present so type-guards like
 *  `isNoeticError` keep working on the consumer side. */
function rehydrateError(payload: SerializedError | undefined, stepId: string): Error {
  if (!payload) {
    return new NoeticErrorImpl({
      kind: 'step_failed',
      stepId,
      cause: new Error('Detached spawn failed without an error payload'),
      retriesExhausted: false,
    });
  }
  if (isNoeticErrorPayload(payload.noeticError)) {
    return new NoeticErrorImpl(payload.noeticError);
  }
  const err = new Error(payload.message);
  if (payload.name) {
    err.name = payload.name;
  }
  if (payload.stack) {
    err.stack = payload.stack;
  }
  return err;
}

function extractResult<O>(metadata: Record<string, unknown> | undefined): O | undefined {
  if (!metadata || metadata.result === undefined) {
    return undefined;
  }
  return frameworkCast<O>(metadata.result);
}

function extractError(metadata: Record<string, unknown> | undefined): SerializedError | undefined {
  if (!metadata || metadata.error === undefined) {
    return undefined;
  }
  const raw = metadata.error;
  if (!isRecord(raw)) {
    return {
      message: String(raw),
    };
  }
  const message = typeof raw.message === 'string' ? raw.message : 'unknown error';
  const name = typeof raw.name === 'string' ? raw.name : undefined;
  const stack = typeof raw.stack === 'string' ? raw.stack : undefined;
  return {
    message,
    name,
    stack,
    noeticError: raw.noeticError,
  };
}

//#endregion

//#region DetachedHandleImpl

/**
 * @public
 * Thin wrapper over a `SubprocessHandle` that implements the `DetachedHandle`
 * contract. Polls the adapter until the handle reaches a terminal status,
 * then reads the result (or error) off `handle.metadata`.
 *
 * The polling cadence starts at 10ms and ramps to 100ms after the first
 * second — responsive for short-lived in-memory steps without burning cycles
 * on long-running ones.
 */
export class DetachedHandleImpl<O> implements DetachedHandle<O> {
  readonly id: string;
  private readonly _stepId: string;
  private readonly _adapter: SubprocessAdapter;
  private readonly _spawnPromise: Promise<SubprocessHandle>;
  private readonly _startTime: number;
  private _status: DetachedStatus = DetachedStatus.Running;
  private _result: O | undefined;
  private _error: string | undefined;
  private _settlementPromise: Promise<O> | undefined;

  constructor(opts: DetachedHandleOpts) {
    this.id = opts.id;
    this._stepId = opts.stepId;
    this._adapter = opts.adapter;
    this._spawnPromise = opts.spawnPromise;
    this._startTime = Date.now();

    // Observe spawn failure eagerly so `.error` is populated even if the
    // caller never invokes `.await()`. We intentionally swallow the
    // rejection here — `.await()` surfaces it to the caller.
    this._spawnPromise.catch((err: unknown) => {
      this._status = DetachedStatus.Failed;
      this._error = err instanceof Error ? err.message : String(err);
    });
  }

  get status(): DetachedStatus {
    return this._status;
  }

  get result(): O | undefined {
    return this._result;
  }

  get error(): string | undefined {
    return this._error;
  }

  /**
   * Wait for the underlying handle to settle, up to an optional timeout.
   * On settlement, the cached status/result/error are updated before
   * returning — so a caller that inspects `status` after `await()` resolves
   * observes the final value.
   */
  async await(timeout?: number): Promise<O> {
    const settlement = this.getOrStartSettlement();
    if (timeout === undefined || timeout <= 0) {
      return settlement;
    }
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timerId = setTimeout(() => {
        reject(
          new NoeticErrorImpl({
            kind: 'step_failed',
            stepId: this._stepId,
            cause: new Error(`Detached spawn timed out after ${timeout}ms`),
            retriesExhausted: false,
          }),
        );
      }, timeout);
    });
    try {
      return await Promise.race([
        settlement,
        timeoutPromise,
      ]);
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
    }
  }

  /**
   * Start (or return the cached) polling promise that resolves on the first
   * terminal status the adapter reports for this handle.
   *
   * A single settlement promise is shared across all `.await()` callers so
   * repeated calls don't spawn parallel polling loops.
   */
  private getOrStartSettlement(): Promise<O> {
    if (this._settlementPromise) {
      return this._settlementPromise;
    }
    this._settlementPromise = this.pollUntilSettled();
    return this._settlementPromise;
  }

  private async pollUntilSettled(): Promise<O> {
    // Wait for the spawn itself to succeed before we start polling —
    // otherwise we'd be polling with an undefined handle id.
    const initialHandle = await this._spawnPromise;
    if (isTerminalStatus(initialHandle.status)) {
      return this.finalise(initialHandle);
    }
    // Track when the adapter persistently returns null for this handle.
    // Transient nulls are tolerated for `HANDLE_EVICTED_GRACE_MS`; after
    // that we raise `handle_evicted` instead of looping forever. A
    // non-null observation resets the grace window.
    let firstNullAt: number | null = null;
    const observeNull = (): void => {
      if (firstNullAt === null) {
        firstNullAt = Date.now();
        return;
      }
      if (Date.now() - firstNullAt >= HANDLE_EVICTED_GRACE_MS) {
        throw new NoeticErrorImpl({
          kind: 'handle_evicted',
          handleId: initialHandle.id,
          stepId: this._stepId,
          gracePeriodMs: HANDLE_EVICTED_GRACE_MS,
        });
      }
    };
    const observeHandle = (h: SubprocessHandle | null): SubprocessHandle | null => {
      if (h === null) {
        observeNull();
        return null;
      }
      firstNullAt = null;
      return h;
    };

    // Fast path: yield through the microtask queue first. The in-memory
    // adapter schedules completion on a microtask, so a handful of yields
    // typically resolves the handle in sub-millisecond time. This keeps the
    // interpreter's "route through adapter" overhead negligible.
    for (let i = 0; i < MAX_MICROTASK_YIELDS; i++) {
      const handle = observeHandle(await this._adapter.get(initialHandle.id));
      if (handle && isTerminalStatus(handle.status)) {
        return this.finalise(handle);
      }
      await Promise.resolve();
    }
    // Slow path: fall back to timer-based polling for genuinely long-running
    // handles (out-of-process adapters, async work that doesn't resolve on
    // the microtask queue).
    let delay = INITIAL_POLL_MS;
    for (;;) {
      const handle = observeHandle(await this._adapter.get(initialHandle.id));
      if (handle && isTerminalStatus(handle.status)) {
        return this.finalise(handle);
      }
      await sleep(delay);
      if (Date.now() - this._startTime >= POLL_RAMP_AFTER_MS) {
        delay = MAX_POLL_MS;
      }
    }
  }

  private finalise(handle: SubprocessHandle): O {
    const metadata = handle.metadata;
    if (handle.status === 'completed') {
      const value = extractResult<O>(metadata);
      this._status = DetachedStatus.Completed;
      this._result = value;
      return frameworkCast<O>(value);
    }
    // Failed / stopped / stale — all map to Failed from the caller's view.
    const errorPayload = extractError(metadata);
    const err = rehydrateError(errorPayload, this._stepId);
    this._status = DetachedStatus.Failed;
    this._error = err.message;
    throw err;
  }
}

//#endregion
