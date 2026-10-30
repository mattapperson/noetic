import type { ContextData, Step, StepSequence, Steps } from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';

//#region Helpers

function isStepList(steps: unknown): steps is ReadonlyArray<Step<never, never, unknown>> {
  return Array.isArray(steps);
}

//#endregion

//#region Public API

/**
 * A step from a step or an array of steps. An array of two or more becomes a
 * `sequence` step whose id joins its children's ids; a one-element array is its
 * element. Every builder that takes a step calls this, so an array runs in
 * sequence wherever a step goes.
 *
 * @throws `NoeticConfigError` with code `EMPTY_STEP_ARRAY` for an empty array.
 */
export function toStep<TContext = ContextData, I = unknown, O = unknown>(
  steps: Steps<TContext, I, O>,
): Step<TContext, I, O> {
  if (!isStepList(steps)) {
    return frameworkCast<Step<TContext, I, O>>(steps);
  }
  const list = frameworkCast<ReadonlyArray<Step<TContext, I, O>>>(steps);
  const [first] = list;
  if (!first) {
    throw new NoeticConfigError({
      code: 'EMPTY_STEP_ARRAY',
      message: 'An array of steps must contain at least one step.',
      hint: 'Pass the steps to run in sequence, or a single step.',
    });
  }
  if (list.length === 1) {
    return frameworkCast<Step<TContext, I, O>>(first);
  }
  return {
    kind: 'sequence',
    id: list.map((child) => child.id).join(' > '),
    steps: list,
  } satisfies StepSequence<TContext, I, O>;
}

//#endregion
