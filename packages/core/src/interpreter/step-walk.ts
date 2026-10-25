import type { Step } from '@noetic-tools/types';

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

/** The steps nested directly inside `step`, as far as they are statically known. */
export function stepChildren(step: Step): ReadonlyArray<Step> {
  switch (step.kind) {
    case 'callModel':
    case 'runCode':
    case 'invokeTool':
    case 'decide':
    case 'acp-agent':
      return [];
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
    default:
      step satisfies never;
      return [];
  }
}
