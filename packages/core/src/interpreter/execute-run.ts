import { NoeticErrorImpl } from '../errors/noetic-error';
import type { RetryPolicy } from '../types/common';
import type { Context } from '../types/context';
import type { StepRun } from '../types/step';

export async function executeRun<I, O>(step: StepRun<I, O>, input: I, ctx: Context): Promise<O> {
  const retry = step.retry;
  const maxAttempts = retry?.maxAttempts ?? 1;

  let lastError = new Error('No attempts executed');

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await step.execute(input, ctx);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));

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
