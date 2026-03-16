import { NoeticErrorImpl } from '../errors/noetic-error';
import type { DetachedHandle } from '../types/detached';
import { DetachedStatus } from '../types/detached';

//#region DetachedHandleImpl

export class DetachedHandleImpl<O> implements DetachedHandle<O> {
  readonly id: string;
  private _status: DetachedStatus = DetachedStatus.Running;
  private _result: O | undefined;
  private _error: string | undefined;
  private readonly promise: Promise<O>;

  constructor(id: string, promise: Promise<O>) {
    this.id = id;
    this.promise = promise;

    promise.then(
      (value) => {
        this._status = DetachedStatus.Completed;
        this._result = value;
      },
      (err: unknown) => {
        this._status = DetachedStatus.Failed;
        this._error = err instanceof Error ? err.message : String(err);
      },
    );
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

  async await(timeout?: number): Promise<O> {
    if (timeout === undefined || timeout <= 0) {
      return this.promise;
    }
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timerId = setTimeout(() => {
        reject(
          new NoeticErrorImpl({
            kind: 'step_failed',
            stepId: this.id,
            cause: new Error(`Detached spawn timed out after ${timeout}ms`),
            retriesExhausted: false,
          }),
        );
      }, timeout);
    });
    try {
      return await Promise.race([
        this.promise,
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timerId);
    }
  }
}

//#endregion
