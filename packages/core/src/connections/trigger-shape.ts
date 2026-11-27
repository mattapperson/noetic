/**
 * Checks a trigger against the event its connection declares (spec 35
 * § Triggers), so a trigger and a server that disagree fail when the harness
 * starts instead of on the first event. The connection's manifest says what
 * the event carries (`payloadSchema`) and what a subscription may ask for
 * (`argumentsSchema`); for an MCP server these are `events/list`'s
 * `payloadSchema` and `inputSchema`.
 */

import type { ConnectionEventInfo, ConnectionTrigger, JsonSchemaObject } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { pathsOf } from '../expression/jsonata';
import { invalidConnectionError } from './errors';
import { isPlainRecord } from './values';

//#region Types

/** Says what is wrong with an event's payload, or nothing when it fits. */
export type PayloadCheck = (payload: unknown) => string | undefined;

/** What a trigger is checked against, for error messages. */
interface Subject {
  readonly trigger: string;
  readonly event: string;
  readonly connection: string;
}

//#endregion

//#region Public API

/**
 * Checks `trigger` against `info`, the event as its connection declares it:
 * the trigger's `arguments` are ones the event accepts, its expressions read
 * only payload fields the event has, and the payload it expects is one the
 * event gives. Returns the check each arriving payload must pass: the
 * trigger's own `payload` schema, when it has one.
 *
 * What the event declares is read as written, not enforced: a server's schema
 * this cannot make sense of is left unchecked rather than stopping the harness.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` when the two disagree, or
 *   the trigger's `payload` schema does not load.
 */
export function checkTrigger(trigger: ConnectionTrigger, info: ConnectionEventInfo): PayloadCheck {
  const subject: Subject = {
    trigger: trigger.id,
    event: trigger.event,
    connection: trigger.connection,
  };
  const offered = info.payloadSchema;
  checkArguments(trigger.arguments, info.argumentsSchema, subject);
  const expected = expectedPayload(trigger, subject);
  if (offered) {
    checkExpressions(trigger, offered, subject);
    checkExpected(expected?.json, offered, subject);
  }
  return (payload) => {
    const parsed = expected?.schema.safeParse(payload);
    return parsed === undefined || parsed.success
      ? undefined
      : `the payload does not match what trigger '${subject.trigger}' expects: ${firstIssue(parsed.error)}`;
  };
}

//#endregion

//#region Checks

function checkArguments(
  args: Readonly<Record<string, unknown>> | undefined,
  accepted: JsonSchemaObject | undefined,
  subject: Subject,
): void {
  const parsed = accepted && load(accepted)?.safeParse(args ?? {});
  if (parsed && !parsed.success) {
    throw invalidConnectionError(
      `Trigger '${subject.trigger}' gives arguments that ${eventOf(subject)} does not accept: ${firstIssue(parsed.error)}`,
      "Set the trigger's arguments to ones the event's arguments schema accepts.",
    );
  }
}

function checkExpressions(
  trigger: ConnectionTrigger,
  offered: JsonSchemaObject,
  subject: Subject,
): void {
  for (const field of [
    'filter',
    'input',
    'thread',
  ] as const) {
    const source = trigger[field];
    if (typeof source !== 'string') {
      continue;
    }
    const [missing] = unknownFields(source, offered);
    if (missing !== undefined) {
      throw invalidConnectionError(
        `Trigger '${subject.trigger}' reads '${missing}' in its ${field}, a field ${eventOf(subject)} does not declare.`,
        `Read a field of the event's payload schema: ${fieldsOf(offered).join(', ') || 'it declares none'}.`,
      );
    }
  }
}

function checkExpected(
  expected: JsonSchemaObject | undefined,
  offered: JsonSchemaObject,
  subject: Subject,
): void {
  const problem = expected && mismatch(expected, offered, 'payload');
  if (problem) {
    throw invalidConnectionError(
      `Trigger '${subject.trigger}' expects a payload ${eventOf(subject)} does not give: ${problem}.`,
      "Change the trigger's payload schema to fit the event's, or subscribe to the event that carries this shape.",
    );
  }
}

//#endregion

//#region Helpers

function eventOf(subject: Subject): string {
  return `event '${subject.event}' of connection '${subject.connection}'`;
}

function firstIssue(error: z.ZodError): string {
  const [issue] = error.issues;
  if (!issue) {
    return error.message;
  }
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** A JSON Schema as a validator, or nothing when it has a part zod cannot read. */
function load(schema: JsonSchemaObject): z.ZodType | undefined {
  try {
    return z.fromJSONSchema(frameworkCast<z.core.JSONSchema.JSONSchema>(schema));
  } catch {
    return undefined;
  }
}

/** The payload a trigger expects, as a validator and, when it has one, a JSON Schema. */
function expectedPayload(
  trigger: ConnectionTrigger,
  subject: Subject,
):
  | {
      schema: z.ZodType;
      json: JsonSchemaObject | undefined;
    }
  | undefined {
  const { payload } = trigger;
  if (payload === undefined) {
    return undefined;
  }
  if (!(payload instanceof z.ZodType)) {
    const schema = load(payload);
    if (!schema) {
      throw invalidConnectionError(
        `The payload schema of trigger '${subject.trigger}' does not load.`,
        'Declare a JSON Schema object (draft 2020-12).',
      );
    }
    return {
      schema,
      json: payload,
    };
  }
  return {
    schema: payload,
    json: jsonOf(payload),
  };
}

/** A zod schema as JSON Schema, or nothing when it has a part JSON Schema cannot say. */
function jsonOf(schema: z.ZodType): JsonSchemaObject | undefined {
  try {
    return z.toJSONSchema(schema, {
      io: 'input',
    });
  } catch {
    return undefined;
  }
}

/**
 * An object schema that lists its fields, so one it does not list is taken as
 * not there. JSON Schema lets an object carry more unless it says
 * `additionalProperties: false`, but a trigger that reads a field its event
 * never declares is far more often a wrong name than a field the server forgot.
 * A schema that says more may come (`additionalProperties` true or a schema,
 * `patternProperties`, a combinator, a `$ref`) is not checked.
 */
function closed(schema: unknown): schema is {
  properties: Record<string, unknown>;
} & Record<string, unknown> {
  return (
    isPlainRecord(schema) &&
    isPlainRecord(schema.properties) &&
    (schema.additionalProperties === undefined || schema.additionalProperties === false) &&
    [
      'patternProperties',
      'allOf',
      'anyOf',
      'oneOf',
      '$ref',
    ].every((key) => schema[key] === undefined)
  );
}

/** What a path step reads from: an array's items, since JSONata maps over arrays. */
function itemOf(schema: unknown): unknown {
  let at = schema;
  while (isPlainRecord(at) && at.type === 'array' && at.items !== undefined) {
    at = at.items;
  }
  return at;
}

function fieldsOf(schema: JsonSchemaObject): string[] {
  return closed(schema) ? Object.keys(schema.properties) : [];
}

/** The `event.payload…` paths in `source` that name a field `payload` does not declare. */
function unknownFields(source: string, payload: JsonSchemaObject): string[] {
  return pathsOf(source)
    .map((names) => unknownName(names, payload))
    .filter((missing) => missing !== undefined);
}

/** Follows an `event.payload.a.b` path through `payload`; the first name not declared. */
function unknownName(names: ReadonlyArray<string>, payload: JsonSchemaObject): string | undefined {
  if (names[0] !== 'event' || names[1] !== 'payload') {
    return undefined;
  }
  let at: unknown = payload;
  for (const [i, name] of names.slice(2).entries()) {
    at = itemOf(at);
    if (!closed(at)) {
      return undefined;
    }
    if (!Object.hasOwn(at.properties, name)) {
      return names.slice(0, i + 3).join('.');
    }
    at = at.properties[name];
  }
  return undefined;
}

/**
 * Why a value `offered` allows need not fit `expected`, as far as object
 * fields, array items and plain types show; nothing when they agree or the
 * schemas say too little to tell.
 */
function mismatch(expected: unknown, offered: unknown, path: string): string | undefined {
  if (!isPlainRecord(expected) || !isPlainRecord(offered)) {
    return undefined;
  }
  const want = expected.type;
  const given = offered.type;
  if (typeof want !== 'string' || typeof given !== 'string') {
    return undefined;
  }
  if (want !== given && !(want === 'number' && given === 'integer')) {
    return `${path} is ${given}, not ${want}`;
  }
  if (want === 'array') {
    return mismatch(expected.items, offered.items, `${path}[]`);
  }
  if (want !== 'object' || !closed(offered)) {
    return undefined;
  }
  const mustHave = Array.isArray(offered.required) ? offered.required : [];
  for (const key of Array.isArray(expected.required) ? expected.required : []) {
    if (typeof key !== 'string') {
      continue;
    }
    if (!Object.hasOwn(offered.properties, key)) {
      return `${path}.${key} is not declared`;
    }
    if (!mustHave.includes(key)) {
      return `${path}.${key} is optional there and required here`;
    }
  }
  const wanted = isPlainRecord(expected.properties) ? expected.properties : {};
  for (const [key, inner] of Object.entries(wanted)) {
    const problem = Object.hasOwn(offered.properties, key)
      ? mismatch(inner, offered.properties[key], `${path}.${key}`)
      : undefined;
    if (problem) {
      return problem;
    }
  }
  return undefined;
}

//#endregion
