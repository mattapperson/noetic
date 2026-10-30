/**
 * Waiting helpers shared by task polling and event polling.
 */

//#region Public API

/**
 * @public
 * Waits `ms`, or until `wake` fires, whichever is first. Rejects with the
 * signal's reason when aborted.
 */
export function pause(ms: number, signal: AbortSignal, wake?: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', onAbort, {
      once: true,
    });
    void wake?.then(finish);
  });
}

/** @public A wake-up signal: `next` resolves on the following `fire()`. */
export class Waker {
  private resolver: () => void = () => {};
  private current: Promise<void> = this.arm();

  /** @public The promise that resolves on the next `fire()`. */
  get next(): Promise<void> {
    return this.current;
  }

  /** @public Resolves the pending `next` and starts a new one. */
  fire(): void {
    const resolve = this.resolver;
    this.current = this.arm();
    resolve();
  }

  private arm(): Promise<void> {
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }
}

//#endregion
