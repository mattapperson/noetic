import type { ContextData } from '@noetic-tools/context';
import type { Channel, ScheduleErrorPolicy, Step, StepSchedule } from '@noetic-tools/types';
import { NoeticConfigError } from '@noetic-tools/types';
import { getDefaultRegistrar } from '../types/step-registrar';

/**
 * Configuration options accepted by the `schedule()` builder, excluding the `kind`
 * discriminant. `schedule()` schedules a body step on a fixed-interval, optionally
 * woken early by a channel, and runs until the executing context is cancelled.
 *
 * @public
 */
export interface ScheduleOptions<TContext = ContextData, I = unknown, O = unknown> {
  /** Unique step identifier used in traces and error messages. */
  id: string;
  /** Body step executed on each iteration. */
  step: Step<TContext, I, O>;
  /** Park duration between iterations in milliseconds. Must be >= 0. */
  interval: number;
  /** Optional channel that wakes the parking interval when any value arrives. */
  inbox?: Channel<unknown>;
  /** Behavior when `step` throws. Defaults to `'continue'`. */
  onError?: ScheduleErrorPolicy;
  /** Random jitter applied to the park duration in milliseconds. Must be >= 0. Default 0. */
  jitter?: number;
}

/**
 * Creates a `schedule` step that runs a body step on a fixed-interval schedule.
 *
 * The operator runs forever until the executing context is cancelled. After each
 * iteration it parks for `interval ± jitter` milliseconds (or until `inbox` receives
 * a message, whichever comes first).
 *
 * @public
 * @param opts.id - Unique step identifier used in traces and error messages.
 * @param opts.step - Body step executed on each iteration.
 * @param opts.interval - Park duration between iterations in milliseconds.
 * @param opts.inbox - Optional channel that wakes the parking interval when any value arrives.
 * @param opts.onError - Error policy. `'continue'` (default) records a span event and continues; `'fail'` re-throws.
 * @param opts.jitter - Random jitter in ms applied to the park duration. Default 0.
 * @returns A `StepSchedule` step.
 * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
 * @throws `NoeticConfigError` with code `MISSING_BODY_STEP` if `step` is not provided.
 * @throws `NoeticConfigError` with code `INVALID_INTERVAL_MS` if `interval` is negative or not finite.
 * @throws `NoeticConfigError` with code `INVALID_JITTER` if `jitter` is negative or not finite.
 */
export function schedule<TContext = ContextData, I = unknown, O = unknown>(
  opts: ScheduleOptions<TContext, I, O>,
): StepSchedule<TContext, I, O> {
  if (!opts.id || opts.id.trim() === '') {
    throw new NoeticConfigError({
      code: 'EMPTY_STEP_ID',
      message: 'schedule() requires a non-empty id.',
      hint: 'Pass a unique string as the id field, e.g. schedule({ id: "my-schedule", ... }).',
    });
  }
  if (!opts.step) {
    throw new NoeticConfigError({
      code: 'MISSING_BODY_STEP',
      message: 'schedule() requires a body step.',
      hint: 'Provide the step to execute on each scheduled iteration.',
    });
  }
  if (!Number.isFinite(opts.interval) || opts.interval < 0) {
    throw new NoeticConfigError({
      code: 'INVALID_INTERVAL_MS',
      message: `schedule() requires a non-negative finite interval, got ${opts.interval}.`,
      hint: 'Pass a non-negative number of milliseconds for the park interval.',
    });
  }
  if (opts.jitter !== undefined && (!Number.isFinite(opts.jitter) || opts.jitter < 0)) {
    throw new NoeticConfigError({
      code: 'INVALID_JITTER',
      message: `schedule() requires a non-negative finite jitter, got ${opts.jitter}.`,
      hint: 'Pass a non-negative number of milliseconds for jitter, or omit it.',
    });
  }
  const built: StepSchedule<TContext, I, O> = {
    kind: 'schedule',
    id: opts.id,
    step: opts.step,
    interval: opts.interval,
    inbox: opts.inbox,
    onError: opts.onError ?? 'continue',
    jitter: opts.jitter ?? 0,
  };
  getDefaultRegistrar().register(built);
  return built;
}
