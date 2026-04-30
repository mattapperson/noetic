import { NoeticConfigError } from '../errors/noetic-config-error';
import type { Channel } from '../types/channel';
import type { ContextMemory } from '../types/memory';
import type { EveryErrorPolicy, Step, StepEvery } from '../types/step';

/**
 * Configuration options accepted by the `every()` builder, excluding the `kind`
 * discriminant. `every()` schedules a body step on a fixed-interval, optionally
 * woken early by a channel, and runs until the executing context is cancelled.
 *
 * @public
 */
export interface EveryOptions<TMemory = ContextMemory, I = unknown, O = unknown> {
  /** Unique step identifier used in traces and error messages. */
  id: string;
  /** Body step executed on each iteration. */
  step: Step<TMemory, I, O>;
  /** Park duration between iterations in milliseconds. Must be >= 0. */
  ms: number;
  /** Optional channel that wakes the parking interval when any value arrives. */
  wakeOn?: Channel<unknown>;
  /** Behavior when `step` throws. Defaults to `'continue'`. */
  onError?: EveryErrorPolicy;
  /** Random jitter applied to the park duration in milliseconds. Must be >= 0. Default 0. */
  jitter?: number;
}

/**
 * Creates an `every` step that runs a body step on a fixed-interval schedule.
 *
 * The operator runs forever until the executing context is cancelled. After each
 * iteration it parks for `ms ± jitter` milliseconds (or until `wakeOn` receives
 * a message, whichever comes first).
 *
 * @public
 * @param opts.id - Unique step identifier used in traces and error messages.
 * @param opts.step - Body step executed on each iteration.
 * @param opts.ms - Park duration between iterations in milliseconds.
 * @param opts.wakeOn - Optional channel that wakes the parking interval when any value arrives.
 * @param opts.onError - Error policy. `'continue'` (default) records a span event and continues; `'fail'` re-throws.
 * @param opts.jitter - Random jitter in ms applied to the park duration. Default 0.
 * @returns A `StepEvery` step.
 * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
 * @throws `NoeticConfigError` with code `MISSING_BODY_STEP` if `step` is not provided.
 * @throws `NoeticConfigError` with code `INVALID_INTERVAL_MS` if `ms` is negative or not finite.
 * @throws `NoeticConfigError` with code `INVALID_JITTER` if `jitter` is negative or not finite.
 */
export function every<TMemory = ContextMemory, I = unknown, O = unknown>(
  opts: EveryOptions<TMemory, I, O>,
): StepEvery<TMemory, I, O> {
  if (!opts.id || opts.id.trim() === '') {
    throw new NoeticConfigError({
      code: 'EMPTY_STEP_ID',
      message: 'every() requires a non-empty id.',
      hint: 'Pass a unique string as the id field, e.g. every({ id: "my-every", ... }).',
    });
  }
  if (!opts.step) {
    throw new NoeticConfigError({
      code: 'MISSING_BODY_STEP',
      message: 'every() requires a body step.',
      hint: 'Provide the step to execute on each scheduled iteration.',
    });
  }
  if (!Number.isFinite(opts.ms) || opts.ms < 0) {
    throw new NoeticConfigError({
      code: 'INVALID_INTERVAL_MS',
      message: `every() requires a non-negative finite ms, got ${opts.ms}.`,
      hint: 'Pass a non-negative number of milliseconds for the park interval.',
    });
  }
  if (opts.jitter !== undefined && (!Number.isFinite(opts.jitter) || opts.jitter < 0)) {
    throw new NoeticConfigError({
      code: 'INVALID_JITTER',
      message: `every() requires a non-negative finite jitter, got ${opts.jitter}.`,
      hint: 'Pass a non-negative number of milliseconds for jitter, or omit it.',
    });
  }
  return {
    kind: 'every',
    id: opts.id,
    step: opts.step,
    ms: opts.ms,
    wakeOn: opts.wakeOn,
    onError: opts.onError ?? 'continue',
    jitter: opts.jitter ?? 0,
  };
}
