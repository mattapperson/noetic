import { frameworkCast } from '../interpreter/framework-cast';
import type { Context } from '../types/context';
import type {
  SettleResult,
  Step,
  StepBranch,
  StepFork,
  StepForkAll,
  StepForkRace,
  StepForkSettle,
} from '../types/step';

/**
 * Creates a parallel execution step that races paths and returns the first result.
 *
 * @param opts.id - Unique step identifier used in traces and error messages.
 * @param opts.mode - Must be `'race'`: first path to resolve wins, others are cancelled.
 * @param opts.paths - Factory `(input, ctx) => Step[]` generating the parallel paths.
 * @param opts.concurrency - Optional maximum number of paths to run simultaneously.
 * @returns A `StepForkRace` step.
 */
export function fork<I, O>(opts: {
  id: string;
  mode: 'race';
  paths: (input: I, ctx: Context) => Step<I, O>[];
  concurrency?: number;
  _optimizable?: Step[];
}): StepForkRace<I, O>;

/**
 * Creates a parallel execution step that waits for all paths and merges results.
 *
 * @param opts.id - Unique step identifier used in traces and error messages.
 * @param opts.mode - Must be `'all'`: waits for every path; fails on any error.
 * @param opts.paths - Factory `(input, ctx) => Step[]` generating the parallel paths.
 * @param opts.merge - Combines all path results into a single output value.
 * @param opts.concurrency - Optional maximum number of paths to run simultaneously.
 * @returns A `StepForkAll` step.
 */
export function fork<I, O>(opts: {
  id: string;
  mode: 'all';
  paths: (input: I, ctx: Context) => Step<I, O>[];
  merge: (results: O[], ctx: Context) => O;
  concurrency?: number;
  _optimizable?: Step[];
}): StepForkAll<I, O>;

/**
 * Creates a parallel execution step that waits for all paths, collecting errors as results.
 *
 * @param opts.id - Unique step identifier used in traces and error messages.
 * @param opts.mode - Must be `'settle'`: waits for every path; errors are captured, not thrown.
 * @param opts.paths - Factory `(input, ctx) => Step[]` generating the parallel paths.
 * @param opts.merge - Combines settled results (successes and failures) into a single output.
 * @param opts.concurrency - Optional maximum number of paths to run simultaneously.
 * @returns A `StepForkSettle` step.
 */
export function fork<I, O>(opts: {
  id: string;
  mode: 'settle';
  paths: (input: I, ctx: Context) => Step<I, O>[];
  merge: (results: SettleResult<O>[], ctx: Context) => O;
  concurrency?: number;
  _optimizable?: Step[];
}): StepForkSettle<I, O>;

export function fork<I, O>(opts: {
  id: string;
  mode: 'race' | 'all' | 'settle';
  paths: (input: I, ctx: Context) => Step<I, O>[];
  merge?: ((results: O[], ctx: Context) => O) | ((results: SettleResult<O>[], ctx: Context) => O);
  concurrency?: number;
  _optimizable?: Step[];
}): StepFork<I, O> {
  if (!opts.id || opts.id.trim() === '') {
    throw new Error('fork requires a non-empty id');
  }
  if ((opts.mode === 'all' || opts.mode === 'settle') && !opts.merge) {
    throw new Error(`fork mode '${opts.mode}' requires a merge function`);
  }
  return frameworkCast<StepFork<I, O>>({
    kind: 'fork',
    ...opts,
  });
}

/**
 * Creates a conditional routing step that selects the next step at runtime.
 *
 * @param opts.id - Unique step identifier used in traces and error messages.
 * @param opts.route - Routing function `(input, ctx) => Step | null`. Returns the next step
 *   to execute, or `null` to skip (pass input through as output). May be async.
 * @returns A `StepBranch` step.
 */
export function branch<I, O>(opts: {
  id: string;
  route: (input: I, ctx: Context) => Step<I, O> | null | Promise<Step<I, O> | null>;
  _optimizable?: Step[];
}): StepBranch<I, O> {
  if (!opts.id || opts.id.trim() === '') {
    throw new Error('branch requires a non-empty id');
  }
  if (!opts.route) {
    throw new Error('branch requires a route function');
  }
  return {
    kind: 'branch',
    ...opts,
  };
}
