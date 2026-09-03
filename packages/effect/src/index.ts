/**
 * Effect (effect-ts) adapter for Noetic.
 *
 * Wraps Effect v4 programs into {@link EffectStepRuntime}s that the Noetic
 * interpreter executes and supervises. The interpreter owns retry policy,
 * framework events, ledger durability, and error normalization; Effect owns
 * fiber-internal concurrency, services, and typed errors inside the step
 * boundary.
 *
 * Interruption bridge: the interpreter hands over the executing context's
 * abort signal; `Effect.runPromiseExit` binds it so Noetic abort → fiber
 * interruption. Exit inspection maps the resulting Cause onto Noetic's error
 * model:
 *
 * - typed failures (`Fail`)    → `step_failed` (or the user's `mapError` hook)
 * - interruption (`Interrupt`) → `cancelled` — loops, settle forks, and
 *   durable resumes observe the same surface as native steps (spec 09)
 * - defects (`Die`)            → surfaced as `step_failed` around the defect
 *   (defects are bugs; they must not be silently laundered into expected
 *   failures, and the mapper is never offered them)
 */
import type { EffectStepRuntime, NoeticError } from '@noetic-tools/types';
import { isNoeticError, NoeticErrorImpl } from '@noetic-tools/types';
import { Cause, Effect, Exit } from 'effect';

//#region Error mapping

/**
 * Optional hook for mapping a typed Effect failure into a `NoeticError`
 * payload. Return `undefined` to fall back to the default `step_failed`
 * mapping. Interruption never reaches this hook — it always maps to
 * `cancelled` (spec 09). Defects never reach it either — they surface as
 * `step_failed` around the defect.
 * @public
 */
export type CauseMapper<E> = (error: E, cause: Cause.Cause<E>) => NoeticError | undefined;

/**
 * Map an inspected Cause onto Noetic's error model. Thrown as the adapter's
 * rejection value; the interpreter's retry loop then applies the step's
 * policy exactly as it would for a native step failure.
 */
function causeToError<E>(cause: Cause.Cause<E>, stepId: string, map?: CauseMapper<E>): Error {
  // 1. Interruption first: maps to `cancelled`, never retried upstream.
  if (Cause.hasInterruptsOnly(cause)) {
    return new NoeticErrorImpl({
      kind: 'cancelled',
      reason: `effect step '${stepId}' interrupted`,
    });
  }
  // 2. Typed failures: prefer the user's mapper, else `step_failed`.
  const found = Cause.findError(cause);
  if (found._tag === 'Success') {
    const mapped = map?.(found.success, cause);
    if (mapped) {
      return new NoeticErrorImpl(mapped);
    }
    const err = found.success;
    return new NoeticErrorImpl({
      kind: 'step_failed',
      stepId,
      cause:
        err instanceof Error ? err : new Error(`effect step '${stepId}' failed: ${stringify(err)}`),
      retriesExhausted: false,
    });
  }
  // 3. Defects surface as step_failed around the defect, unmapped — except
  // NoeticErrorImpls, which are already framework-classified (e.g. a program
  // raising `cancelled` from inside a callback) and pass through as-is
  // rather than being laundered into step_failed.
  const defectFound = Cause.findDefect(cause);
  if (defectFound._tag === 'Success') {
    const defect = defectFound.success;
    if (isNoeticError(defect)) {
      return defect;
    }
    return new NoeticErrorImpl({
      kind: 'step_failed',
      stepId,
      cause:
        defect instanceof Error
          ? defect
          : new Error(`effect step '${stepId}' died: ${stringify(defect)}`),
      retriesExhausted: false,
    });
  }
  // 4. Fallback: unknown Cause shape.
  return new NoeticErrorImpl({
    kind: 'step_failed',
    stepId,
    cause: new Error(`effect step '${stepId}' failed with cause: ${Cause.pretty(cause)}`),
    retriesExhausted: false,
  });
}

function stringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

//#endregion

//#region Adapter

export interface EffectStepOptions<I, O, E> {
  /**
   * The Effect program to run — either a pre-built Effect (input-independent)
   * or a builder `(input, ctx) => Effect` resolved at dispatch time, following
   * the same Lazy convention as other step fields. Any required services must
   * already be provided; the runtime executes the program verbatim with
   * `Effect.runPromiseExit`.
   */
  program: Effect.Effect<O, E> | ((input: I, ctx: unknown) => Effect.Effect<O, E>);
  /** Optional typed-failure → NoeticError mapping hook. */
  mapError?: CauseMapper<E>;
  /**
   * Step id used in error messages and `describe()`. Optional here because
   * the owning `StepEffect.id` is the primary label; pass it to keep
   * standalone runtimes (workflow `ref` hydration) well-labeled.
   */
  stepId?: string;
  /** Optional human-readable summary surfaced in traces and the plan graph. */
  describe?: {
    summary?: string;
    services?: ReadonlyArray<string>;
  };
}

/**
 * Wrap an Effect program into an {@link EffectStepRuntime} for use with
 * `effectStep({ id, runtime })` from `@noetic-tools/core`.
 *
 * The program runs with `Effect.runPromiseExit` at interpreter dispatch
 * time, bound to the context's abort signal so Noetic cancellation
 * interrupts the fiber and surfaces as a `cancelled` NoeticError.
 *
 * @example
 * ```ts
 * import { effectStep } from '@noetic-tools/effect';
 * import { Effect } from 'effect';
 * import { effectStep as makeEffectStep } from '@noetic-tools/core';
 *
 * const runtime = effectStep({
 *   program: Effect.sync(() => compute()),
 *   stepId: 'compute',
 * });
 * const step = makeEffectStep({ id: 'compute', runtime });
 * ```
 *
 * @public
 */
export function effectStep<I = unknown, O = unknown, E = never>(
  options: EffectStepOptions<I, O, E>,
): EffectStepRuntime<never, I, O> {
  const label = options.stepId ?? options.describe?.summary ?? 'effect-step';
  const programOption: Effect.Effect<O, E> | ((input: I, ctx: unknown) => Effect.Effect<O, E>) =
    options.program;
  const buildProgram = (input: I, ctx: unknown): Effect.Effect<O, E> =>
    typeof programOption === 'function' ? programOption(input, ctx) : programOption;
  return {
    run(input: I, _ctx: unknown, signal: AbortSignal): Promise<O> {
      // Bind the interpreter's abort signal: Noetic abort → fiber
      // interruption → Exit failure with an interrupt-only Cause. The
      // program may be input-shaped (Lazy-style builder) or pre-built.
      return Effect.runPromiseExit(buildProgram(input, _ctx), {
        signal,
      }).then((exit) => {
        if (Exit.isSuccess(exit)) {
          return exit.value;
        }
        throw causeToError(exit.cause, label, options.mapError);
      });
    },
    describe: options.describe
      ? () => ({
          summary: options.describe?.summary,
          services: options.describe?.services,
        })
      : undefined,
  } satisfies EffectStepRuntime<never, I, O>;
}

//#endregion
