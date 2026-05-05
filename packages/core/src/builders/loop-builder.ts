import { NoeticConfigError } from '../errors/noetic-config-error';
import { getDefaultRegistrar } from '../types/step-registrar';
import type { ContextMemory } from '../types/memory';
import type { StepLoop } from '../types/step';

/** @public Configuration options accepted by the `loop()` builder, excluding the `kind` discriminant. */
export type LoopConfig<TMemory = ContextMemory, I = unknown, O = unknown> = Omit<
  StepLoop<TMemory, I, O>,
  'kind'
>;

/**
 * Creates a loop step that iterates a body step until a termination predicate is satisfied.
 *
 * @public
 * @param opts.id - Unique step identifier used in traces and error messages.
 * @param opts.steps - Array of steps to execute sequentially on each iteration.
 * @param opts.until - Termination predicate `(snapshot) => Verdict | Promise<Verdict>` evaluated after each iteration.
 * @param opts.maxIterations - Hard safety cap on iterations (default: 1000).
 * @param opts.maxHistorySize - Maximum entries kept in the snapshot history array.
 * @param opts.inbox - Optional channel for injecting messages into the loop mid-execution.
 * @param opts.parkTimeout - Ms to wait on inbox before the loop parks itself (default: 0).
 * @param opts.prepareNext - Transforms `(output, verdict, ctx)` into the next iteration's input.
 * @param opts.onError - Per-iteration error handler returning `'retry'`, `'skip'`, or `'abort'`.
 * @returns A `StepLoop` step.
 * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
 * @throws `NoeticConfigError` with code `MISSING_LOOP_BODY` if `steps` is empty.
 * @throws `NoeticConfigError` with code `MISSING_UNTIL_PREDICATE` if `until` is not provided.
 */
export function loop<TMemory = ContextMemory, I = unknown, O = unknown>(
  opts: LoopConfig<TMemory, I, O>,
): StepLoop<TMemory, I, O> {
  if (!opts.id || opts.id.trim() === '') {
    throw new NoeticConfigError({
      code: 'EMPTY_STEP_ID',
      message: 'loop() requires a non-empty id.',
      hint: 'Pass a unique string as the id field, e.g. loop({ id: "my-loop", ... }).',
    });
  }
  if (!Array.isArray(opts.steps) || opts.steps.length === 0) {
    throw new NoeticConfigError({
      code: 'MISSING_LOOP_BODY',
      message: 'loop() requires at least one body step.',
      hint: 'Add at least one step to the steps array.',
    });
  }
  if (!opts.until) {
    throw new NoeticConfigError({
      code: 'MISSING_UNTIL_PREDICATE',
      message: 'loop() requires an until predicate.',
      hint: 'Provide an until predicate, e.g. until.maxSteps(10).',
    });
  }
  const built: StepLoop<TMemory, I, O> = {
    kind: 'loop',
    ...opts,
  };
  getDefaultRegistrar().register(built);
  return built;
}
