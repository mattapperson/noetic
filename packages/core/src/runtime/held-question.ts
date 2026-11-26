/**
 * A question held for a person (spec 08 § Held tool calls, `reason: 'question'`):
 * checking that an answer fits the question's form before the question settles.
 *
 * A question's `schema` is the flat form both askers use — MCP Tasks
 * `input_required` and ACP `elicitation/create`: an object whose own properties
 * are strings, numbers, integers, booleans or arrays of strings, with the usual
 * constraints (`enum`, `minLength`/`maxLength`, `pattern`, `minimum`/`maximum`,
 * `minItems`/`maxItems`), some of them `required`, and `additionalProperties: false`
 * to refuse any other field.
 *
 * A field's choices (`enum`, `oneOf`/`anyOf` consts, `items.enum`, `items.anyOf`) are
 * suggestions, never a limit: a person may always type an answer of their own, and the
 * asker decides what to make of it.
 */

import type { HeldQuestion } from '@noetic-tools/types';

//#region Types

type Schema = Record<string, unknown>;

/** Why a value does not fit a property's schema, or undefined. */
type PropertyCheck = (name: string, schema: Schema, value: unknown) => string | undefined;

//#endregion

//#region Helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberAt(schema: Schema, key: string): number | undefined {
  const value = schema[key];
  return typeof value === 'number' ? value : undefined;
}

function checkString(name: string, schema: Schema, value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return `'${name}' must be a string`;
  }
  // JSON Schema counts characters as code points, not UTF-16 units.
  const length = [
    ...value,
  ].length;
  const min = numberAt(schema, 'minLength');
  if (min !== undefined && length < min) {
    return `'${name}' must be at least ${min} characters`;
  }
  const max = numberAt(schema, 'maxLength');
  if (max !== undefined && length > max) {
    return `'${name}' must be at most ${max} characters`;
  }
  const pattern = schema.pattern;
  if (typeof pattern === 'string' && !new RegExp(pattern, 'u').test(value)) {
    return `'${name}' must match ${pattern}`;
  }
  return undefined;
}

function checkRange(name: string, schema: Schema, value: number): string | undefined {
  const min = numberAt(schema, 'minimum');
  if (min !== undefined && value < min) {
    return `'${name}' must be at least ${min}`;
  }
  const max = numberAt(schema, 'maximum');
  if (max !== undefined && value > max) {
    return `'${name}' must be at most ${max}`;
  }
  return undefined;
}

function checkNumber(name: string, schema: Schema, value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `'${name}' must be a number`;
  }
  return checkRange(name, schema, value);
}

function checkInteger(name: string, schema: Schema, value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return `'${name}' must be an integer`;
  }
  return checkRange(name, schema, value);
}

function checkBoolean(name: string, _schema: Schema, value: unknown): string | undefined {
  return typeof value === 'boolean' ? undefined : `'${name}' must be a boolean`;
}

function checkArray(name: string, schema: Schema, value: unknown): string | undefined {
  // `Array.from` fills holes with `undefined`, which `every` would skip.
  if (!Array.isArray(value) || !Array.from(value).every((item) => typeof item === 'string')) {
    return `'${name}' must be a list of strings`;
  }
  const min = numberAt(schema, 'minItems');
  if (min !== undefined && value.length < min) {
    return `'${name}' must have at least ${min} items`;
  }
  const max = numberAt(schema, 'maxItems');
  if (max !== undefined && value.length > max) {
    return `'${name}' must have at most ${max} items`;
  }
  return undefined;
}

const TYPE_CHECKS: Record<string, PropertyCheck> = {
  string: checkString,
  number: checkNumber,
  integer: checkInteger,
  boolean: checkBoolean,
  array: checkArray,
};

/** Why `value` does not fit the property `name`'s schema, or undefined when it does. */
function propertyProblem(name: string, schema: unknown, value: unknown): string | undefined {
  if (!isRecord(schema)) {
    return undefined;
  }
  const type = schema.type;
  const check = typeof type === 'string' ? TYPE_CHECKS[type] : undefined;
  return check?.(name, schema, value);
}

function requiredOf(schema: Readonly<Schema>): string[] {
  const required = schema.required;
  if (!Array.isArray(required)) {
    return [];
  }
  return required.filter((name): name is string => typeof name === 'string');
}

//#endregion

//#region Public API

/**
 * Why `answer` does not fit `question`'s form, or undefined when it does (or the
 * question has no form). Only the answer's own fields count.
 * @internal
 */
export function questionAnswerProblem(
  question: HeldQuestion | undefined,
  answer: unknown,
): string | undefined {
  const schema = question?.schema;
  if (!schema) {
    return undefined;
  }
  if (!isRecord(answer)) {
    return 'the answer must be an object of the form’s fields';
  }
  for (const name of requiredOf(schema)) {
    if (!Object.hasOwn(answer, name) || answer[name] === undefined) {
      return `'${name}' is required`;
    }
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const closed = schema.additionalProperties === false;
  for (const [name, value] of Object.entries(answer)) {
    const described = Object.hasOwn(properties, name);
    if (!described && closed) {
      return `'${name}' is not a field of the form`;
    }
    const problem = described ? propertyProblem(name, properties[name], value) : undefined;
    if (problem) {
      return problem;
    }
  }
  return undefined;
}

//#endregion
