import type { StepRun } from '../types/step';
import type { Context } from '../types/context';
import type { RetryPolicy } from '../types/common';
import { OrchidErrorImpl } from '../errors/orchid-error';

export async function executeRun<I, O>(step: StepRun<I, O>, input: I, ctx: Context): Promise<O> {
  const retry = step.retry;
  const maxAttempts = retry?.maxAttempts ?? 1;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await step.execute(input, ctx);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));

      if (attempt < maxAttempts - 1 && retry) {
        const delay = computeDelay(retry, attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw new OrchidErrorImpl({
    kind: 'step_failed',
    stepId: step.id,
    cause: lastError!,
    retriesExhausted: maxAttempts > 1,
  });
}

function computeDelay(retry: RetryPolicy, attempt: number): number {
  switch (retry.backoff) {
    case 'fixed':
      return retry.initialDelay;
    case 'linear':
      return retry.initialDelay * (attempt + 1);
    case 'exponential':
      return retry.initialDelay * Math.pow(2, attempt);
  }
}
