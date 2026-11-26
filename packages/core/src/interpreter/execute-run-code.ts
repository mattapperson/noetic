import { frameworkCast, isNoeticError, NoeticErrorImpl } from '@noetic-tools/types';
import type { Context, RetryPolicy, StepRunCode } from './action-types';
import { emitStepEvent, runToReturn } from './emit-items';
import { turnEndingIn } from './turn-ending';

export async function executeRunCode<TContext, I, O>(
  step: StepRunCode<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
): Promise<O> {
  const retry = step.retry;
  const maxAttempts = retry?.maxAttempts ?? 1;

  let lastError = new Error('No attempts executed');

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Cancellation is not a retriable error (spec 09) — an abort that
    // arrived between attempts must stop the loop before re-executing.
    if (ctx.aborted) {
      throw new NoeticErrorImpl({
        kind: 'cancelled',
        reason: ctx.abortReason ?? 'context aborted',
      });
    }
    try {
      // A generator body yields events of the item the step's emitItems names.
      return frameworkCast<O>(
        await runToReturn(step.execute(input, ctx), (event) => emitStepEvent(step.id, event, ctx)),
      );
    } catch (e) {
      // Rethrow cancellation immediately — retrying it would re-run side
      // effects after abort and bury the 'cancelled' kind under step_failed.
      if (isNoeticError(e) && e.noeticError.kind === 'cancelled') {
        throw e;
      }
      // These end the turn, not the step: a retry could not help, and wrapping
      // them would hide from the harness why the turn stopped.
      const ending = turnEndingIn(e);
      if (ending) {
        throw ending;
      }
      // A thrown non-Error keeps the value itself as the wrapper's cause.
      lastError =
        e instanceof Error
          ? e
          : new Error(String(e), {
              cause: e,
            });

      if (attempt < maxAttempts - 1 && retry) {
        const delay = computeDelay(retry, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw new NoeticErrorImpl({
    kind: 'step_failed',
    stepId: step.id,
    cause: lastError,
    retriesExhausted: maxAttempts > 1,
  });
}

function computeDelay(retry: RetryPolicy, attempt: number): number {
  let delay: number;
  switch (retry.backoff) {
    case 'fixed':
      delay = retry.initialDelay;
      break;
    case 'linear':
      delay = retry.initialDelay * (attempt + 1);
      break;
    case 'exponential':
      delay = retry.initialDelay * 2 ** attempt;
      break;
  }
  return Math.min(delay, retry.maxDelay ?? 30_000);
}
