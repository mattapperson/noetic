import type { Context } from '../types/context';
import type { ExecuteStepFn, StepBranch } from '../types/step';
import { frameworkCast } from './framework-cast';

export async function executeBranch<TMemory, I, O>(
  step: StepBranch<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
  executeStep: ExecuteStepFn,
): Promise<O> {
  const selected = await step.route(input, ctx);
  if (selected === null) {
    // Requires I assignable to O for null route — when no branch is selected,
    // the input passes through. Callers must ensure I is compatible with O.
    return frameworkCast<O>(input);
  }
  return executeStep<TMemory, I, O>(selected, input, ctx);
}
