import type { ContextData } from '@noetic-tools/context';
import type {
  Context,
  SettleResult,
  Step,
  StepConditional,
  StepInParallel,
  StepInParallelAll,
  StepInParallelRace,
  StepInParallelSettle,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import { getDefaultRegistrar } from '../types/step-registrar';

/**
 * Creates a parallel execution step that races paths and returns the first result.
 *
 * @public
 * @param opts.id - Unique step identifier used in traces and error messages.
 * @param opts.mode - Must be `'race'`: first path to resolve wins, others are cancelled.
 * @param opts.paths - Factory `(input, ctx) => Step[]` generating the parallel paths.
 * @param opts.concurrency - Optional maximum number of paths to run simultaneously.
 * @returns A `StepInParallelRace` step.
 * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
 */
export function inParallel<TContext = ContextData, I = unknown, O = unknown>(opts: {
  id: string;
  mode: 'race';
  paths: (input: I, ctx: Context<TContext>) => Step<TContext, I, O>[];
  concurrency?: number;
  _optimizable?: Step<TContext>[];
}): StepInParallelRace<TContext, I, O>;

/**
 * Creates a parallel execution step that waits for all paths and merges results.
 *
 * @public
 * @param opts.id - Unique step identifier used in traces and error messages.
 * @param opts.mode - Must be `'all'`: waits for every path; fails on any error.
 * @param opts.paths - Factory `(input, ctx) => Step[]` generating the parallel paths.
 * @param opts.merge - Combines all path results into a single output value.
 * @param opts.concurrency - Optional maximum number of paths to run simultaneously.
 * @returns A `StepInParallelAll` step.
 * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
 * @throws `NoeticConfigError` with code `MISSING_MERGE_FUNCTION` if `merge` is not provided.
 */
export function inParallel<TContext = ContextData, I = unknown, O = unknown>(opts: {
  id: string;
  mode: 'all';
  paths: (input: I, ctx: Context<TContext>) => Step<TContext, I, O>[];
  merge: (results: O[], ctx: Context<TContext>) => O;
  concurrency?: number;
  _optimizable?: Step<TContext>[];
}): StepInParallelAll<TContext, I, O>;

/**
 * Creates a parallel execution step that waits for all paths, collecting errors as results.
 *
 * @public
 * @param opts.id - Unique step identifier used in traces and error messages.
 * @param opts.mode - Must be `'settle'`: waits for every path; errors are captured, not thrown.
 * @param opts.paths - Factory `(input, ctx) => Step[]` generating the parallel paths.
 * @param opts.merge - Combines settled results (successes and failures) into a single output.
 * @param opts.concurrency - Optional maximum number of paths to run simultaneously.
 * @returns A `StepInParallelSettle` step.
 * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
 * @throws `NoeticConfigError` with code `MISSING_MERGE_FUNCTION` if `merge` is not provided.
 */
export function inParallel<TContext = ContextData, I = unknown, O = unknown>(opts: {
  id: string;
  mode: 'settle';
  paths: (input: I, ctx: Context<TContext>) => Step<TContext, I, O>[];
  merge: (results: SettleResult<O>[], ctx: Context<TContext>) => O;
  concurrency?: number;
  _optimizable?: Step<TContext>[];
}): StepInParallelSettle<TContext, I, O>;

export function inParallel<TContext = ContextData, I = unknown, O = unknown>(opts: {
  id: string;
  mode: 'race' | 'all' | 'settle';
  paths: (input: I, ctx: Context<TContext>) => Step<TContext, I, O>[];
  merge?:
    | ((results: O[], ctx: Context<TContext>) => O)
    | ((results: SettleResult<O>[], ctx: Context<TContext>) => O);
  concurrency?: number;
  _optimizable?: Step<TContext>[];
}): StepInParallel<TContext, I, O> {
  if (!opts.id || opts.id.trim() === '') {
    throw new NoeticConfigError({
      code: 'EMPTY_STEP_ID',
      message: 'inParallel() requires a non-empty id.',
      hint: 'Pass a unique string as the id field, e.g. inParallel({ id: "my-inParallel", ... }).',
    });
  }
  if ((opts.mode === 'all' || opts.mode === 'settle') && !opts.merge) {
    throw new NoeticConfigError({
      code: 'MISSING_MERGE_FUNCTION',
      message: `inParallel() mode '${opts.mode}' requires a merge function.`,
      hint: 'Provide a merge function that combines path results into a single output.',
    });
  }
  const built = frameworkCast<StepInParallel<TContext, I, O>>({
    kind: 'inParallel',
    ...opts,
  });
  getDefaultRegistrar().register(built);
  return built;
}

/**
 * Creates a conditional routing step that selects the next step at runtime.
 *
 * @public
 * @param opts.id - Unique step identifier used in traces and error messages.
 * @param opts.route - Routing function `(input, ctx) => Step | null`. Returns the next step
 *   to execute, or `null` to skip (pass input through as output). May be async.
 * @returns A `StepConditional` step.
 * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
 * @throws `NoeticConfigError` with code `MISSING_ROUTE_FUNCTION` if `route` is not provided.
 */
export function conditional<TContext = ContextData, I = unknown, O = unknown>(opts: {
  id: string;
  route: (
    input: I,
    ctx: Context<TContext>,
  ) => Step<TContext, I, O> | null | Promise<Step<TContext, I, O> | null>;
  _optimizable?: Step<TContext>[];
}): StepConditional<TContext, I, O> {
  if (!opts.id || opts.id.trim() === '') {
    throw new NoeticConfigError({
      code: 'EMPTY_STEP_ID',
      message: 'conditional() requires a non-empty id.',
      hint: 'Pass a unique string as the id field, e.g. conditional({ id: "my-conditional", ... }).',
    });
  }
  if (!opts.route) {
    throw new NoeticConfigError({
      code: 'MISSING_ROUTE_FUNCTION',
      message: 'conditional() requires a route function.',
      hint: 'Provide a route function that selects the next step at runtime.',
    });
  }
  const built: StepConditional<TContext, I, O> = {
    kind: 'conditional',
    ...opts,
  };
  getDefaultRegistrar().register(built);
  return built;
}
