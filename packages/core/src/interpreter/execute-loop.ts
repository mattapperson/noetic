import type { StepLoop } from '../types/step';
import type { Context } from '../types/context';

export type ExecuteStepFn = <I, O>(step: any, input: I, ctx: Context) => Promise<O>;

export async function executeLoop<I, O>(
  step: StepLoop<I, O>,
  input: I,
  ctx: Context,
  executeStep: ExecuteStepFn,
): Promise<O> {
  throw new Error('executeLoop not yet implemented - will be merged from stage-1h');
}
