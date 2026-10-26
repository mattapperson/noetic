/**
 * The one adapter between Noetic and JSONata (spec 33). It compiles
 * expressions with evaluation limits, reads node input, and turns JSONata's
 * thrown error objects into `NoeticConfigError`s, so no other module touches
 * the library or its error shapes.
 */

import { NoeticConfigError } from '@noetic-tools/types';
import jsonata from 'jsonata';

//#region Types

/** @public Bounds on one expression evaluation. Each field falls back to `DEFAULT_EXPRESSION_LIMITS`. */
export interface ExpressionLimits {
  /** Milliseconds one evaluation may run. */
  timeout?: number;
  /** How deep evaluation may nest, counting each function call and sub-expression. */
  depth?: number;
  /** The most items one sequence (JSONata's result list) may hold. */
  length?: number;
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

//#endregion

//#region Constants

/** @public The limits an expression runs under unless the host sets its own. */
export const DEFAULT_EXPRESSION_LIMITS: Readonly<Required<ExpressionLimits>> = {
  timeout: 1e3,
  depth: 500,
  length: 1e6,
};

/** JSONata codes for a guard tripping: stack depth, timeout, range size, sequence size. */
const LIMIT_CODES = new Set([
  'D1011',
  'D1012',
  'D2014',
  'D2015',
]);

//#endregion

//#region Public API

/**
 * Compiles `source` under `limits`.
 *
 * @throws `NoeticConfigError` with code `WORKFLOW_VALIDATION_FAILED` when `source` does not parse.
 */
export function compileExpression(
  source: string,
  where: string,
  limits?: ExpressionLimits,
): CompiledExpression {
  const bounds = {
    ...DEFAULT_EXPRESSION_LIMITS,
    ...limits,
  };
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
  return {
    where,
    run: async (input) => {
      try {
        return await compiled.evaluate(input);
      } catch (e) {
        throw translate(e, where);
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
  const result = await expr.run(input);
  if (result === undefined) {
    throw failed(expr.where, 'the expression gave no value; check the paths it reads.');
  }
  if (holdsFunction(result)) {
    throw failed(expr.where, 'the expression gave a function, which has no JSON form.');
  }
  return result;
}

/**
 * Evaluates a `when` test. `true` passes; `false` and JSONata's "no value"
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

/** JSONata's own failures become Noetic errors; anything else is a defect and passes through. */
function translate(e: unknown, where: string): unknown {
  if (!isJsonataFailure(e)) {
    return e;
  }
  if (LIMIT_CODES.has(e.code)) {
    return new NoeticConfigError({
      code: 'EXPRESSION_LIMIT_EXCEEDED',
      message: `Expression in ${where} exceeded a limit: ${describe(e)}`,
      hint: 'Bound the recursion or data size in the expression, or raise the limits via HydrationContext.expressionLimits.',
    });
  }
  return failed(where, describe(e));
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
