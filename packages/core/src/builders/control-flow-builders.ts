import type { ContextData } from '@noetic-tools/context';
import type {
  Context,
  ExecuteStepFn,
  StepConditional,
  StepInParallel,
  StepInParallelAll,
  StepInParallelRace,
  StepInParallelSettle,
  Steps,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import { getDefaultRegistrar } from '../types/step-registrar';
import { toStep } from './sequence';

//#region Types

/**
 * Options for `inParallel()`, one shape per mode. `merge` is required for `all`
 * and `settle` and absent for `race`.
 * @public
 */
export type InParallelOpts<TContext = ContextData, I = unknown, O = unknown> =
  | InParallelRaceOpts<TContext, I, O>
  | InParallelAllOpts<TContext, I, O>
  | InParallelSettleOpts<TContext, I, O>;

/** Each parallel path is a step, or an array of steps run in sequence. */
interface PathsOpt<TContext, I, O> {
  paths: (input: I, ctx: Context<TContext>) => Array<Steps<TContext, I, O>>;
}

type InParallelRaceOpts<TContext, I, O> = Omit<
  StepInParallelRace<TContext, I, O>,
  'kind' | 'paths'
> &
  PathsOpt<TContext, I, O>;
type InParallelAllOpts<TContext, I, O> = Omit<StepInParallelAll<TContext, I, O>, 'kind' | 'paths'> &
  PathsOpt<TContext, I, O>;
type InParallelSettleOpts<TContext, I, O> = Omit<
  StepInParallelSettle<TContext, I, O>,
  'kind' | 'paths'
> &
  PathsOpt<TContext, I, O>;

/**
 * @public Options for `conditional()`. `route` may pick a step or an array of
 * steps run in sequence.
 */
export type ConditionalOpts<TContext = ContextData, I = unknown, O = unknown> = Omit<
  StepConditional<TContext, I, O>,
  'kind' | 'route'
> & {
  route: (
    input: I,
    ctx: Context<TContext>,
    run: ExecuteStepFn,
  ) => Steps<TContext, I, O> | null | Promise<Steps<TContext, I, O> | null>;
};

//#endregion

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
export function inParallel<TContext = ContextData, I = unknown, O = unknown>(
  opts: InParallelRaceOpts<TContext, I, O>,
): StepInParallelRace<TContext, I, O>;

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
export function inParallel<TContext = ContextData, I = unknown, O = unknown>(
  opts: InParallelAllOpts<TContext, I, O>,
): StepInParallelAll<TContext, I, O>;

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
export function inParallel<TContext = ContextData, I = unknown, O = unknown>(
  opts: InParallelSettleOpts<TContext, I, O>,
): StepInParallelSettle<TContext, I, O>;

export function inParallel<TContext = ContextData, I = unknown, O = unknown>(
  opts: InParallelOpts<TContext, I, O>,
): StepInParallel<TContext, I, O> {
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
  const paths = opts.paths;
  const built = frameworkCast<StepInParallel<TContext, I, O>>({
    kind: 'inParallel',
    ...opts,
    paths: (input: I, ctx: Context<TContext>) => paths(input, ctx).map((path) => toStep(path)),
  });
  getDefaultRegistrar().register(built);
  return built;
}

/**
 * Creates a conditional routing step that selects the next step at runtime.
 *
 * @public
 * @param opts.id - Unique step identifier used in traces and error messages.
 * @param opts.route - Routing function `(input, ctx, run) => Step | null`. Returns the next step
 *   to execute, or `null` to skip (pass input through as output). May be async. `run`
 *   executes a step through the interpreter, for routes that must run one to choose.
 * @returns A `StepConditional` step.
 * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
 * @throws `NoeticConfigError` with code `MISSING_ROUTE_FUNCTION` if `route` is not provided.
 */
export function conditional<TContext = ContextData, I = unknown, O = unknown>(
  opts: ConditionalOpts<TContext, I, O>,
): StepConditional<TContext, I, O> {
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
  const route = opts.route;
  const built: StepConditional<TContext, I, O> = {
    kind: 'conditional',
    ...opts,
    route: async (input, ctx, run) => {
      const picked = await route(input, ctx, run);
      return picked === null ? null : toStep(picked);
    },
  };
  getDefaultRegistrar().register(built);
  return built;
}
