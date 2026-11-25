/**
 * A question held for a person (spec 08 § Held tool calls, `reason: 'question'`):
 * checking that an answer fits the question's form.
 *
 * A question's `schema` is the flat form both askers use — MCP Tasks
 * `input_required` and ACP `elicitation/create`: an object whose properties are
 * strings, numbers, integers or booleans, optionally from an `enum`, some of them
 * `required`. Anything richer is not checked beyond being an object.
 */

import type { HeldQuestion } from '@noetic-tools/types';

//#region Types

type Checker = (value: unknown) => boolean;

//#endregion

//#region Helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const TYPE_CHECKS: Record<string, Checker> = {
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => typeof value === 'number' && Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
};

/** Why `value` does not fit the property `name`'s schema, or undefined when it does. */
function propertyProblem(name: string, schema: unknown, value: unknown): string | undefined {
  if (!isRecord(schema)) {
    return undefined;
  }
  const type = schema.type;
  const check = typeof type === 'string' ? TYPE_CHECKS[type] : undefined;
  if (check && !check(value)) {
    return `'${name}' must be a ${String(type)}`;
  }
  const choices = schema.enum;
  if (Array.isArray(choices) && !choices.includes(value)) {
    return `'${name}' must be one of ${JSON.stringify(choices)}`;
  }
  return undefined;
}

function requiredOf(schema: Readonly<Record<string, unknown>>): string[] {
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
 * question has no form).
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
    if (answer[name] === undefined) {
      return `'${name}' is required`;
    }
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [name, value] of Object.entries(answer)) {
    const problem = propertyProblem(name, properties[name], value);
    if (problem) {
      return problem;
    }
  }
  return undefined;
}

//#endregion
