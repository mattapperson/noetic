import { isNoeticError, NoeticConfigError, NoeticErrorImpl } from '@noetic-tools/types';
import { statusOf } from '../util/status-code';
import type { Context } from './action-types';

/**
 * Give an error from a model provider call the step's id and a Noetic kind.
 *
 * Noetic errors pass through untouched. A failure on an aborted context is
 * `cancelled` (the abort is what broke the call), a 429 is `model_rate_limit`,
 * and anything else is `step_failed` with the provider error as its cause.
 */
export function wrapModelError(
  e: unknown,
  stepId: string,
  ctx: Pick<Context, 'aborted' | 'abortReason'>,
): Error {
  if (isNoeticError(e) || e instanceof NoeticConfigError) {
    return e;
  }
  if (ctx.aborted) {
    return new NoeticErrorImpl({
      kind: 'cancelled',
      reason: ctx.abortReason ?? 'context aborted',
    });
  }
  if (statusOf(e) === 429) {
    return new NoeticErrorImpl({
      kind: 'model_rate_limit',
      stepId,
    });
  }
  return new NoeticErrorImpl({
    kind: 'step_failed',
    stepId,
    cause: e instanceof Error ? e : new Error(String(e)),
    retriesExhausted: false,
  });
}
