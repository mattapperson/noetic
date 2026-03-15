import type { StepSpawn, ContextInStrategy, ContextOutStrategy } from '../types/step';
import type { Step } from '../types/step';

export function spawn<I, O>(opts: {
  id: string;
  child: Step<I, O>;
  contextIn: ContextInStrategy;
  contextOut: ContextOutStrategy<O>;
  timeout?: number;
}): StepSpawn<I, O> {
  if (!opts.id || !opts.id.trim()) throw new Error('spawn() requires a non-empty id');
  if (!opts.child) throw new Error('spawn() requires a child step');
  return { kind: 'spawn', ...opts };
}
