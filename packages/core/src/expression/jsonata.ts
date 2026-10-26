/**
 * The one adapter between Noetic and JSONata (spec 33). It compiles
 * expressions with evaluation limits, reads node input, and turns JSONata's
 * thrown error objects into `NoeticConfigError`s, so no other module touches
 * the library or its error shapes.
 */

import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import jsonata from 'jsonata';

//#region Types

/**
 * @public Bounds on one expression evaluation. Each field is a positive
 * integer or `Infinity` (no bound) and falls back to `DEFAULT_EXPRESSION_LIMITS`.
 */
export interface ExpressionLimits {
  /**
   * Wall-clock milliseconds one evaluation may run. Checked only as each
   * sub-expression starts, so one long built-in call runs to its end. Workers
   * freeze `Date.now()` during pure CPU work, so there `steps` is the bound that holds.
   */
  timeout?: number;
  /** How deep evaluation may nest, counting each sub-expression and function call. Tail calls do not nest. */
  depth?: number;
  /** The most items one sequence (JSONata's result list) or range may hold. */
  length?: number;
  /** How many sub-expressions one evaluation may evaluate, counting each repeat. Independent of the clock. */
  steps?: number;
}

/** A compiled expression, ready to run against node input. */
export interface CompiledExpression {
  /** Names the expression's owner in error messages, e.g. `compute node 'step'`. */
  where: string;
  /** Evaluates against `input`, already read by `readInput`. Resolves to JSONata's raw result. */
  run(input: unknown): Promise<unknown>;
}

/** JSONata throws plain objects, not `Error`s. */
interface JsonataFailure {
  code: string;
  message?: string;
  position?: number;
}

/** The part of JSONata's evaluation frame the step hook reads: the per-evaluation root frame. */
interface Frame {
  base: object;
}

//#endregion

//#region Constants

/** The code the step hook throws; not one of JSONata's. */
const STEPS_CODE = 'NOETIC_STEPS';

/** @public The limits an expression runs under unless the host sets its own. */
export const DEFAULT_EXPRESSION_LIMITS: Readonly<Required<ExpressionLimits>> = {
  timeout: 1e3,
  depth: 500,
  length: 1e6,
  steps: 1e6,
};

/** The codes thrown when a guard trips, mapped to the limit each enforces. */
const LIMIT_CODES: Readonly<Record<string, keyof ExpressionLimits>> = {
  D1011: 'depth',
  D1012: 'timeout',
  D2015: 'length',
  [STEPS_CODE]: 'steps',
};

/** JSONata's code for its fixed cap of 1e7 items on a range, which holds whatever `length` is. */
const RANGE_CAP_CODE = 'D2014';

/**
 * JSONata calls the function bound to this symbol as each sub-expression
 * starts. The hook is undocumented (JSONata's own test suite builds its
 * timebox on it), which is one reason the library's version is pinned.
 */
const EVALUATE_ENTRY = Symbol.for('jsonata.__evaluate_entry');

//#endregion

//#region Public API

/**
 * Compiles `source` under `limits`. Every `run` gets fresh budgets: the clock,
 * depth, and step count start over per evaluation.
 *
 * @throws `NoeticConfigError` with code `INVALID_EXPRESSION_LIMITS` when a limit is not a positive integer or `Infinity`.
 * @throws `NoeticConfigError` with code `WORKFLOW_VALIDATION_FAILED` when `source` does not parse.
 */
export function compileExpression(
  source: string,
  where: string,
  limits?: ExpressionLimits,
): CompiledExpression {
  const bounds = checkLimits(limits);
  let compiled: jsonata.Expression;
  try {
    compiled = jsonata(source, {
      timeout: bounds.timeout,
      stack: bounds.depth,
      sequence: bounds.length,
    });
  } catch (e) {
    throw new NoeticConfigError({
      code: 'WORKFLOW_VALIDATION_FAILED',
      message: `Expression in ${where} does not parse: ${describe(e)}`,
      hint: 'Fix the JSONata syntax; see https://docs.jsonata.org for the language.',
    });
  }
  countSteps(compiled, bounds.steps);
  return {
    where,
    run: async (input) => {
      try {
        return await compiled.evaluate(input);
      } catch (e) {
        throw translate(e, where, bounds);
      }
    },
  };
}

/** The parse error in `source`, or `undefined` when it compiles. */
export function syntaxError(source: string): string | undefined {
  try {
    jsonata(source);
    return undefined;
  } catch (e) {
    return describe(e);
  }
}

/**
 * Evaluates a `compute` expression. JSONata's "no value" (`undefined`) and a
 * result holding a function, at any depth, have no JSON form, so both fail
 * rather than turn silently into empty or garbled output.
 *
 * @throws `NoeticConfigError` with code `EXPRESSION_FAILED` or `EXPRESSION_LIMIT_EXCEEDED`.
 */
export async function compute(expr: CompiledExpression, input: unknown): Promise<unknown> {
  const result = await computeMaybe(expr, input);
  if (result === undefined) {
    throw failed(expr.where, 'the expression gave no value; check the paths it reads.');
  }
  return result;
}

/**
 * Evaluates like `compute`, except that "no value" resolves to `undefined`
 * instead of failing, for callers where nothing is a valid answer.
 *
 * @throws `NoeticConfigError` with code `EXPRESSION_FAILED` or `EXPRESSION_LIMIT_EXCEEDED`.
 */
export async function computeMaybe(expr: CompiledExpression, input: unknown): Promise<unknown> {
  const result = await expr.run(input);
  if (holdsFunction(result)) {
    throw failed(expr.where, 'the expression gave a function, which has no JSON form.');
  }
  return result;
}

/**
 * Evaluates an `expr` test. `true` passes; `false` and JSONata's "no value"
 * (`undefined`, e.g. a path that matched nothing) do not; anything else fails.
 *
 * @throws `NoeticConfigError` with code `EXPRESSION_FAILED` or `EXPRESSION_LIMIT_EXCEEDED`.
 */
export async function passes(expr: CompiledExpression, input: unknown): Promise<boolean> {
  const result = await expr.run(input);
  if (result === undefined) {
    return false;
  }
  if (typeof result === 'boolean') {
    return result;
  }
  throw failed(expr.where, `a test must give a boolean, got ${typeName(result)}.`);
}

/**
 * Reads a node's input as an expression sees it: a string is parsed as JSON
 * when it parses, else kept as the raw string; any other value is used as is.
 */
export function readInput(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

//#endregion

//#region Helpers

/** `limits` over the defaults (an unset field takes its default); anything but a positive integer or `Infinity` throws. */
function checkLimits(limits: ExpressionLimits | undefined): Required<ExpressionLimits> {
  const bounds = {
    timeout: limits?.timeout ?? DEFAULT_EXPRESSION_LIMITS.timeout,
    depth: limits?.depth ?? DEFAULT_EXPRESSION_LIMITS.depth,
    length: limits?.length ?? DEFAULT_EXPRESSION_LIMITS.length,
    steps: limits?.steps ?? DEFAULT_EXPRESSION_LIMITS.steps,
  };
  for (const [name, value] of Object.entries(bounds)) {
    if (value !== Number.POSITIVE_INFINITY && !(Number.isInteger(value) && value >= 1)) {
      throw new NoeticConfigError({
        code: 'INVALID_EXPRESSION_LIMITS',
        message: `Expression limit '${name}' must be a positive integer or Infinity, got ${value}.`,
        hint: 'Pass positive integers (see DEFAULT_EXPRESSION_LIMITS for the defaults), or Infinity to lift one bound.',
      });
    }
  }
  return bounds;
}

/**
 * Bounds each evaluation of `compiled` to `max` sub-expressions. JSONata's
 * depth guard misses tail calls, which it runs in a loop, and its timeout
 * reads a clock that Workers freeze during CPU work, so this count is the
 * one bound on every runtime. JSONata gives each evaluation a fresh root
 * frame (`base`), so counts keyed on it never mix between concurrent runs.
 */
function countSteps(compiled: jsonata.Expression, max: number): void {
  if (max === Number.POSITIVE_INFINITY) {
    return;
  }
  const used = new WeakMap<object, number>();
  const hook = (_expr: unknown, _input: unknown, frame: Frame): void => {
    const n = (used.get(frame.base) ?? 0) + 1;
    if (n > max) {
      throw {
        code: STEPS_CODE,
      } satisfies JsonataFailure;
    }
    used.set(frame.base, n);
  };
  // JSONata's types name bindings by string, but its frames take symbols too.
  compiled.assign(frameworkCast<string>(EVALUATE_ENTRY), hook);
}

/** JSONata gives a lambda or a bound built-in as a tagged object, a native function as itself. */
function isJsonataFailure(e: unknown): e is JsonataFailure {
  return typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string';
}

function describe(e: unknown): string {
  if (!isJsonataFailure(e)) {
    return e instanceof Error ? e.message : String(e);
  }
  const at = e.position === undefined ? '' : ` at position ${e.position}`;
  return `${e.message ?? 'JSONata error'} (${e.code}${at})`;
}

/**
 * Turns what an evaluation threw into a Noetic error. JSONata's failures and
 * the JS errors its built-ins throw on bad input (a `TypeError` from
 * `$base64encode` where no `Buffer` exists, say) are the expression's fault,
 * so both become `NoeticConfigError`s. A native stack overflow is a limit:
 * evaluation itself never grows the JS stack (each sub-expression awaits),
 * but a built-in that walks deeply nested input (`$string`, `**`) recurses
 * natively, outside the `depth` count. Anything else is a defect and passes through.
 */
function translate(e: unknown, where: string, bounds: Required<ExpressionLimits>): unknown {
  if (e instanceof RangeError && e.message.includes('call stack')) {
    return exceeded(where, 'the JavaScript call stack; the data it walks nests too deeply');
  }
  if (e instanceof Error) {
    return failed(where, `${e.name}: ${e.message}`);
  }
  if (!isJsonataFailure(e)) {
    return e;
  }
  if (e.code === RANGE_CAP_CODE) {
    return exceeded(where, "JSONata's fixed cap of 1e7 items on a range");
  }
  const limit = LIMIT_CODES[e.code];
  if (limit !== undefined) {
    return exceeded(where, `its ${limit} limit of ${bounds[limit]}`);
  }
  return failed(where, describe(e));
}

function exceeded(where: string, what: string): NoeticConfigError {
  return new NoeticConfigError({
    code: 'EXPRESSION_LIMIT_EXCEEDED',
    message: `Expression in ${where} exceeded ${what}.`,
    hint: 'Bound the recursion or data size in the expression, or raise expressionLimits (Infinity lifts one bound).',
  });
}

function failed(where: string, message: string): NoeticConfigError {
  return new NoeticConfigError({
    code: 'EXPRESSION_FAILED',
    message: `Expression in ${where} failed: ${message}`,
    hint: 'Fix the expression or the input it reads; see https://docs.jsonata.org for the language.',
  });
}

/**
 * True when `value` is or contains a function. JSONata hands back its
 * functions as plain objects tagged `_jsonata_function` (built-ins) or
 * `_jsonata_lambda` (user lambdas, whose captured scope can be cyclic), so a
 * `typeof` check alone misses them.
 */
function holdsFunction(value: unknown): boolean {
  if (typeof value === 'function') {
    return true;
  }
  if (Array.isArray(value)) {
    // Only items count: a sequence under the length limit carries its own `push` guard.
    return value.some(holdsFunction);
  }
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if ('_jsonata_function' in value || '_jsonata_lambda' in value) {
    return true;
  }
  return Object.values(value).some(holdsFunction);
}

function typeName(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'array' : typeof value;
}

//#endregion
