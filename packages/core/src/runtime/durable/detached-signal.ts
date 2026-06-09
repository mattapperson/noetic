/**
 * Deferred-style, single-shot signal used to wire a detached child — a
 * terminal tool, an IPC handler, an external watchdog — back to the
 * parent that awaits its outcome.
 *
 * The pattern is intentionally minimal: the parent awaits `signal.done`
 * while the child calls `signal.resolve(outcome)` (or `signal.reject(err)`)
 * when it has produced the final value. Any subsequent `resolve` /
 * `reject` calls are silently dropped so a late-arriving duplicate
 * settlement never overwrites the first.
 *
 * This is the canonical primitive the `runnableLoop` (and the task
 * runner scripts that use it) build on. Keeping it in core means every
 * out-of-process worker / detached step shares one signal shape rather
 * than each reinventing the single-shot-deferred.
 */

//#region Types

/** Single-shot deferred signal the caller awaits via `.done`. */
export interface DetachedSignal<TOutcome> {
  readonly done: Promise<TOutcome>;
  /**
   * Settle the signal with a success outcome. Only the first call has
   * effect; subsequent calls (from retry logic, duplicate terminal
   * tool invocations, external signal handlers) are dropped silently.
   */
  resolve(outcome: TOutcome): void;
  /**
   * Settle the signal with a failure. Only the first call has effect;
   * a `resolve` that races with a `reject` wins by whichever runs
   * first — both further attempts are dropped.
   */
  reject(err: unknown): void;
}

//#endregion

//#region Public API

/**
 * Construct a fresh single-shot `DetachedSignal<TOutcome>`. The returned
 * signal's `done` Promise resolves/rejects at most once.
 */
export function createDetachedSignal<TOutcome>(): DetachedSignal<TOutcome> {
  let resolveFn: ((outcome: TOutcome) => void) | null = null;
  let rejectFn: ((err: unknown) => void) | null = null;
  const done = new Promise<TOutcome>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    done,
    resolve(outcome) {
      if (resolveFn === null) {
        return;
      }
      const fn = resolveFn;
      resolveFn = null;
      rejectFn = null;
      fn(outcome);
    },
    reject(err) {
      if (rejectFn === null) {
        return;
      }
      const fn = rejectFn;
      resolveFn = null;
      rejectFn = null;
      fn(err);
    },
  };
}

//#endregion
