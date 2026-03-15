import type { StepSpawn, ContextInStrategy, ContextOutStrategy } from '../types/step';
import type { Step } from '../types/step';

export function spawn<I, O>(opts: {
  id: string;
  child: Step<I, O>;
  contextIn: ContextInStrategy;
  contextOut: ContextOutStrategy<O>;
  timeout?: number;
}): StepSpawn<I, O> {
  return { kind: 'spawn', ...opts };
}
