import type { MemoryLayer } from '../types/memory';
import type { Step, StepSpawn } from '../types/step';

export function spawn<I, O>(opts: {
  id: string;
  child: Step<I, O>;
  memory?: MemoryLayer[];
  timeout?: number;
}): StepSpawn<I, O> {
  if (!opts.id || !opts.id.trim()) {
    throw new Error('spawn() requires a non-empty id');
  }
  if (!opts.child) {
    throw new Error('spawn() requires a child step');
  }
  return {
    kind: 'spawn',
    ...opts,
  };
}
