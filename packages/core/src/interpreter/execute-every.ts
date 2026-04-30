import { isNoeticError, NoeticErrorImpl } from '../errors/noetic-error';
import type { Channel } from '../types/channel';
import type { Context } from '../types/context';
import type { ExecuteStepFn, StepEvery } from '../types/step';

//#region Types

interface ParkContext<TMemory> {
  ms: number;
  jitter: number;
  wakeOn?: Channel<unknown>;
  ctx: Context<TMemory>;
}

//#endregion

//#region Helper Functions

/** Returns the next park duration in ms, applying random jitter clamped to `[ms - jitter, ms + jitter]`. */
function nextParkMs(ms: number, jitter: number): number {
  if (jitter <= 0) {
    return ms;
  }
  // Math.random() returns [0, 1); shift to [-1, 1) so jitter is symmetric.
  const offset = (Math.random() * 2 - 1) * jitter;
  const value = ms + offset;
  if (value < 0) {
    return 0;
  }
  return value;
}

/**
 * Parks for `ms` ms, returning early if `wakeOn` receives a message or the
 * context is aborted. Always resolves; never throws (cancellation surfaces on
 * the next iteration's abort check).
 */
function park<TMemory>(parkCtx: ParkContext<TMemory>): Promise<void> {
  const duration = nextParkMs(parkCtx.ms, parkCtx.jitter);

  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abortPoll: ReturnType<typeof setInterval> | null = null;

    const settle = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      if (abortPoll !== null) {
        clearInterval(abortPoll);
      }
      resolve();
    };

    timer = setTimeout(settle, duration);

    // Poll the abort flag at a coarse interval to wake parking when the
    // context is aborted. The Context interface exposes only `aborted` as a
    // boolean, so this is the simplest interruption strategy that respects
    // the public contract.
    abortPoll = setInterval(() => {
      if (parkCtx.ctx.aborted) {
        settle();
      }
    }, 5);

    if (parkCtx.wakeOn) {
      // recv() rejects on channel timeout; we set our own park timeout via the
      // setTimeout above, so request a recv timeout that exceeds the park
      // duration. Channel timeouts are swallowed — settle still fires from the
      // setTimeout / abort-poll paths.
      parkCtx.ctx
        .recv(parkCtx.wakeOn, {
          timeout: Math.max(duration, 1) + 100,
        })
        .then(settle)
        .catch(() => {
          // Channel timeout / store error — ignore; another path settles us.
        });
    }
  });
}

function recordIterationError<TMemory>(ctx: Context<TMemory>, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && error.stack ? error.stack : '';
  ctx.span.addEvent('every.iteration.error', {
    message,
    stack,
  });
}

function throwCancelled(reason: string | undefined): never {
  throw new NoeticErrorImpl({
    kind: 'cancelled',
    reason: reason ?? 'context aborted',
  });
}

//#endregion

//#region Public API

/**
 * Executes an `every` step: runs the body step forever, paced by `ms ± jitter`,
 * woken early by `wakeOn`. Throws `cancelled` when the context is aborted.
 *
 * On body throw, behavior depends on `onError`:
 * - `'continue'` (default): emit `every.iteration.error` span event and proceed
 *   to the park step as if no error occurred.
 * - `'fail'`: re-throw, terminating the operator.
 *
 * The body's output is discarded — `every` runs forever and does not accumulate
 * iteration outputs. Only ever returns by throwing on cancellation or `fail`.
 */
export async function executeEvery<TMemory, I, O>(
  step: StepEvery<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
  executeStep: ExecuteStepFn,
): Promise<O> {
  const onError = step.onError ?? 'continue';
  const jitter = step.jitter ?? 0;

  while (true) {
    if (ctx.aborted) {
      throwCancelled(ctx.abortReason);
    }

    try {
      await executeStep(step.step, input, ctx);
    } catch (e) {
      if (onError === 'fail') {
        throw e;
      }
      // 'continue' policy — but a cancellation should still terminate the
      // operator promptly rather than be swallowed and re-parked.
      if (isNoeticError(e) && e.noeticError.kind === 'cancelled') {
        throw e;
      }
      recordIterationError(ctx, e);
    }

    if (ctx.aborted) {
      throwCancelled(ctx.abortReason);
    }

    await park({
      ms: step.ms,
      jitter,
      wakeOn: step.wakeOn,
      ctx,
    });
  }
}

//#endregion
