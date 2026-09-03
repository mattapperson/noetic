import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { RetryPolicy } from './common';
import type { Context } from './context';
import type { ContextData } from './context-layer';
import type { Lazy } from './step';

/**
 * Execution contract for an `effect` step — the seam between the Noetic
 * interpreter and the Effect (effect-ts) fiber runtime.
 *
 * Defined in the dependency-free `@noetic-tools/types` foundation so both
 * `@noetic-tools/core` (which executes `effect` steps) and
 * `@noetic-tools/effect` (which implements this contract with the real
 * `effect` package) can depend on it without forming a cycle. This is the
 * exact isolation shape of the `SubHarness` contract: core sees only this
 * structural interface and never imports `effect`.
 *
 * The runtime closes over the Effect program and services; the interpreter
 * supplies the input, the execution context, and the context's abort signal.
 * Implementations must honor the signal — Noetic abort → Effect interruption
 * — so `cancelled` maps cleanly onto fiber interruption and vice versa.
 *
 * @public
 */
export interface EffectStepRuntime<TContext = ContextData, I = unknown, O = unknown> {
  /**
   * Run the Effect program to completion.
   *
   * @param input - The step's input value.
   * @param ctx - The live Noetic execution context (state, tokens, layers).
   * @param signal - Abort signal scoped to the executing context; when
   *   aborted, the runtime must interrupt the program and reject with a
   *   `NoeticError` of kind `cancelled` (directly or through the interpreter).
   * @returns The program's success value.
   */
  run(input: I, ctx: Context<TContext>, signal: AbortSignal): Promise<O>;

  /**
   * Optional static description surfaced in traces and the plan graph.
   * @public
   */
  describe?(): {
    /** Human-readable summary of what the program does. */
    summary?: string;
    /** Service tags the program requires, for observability. */
    services?: ReadonlyArray<string>;
  };
}

/**
 * A step that executes an Effect (effect-ts) program under the interpreter's
 * supervision. The program runs as a scoped Effect fiber: Noetic owns retry
 * policy, interruption, framework events, and error normalization, while
 * Effect owns fiber-internal concurrency, services, and typed errors inside
 * the step boundary.
 * @public
 */
export interface StepEffect<TContext = ContextData, I = unknown, O = unknown> {
  kind: 'effect';
  id: string;
  /**
   * The Effect runtime adapter closing over the program. Eager or
   * `(ctx) => EffectStepRuntime` getter, resolved at step execution time.
   */
  runtime: Lazy<EffectStepRuntime<TContext, I, O>, TContext>;
  /**
   * Optional Standard Schema applied to the step's input before the program
   * runs (e.g. an Effect Schema via `Schema.toStandardSchemaV1`).
   */
  inputSchema?: StandardSchemaV1<unknown, I>;
  /**
   * Optional Standard Schema applied to the program's result before it
   * reaches the parent step.
   */
  output?: StandardSchemaV1<unknown, O>;
  /** Retry policy applied around the program (interpreter-side, not Effect-side). */
  retry?: RetryPolicy;
  /** Controls framework event emission for this step. Defaults to `true`. */
  emit?: boolean | ((eventType: string, data: Record<string, unknown>) => boolean);
}
