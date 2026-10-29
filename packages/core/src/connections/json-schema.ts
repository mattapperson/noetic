/**
 * The JSON Schema subset the connection gates need (spec 35 § Gates, gate 2
 * and gate 6). A connection's manifest publishes operation schemas as JSON
 * Schema — from a profile through `z.toJSONSchema`, or from an MCP server's
 * tool list — so the harness checks arguments against them without a profile
 * object in hand.
 *
 * `validateJsonSchema` covers the keywords profiles and MCP tools use: `type`,
 * `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`,
 * `anyOf`/`oneOf`/`allOf`, string length and pattern, number bounds, and local
 * `$ref`s into `$defs`/`definitions`. Unknown keywords are ignored rather than
 * failing a call. Nothing is ever defaulted on the caller's behalf.
 */

import type { JsonSchemaObject } from '@noetic-tools/types';

//#region Types

/** One step into a value: an object key or an array index. */
export type JsonPath = ReadonlyArray<string | number>;

interface ValidationState {
  readonly root: JsonSchemaObject;
  readonly errors: string[];
  depth: number;
}

interface Visit {
  readonly schema: JsonSchemaObject;
  readonly value: unknown;
  readonly path: JsonPath;
}

type KeywordCheck = (visit: Visit, state: ValidationState) => void;

//#endregion

//#region Helpers

const MAX_DEPTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asSchema(value: unknown): JsonSchemaObject | undefined {
  return isRecord(value) ? value : undefined;
}

function asSchemaList(value: unknown): JsonSchemaObject[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

function formatPath(path: JsonPath): string {
  if (path.length === 0) {
    return '(root)';
  }
  return path
    .map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`))
    .join('')
    .slice(0);
}

function typeOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return typeof value;
}

function matchesType(expected: string, value: unknown): boolean {
  const actual = typeOf(value);
  if (expected === 'number') {
    return actual === 'number' || actual === 'integer';
  }
  return expected === actual;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Follows a local `$ref` (`#/$defs/X` or `#/definitions/X`); unknown refs resolve to `{}`. */
function deref(schema: JsonSchemaObject, root: JsonSchemaObject): JsonSchemaObject {
  const ref = schema.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#')) {
    return schema;
  }
  let current: unknown = root;
  for (const part of ref.slice(1).split('/').filter(Boolean)) {
    current = isRecord(current) ? current[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
  }
  return asSchema(current) ?? {};
}

/** Builds a `Visit`. */
function at(schema: JsonSchemaObject, value: unknown, path: JsonPath): Visit {
  return {
    schema,
    value,
    path,
  };
}

function errorsFor(visit: Visit, state: ValidationState): string[] {
  const sub: ValidationState = {
    root: state.root,
    errors: [],
    depth: state.depth,
  };
  check(visit, sub);
  return sub.errors;
}

const checkType: KeywordCheck = ({ schema, value, path }, state) => {
  const type = schema.type;
  const types = Array.isArray(type)
    ? type
    : typeof type === 'string'
      ? [
          type,
        ]
      : [];
  if (types.length === 0) {
    return;
  }
  if (types.some((t) => typeof t === 'string' && matchesType(t, value))) {
    return;
  }
  state.errors.push(`${formatPath(path)}: expected ${types.join(' | ')}, got ${typeOf(value)}`);
};

const checkEnum: KeywordCheck = ({ schema, value, path }, state) => {
  if ('const' in schema && !deepEqual(schema.const, value)) {
    state.errors.push(`${formatPath(path)}: expected ${JSON.stringify(schema.const)}`);
  }
  const options = schema.enum;
  if (!Array.isArray(options)) {
    return;
  }
  if (!options.some((option) => deepEqual(option, value))) {
    state.errors.push(`${formatPath(path)}: must be one of ${JSON.stringify(options)}`);
  }
};

const checkObject: KeywordCheck = ({ schema, value, path }, state) => {
  if (!isRecord(value)) {
    return;
  }
  const properties = asSchema(schema.properties) ?? {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key === 'string' && !(key in value)) {
      state.errors.push(
        `${formatPath([
          ...path,
          key,
        ])}: required`,
      );
    }
  }
  for (const [key, child] of Object.entries(value)) {
    const propertySchema = asSchema(properties[key]);
    if (propertySchema) {
      check(
        at(propertySchema, child, [
          ...path,
          key,
        ]),
        state,
      );
      continue;
    }
    if (schema.additionalProperties === false) {
      state.errors.push(
        `${formatPath([
          ...path,
          key,
        ])}: unexpected property`,
      );
      continue;
    }
    const additional = asSchema(schema.additionalProperties);
    if (additional) {
      check(
        at(additional, child, [
          ...path,
          key,
        ]),
        state,
      );
    }
  }
};

const checkArray: KeywordCheck = ({ schema, value, path }, state) => {
  if (!Array.isArray(value)) {
    return;
  }
  const items = asSchema(schema.items);
  if (items) {
    value.forEach((item, i) => {
      check(
        at(items, item, [
          ...path,
          i,
        ]),
        state,
      );
    });
  }
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    state.errors.push(`${formatPath(path)}: needs at least ${schema.minItems} items`);
  }
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
    state.errors.push(`${formatPath(path)}: allows at most ${schema.maxItems} items`);
  }
};

const checkString: KeywordCheck = ({ schema, value, path }, state) => {
  if (typeof value !== 'string') {
    return;
  }
  if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
    state.errors.push(`${formatPath(path)}: shorter than ${schema.minLength}`);
  }
  if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
    state.errors.push(`${formatPath(path)}: longer than ${schema.maxLength}`);
  }
  if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
    state.errors.push(`${formatPath(path)}: does not match ${schema.pattern}`);
  }
};

const checkNumber: KeywordCheck = ({ schema, value, path }, state) => {
  if (typeof value !== 'number') {
    return;
  }
  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    state.errors.push(`${formatPath(path)}: below ${schema.minimum}`);
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    state.errors.push(`${formatPath(path)}: above ${schema.maximum}`);
  }
  if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
    state.errors.push(`${formatPath(path)}: must exceed ${schema.exclusiveMinimum}`);
  }
  if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
    state.errors.push(`${formatPath(path)}: must be below ${schema.exclusiveMaximum}`);
  }
};

const checkCombinators: KeywordCheck = ({ schema, value, path }, state) => {
  for (const sub of asSchemaList(schema.allOf)) {
    check(
      {
        schema: sub,
        value: value,
        path: path,
      },
      state,
    );
  }
  const anyOf = [
    ...asSchemaList(schema.anyOf),
    ...asSchemaList(schema.oneOf),
  ];
  if (anyOf.length === 0) {
    return;
  }
  const passes = anyOf.some(
    (sub) =>
      errorsFor(
        {
          schema: sub,
          value,
          path,
        },
        state,
      ).length === 0,
  );
  if (!passes) {
    state.errors.push(`${formatPath(path)}: matches none of the allowed shapes`);
  }
};

const KEYWORD_CHECKS: ReadonlyArray<KeywordCheck> = [
  checkType,
  checkEnum,
  checkObject,
  checkArray,
  checkString,
  checkNumber,
  checkCombinators,
];

function check({ schema: rawSchema, value, path }: Visit, state: ValidationState): void {
  if (state.depth > MAX_DEPTH) {
    return;
  }
  state.depth += 1;
  const schema = deref(rawSchema, state.root);
  for (const keywordCheck of KEYWORD_CHECKS) {
    keywordCheck(
      {
        schema,
        value,
        path,
      },
      state,
    );
  }
  state.depth -= 1;
}

/** The branches a schema offers at one level: itself, or each `anyOf`/`oneOf` alternative. */
function branches(schema: JsonSchemaObject, root: JsonSchemaObject): JsonSchemaObject[] {
  const resolved = deref(schema, root);
  const alternatives = [
    ...asSchemaList(resolved.anyOf),
    ...asSchemaList(resolved.oneOf),
  ].map((s) => deref(s, root));
  const all = [
    resolved,
    ...alternatives,
    ...asSchemaList(resolved.allOf).map((s) => deref(s, root)),
  ];
  return all;
}

/** Whether a schema accepts a `{ $secret }` object at this level (a `sensitive()` field). */
function acceptsSecretHere(schema: JsonSchemaObject, root: JsonSchemaObject): boolean {
  return branches(schema, root).some((branch) => {
    const properties = asSchema(branch.properties);
    return properties !== undefined && '$secret' in properties;
  });
}

function childSchemas(
  schema: JsonSchemaObject,
  root: JsonSchemaObject,
  step: string | number,
): JsonSchemaObject[] {
  const found: JsonSchemaObject[] = [];
  for (const branch of branches(schema, root)) {
    if (typeof step === 'number') {
      const items = asSchema(branch.items);
      if (items) {
        found.push(items);
      }
      continue;
    }
    const property = asSchema(asSchema(branch.properties)?.[step]);
    if (property) {
      found.push(property);
      continue;
    }
    const additional = asSchema(branch.additionalProperties);
    if (additional) {
      found.push(additional);
    }
  }
  return found;
}

//#endregion

//#region Public API

/**
 * Checks `value` against a JSON Schema.
 * @returns One message per problem; empty when the value matches.
 */
export function validateJsonSchema(schema: JsonSchemaObject, value: unknown): string[] {
  const state: ValidationState = {
    root: schema,
    errors: [],
    depth: 0,
  };
  check(
    {
      schema: schema,
      value: value,
      path: [],
    },
    state,
  );
  return state.errors;
}

/**
 * Whether the field at `path` is `sensitive` — its schema accepts a
 * `{ $secret }` value (spec 36 `sensitive()` publishes as `anyOf: [T, { $secret }]`).
 */
export function secretAllowedAt(schema: JsonSchemaObject, path: JsonPath): boolean {
  let level: JsonSchemaObject[] = [
    schema,
  ];
  for (const step of path) {
    level = level.flatMap((s) => childSchemas(s, schema, step));
    if (level.length === 0) {
      return false;
    }
  }
  return level.some((s) => acceptsSecretHere(s, schema));
}

/** Renders a path the way validation messages do: `.thread.id`, `[0]`. */
export function describeJsonPath(path: JsonPath): string {
  return formatPath(path);
}

//#endregion
