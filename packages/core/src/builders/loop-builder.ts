import type { StepLoop } from '../types/step';

export type LoopOpts<I, O> = Omit<StepLoop<I, O>, 'kind'>;

export function loop<I, O>(opts: LoopOpts<I, O>): StepLoop<I, O> {
  if (!opts.id || opts.id.trim() === '') {
    throw new Error('loop() requires a non-empty id');
  }
  if (!opts.body) {
    throw new Error('loop() requires a body step');
  }
  if (!opts.until) {
    throw new Error('loop() requires an until predicate');
  }
  return {
    kind: 'loop',
    ...opts,
  };
}
