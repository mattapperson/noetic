import type { Step } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';

/**
 * Whether `step` or any step nested in it satisfies `test`.
 *
 * Only statically declared children are visited: a `conditional` or
 * `inParallel` built from functions exposes its children through
 * `_optimizable` only when the builder could enumerate them.
 */
export function someStep(step: Step, test: (step: Step) => boolean): boolean {
  if (test(step)) {
    return true;
  }
  return stepChildren(step).some((child) => someStep(child, test));
}

/** Whether a step-or-steps field holds an array; `Array.isArray` does not narrow readonly arrays. */
export function isStepList<S>(value: S | ReadonlyArray<S>): value is ReadonlyArray<S> {
  return Array.isArray(value);
}

/** A wait's `around` or a verify's `act`: one step or an array of steps. */
function waitAround(around: Step | ReadonlyArray<Step> | undefined): ReadonlyArray<Step> {
  if (around === undefined) {
    return [];
  }
  return isStepList(around)
    ? around
    : [
        around,
      ];
}

/** The steps nested directly inside `step`, as far as they are statically known. */
export function stepChildren(step: Step): ReadonlyArray<Step> {
  switch (step.kind) {
    case 'callModel':
    case 'runCode':
    case 'invokeTool':
    case 'decide':
    case 'acp-agent':
    case 'call':
      return [];
    case 'wait':
      return waitAround(step.around);
    case 'verify':
      // An act built per subject is not statically known.
      return typeof step.act === 'function' ? [] : waitAround(step.act);
    case 'conditional':
    case 'inParallel':
      return step._optimizable ?? [];
    case 'withContext':
    case 'spawn':
      return [
        step.child,
      ];
    case 'loop':
      // A decide step used as `until` is a child too; one inside any/all is
      // hidden in a closure.
      return typeof step.until === 'function'
        ? step.steps
        : [
            ...step.steps,
            step.until,
          ];
    case 'schedule':
      return [
        step.step,
      ];
    case 'sequence':
      return frameworkCast<ReadonlyArray<Step>>(step.steps);
    default:
      step satisfies never;
      return [];
  }
}
