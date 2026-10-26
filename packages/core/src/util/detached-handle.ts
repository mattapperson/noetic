import type {
  DetachedHandle,
  NoeticError,
  SerializedError,
  SpawnedSubprocess,
  SubprocessHandle,
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
  /**
   * The in-flight `adapter.spawn(request)` call, passed unawaited so the
   * handle exists (and `.await()` works) before the spawn itself resolves.
   */
  spawned: Promise<SpawnedSubprocess>;
}

//#endregion

//#region Helpers

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
 * Thin wrapper over a spawned subprocess that implements the `DetachedHandle`
 * contract. It waits on the adapter's `settled` promise and reads the result
 * (or error) off the final handle's metadata. Waiting starts in the
 * constructor, so `status`, `result`, and `error` settle whether or not the
 * caller ever invokes `.await()`.
 */
export class DetachedHandleImpl<O> implements DetachedHandle<O> {
  readonly id: string;
  private readonly _stepId: string;
  private _status: DetachedStatus = DetachedStatus.Running;
  private _result: O | undefined;
  private _error: string | undefined;
  private readonly _settlement: Promise<O>;

  constructor(opts: DetachedHandleOpts) {
    this.id = opts.id;
    this._stepId = opts.stepId;
    this._settlement = opts.spawned.then((s) => s.settled).then((h) => this.finalise(h));
    // Swallowed here only to record the failure; `.await()` surfaces it.
    this._settlement.catch((err: unknown) => {
      if (this._status === DetachedStatus.Running) {
        this._status = DetachedStatus.Failed;
        this._error = err instanceof Error ? err.message : String(err);
      }
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
    const settlement = this._settlement;
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
