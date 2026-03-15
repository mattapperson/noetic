import type { StepBranch } from '../types/step';
import type { Context } from '../types/context';

export type ExecuteStepFn = <I, O>(step: any, input: I, ctx: Context) => Promise<O>;

export async function executeBranch<I, O>(
  step: StepBranch<I, O>,
  input: I,
  ctx: Context,
  executeStep: ExecuteStepFn,
): Promise<O> {
  const selected = step.route(input, ctx);
  if (selected === null) {
    // No-op - return input as output
    return input as unknown as O;
  }
  return executeStep<I, O>(selected, input, ctx);
}
