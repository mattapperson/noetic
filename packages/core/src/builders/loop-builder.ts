import type { StepLoop } from '../types/step';

export type LoopOpts<I, O> = Omit<StepLoop<I, O>, 'kind'>;

/**
 * Creates a loop step that iterates a body step until a termination predicate is satisfied.
 *
 * @param opts.id - Unique step identifier used in traces and error messages.
 * @param opts.body - Step to execute on each iteration.
 * @param opts.until - Termination predicate `(snapshot) => Verdict | Promise<Verdict>` evaluated after each iteration.
 * @param opts.maxIterations - Hard safety cap on iterations (default: 1000).
 * @param opts.maxHistorySize - Maximum entries kept in the snapshot history array.
 * @param opts.inbox - Optional channel for injecting messages into the loop mid-execution.
 * @param opts.parkTimeout - Ms to wait on inbox before the loop parks itself (default: 0).
 * @param opts.prepareNext - Transforms `(output, verdict, ctx)` into the next iteration's input.
 * @param opts.onError - Per-iteration error handler returning `'retry'`, `'skip'`, or `'abort'`.
 * @returns A `StepLoop` step.
 */
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
