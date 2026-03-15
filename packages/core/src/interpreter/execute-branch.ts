import type { Context } from '../types/context';
import type { ExecuteStepFn, StepBranch } from '../types/step';

export async function executeBranch<I, O>(
  step: StepBranch<I, O>,
  input: I,
  ctx: Context,
  executeStep: ExecuteStepFn,
): Promise<O> {
  const selected = step.route(input, ctx);
  if (selected === null) {
    // SAFETY: requires I assignable to O for null route — when no branch is selected,
    // the input passes through. Callers must ensure I is compatible with O.
    return input as unknown as O;
  }
  return executeStep<I, O>(selected, input, ctx);
}
