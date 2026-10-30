/**
 * The connection side of JSON workflows (spec 35 § JSON workflows, § What a
 * document may use): which connection each `call`, `wait` and `verify` node
 * runs on, the operations and events a document uses per manifest entry, the
 * requirement each entry negotiates, value wrappers, and the host allowlist.
 */

import type {
  ConnectionAllowlist,
  ConnectionAllowlistEntry,
  ConnectionHandle,
  ConnectionRequirement,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError, parseProfileRequirement } from '@noetic-tools/types';
import type {
  CompiledExpression,
  ExpressionBindings,
  ExpressionLimits,
} from '../expression/jsonata';
import { compileExpression, compute, computeMaybe } from '../expression/jsonata';
import type {
  WorkflowArgs,
  WorkflowConnectionRef,
  WorkflowConnectionRequirement,
  WorkflowDocument,
  WorkflowNode,
  WorkflowStepEntry,
  WorkflowStepList,
  WorkflowValue,
} from '../schemas/workflow';
import { isWorkflowOpShorthand, stepListEntries } from '../schemas/workflow';

//#region Types

/** The manifest a document declares, by the names its nodes use. */
export type ConnectionManifestEntries = Readonly<Record<string, WorkflowConnectionRequirement>>;

/** A secret a document uses: its name and the `op.field` it fills. */
export interface SecretUse {
  name: string;
  op: string;
  field: string;
}

/** What a document uses of one manifest entry, worked out from its nodes. */
export interface ConnectionUse {
  ops: Set<string>;
  events: Set<string>;
  secrets: SecretUse[];
}

/** Manifest name → what the document uses of it. */
export type ConnectionUses = Map<string, ConnectionUse>;

/** A compiled argument value: resolves against a node's input and bindings. */
export type ValueTemplate = (input: unknown, bindings: ExpressionBindings) => Promise<unknown>;

/** Where a walk is: the connection names an entry without its own resolves to. */
interface WalkScope {
  manifest: ConnectionManifestEntries;
  /** Names an operation written by name, or a node without `connection`, runs on. */
  enclosing: ReadonlyArray<string> | undefined;
  /** Names `{ "$expr": "$item" }` takes inside a connection fan-out. */
  fanOut: ReadonlyArray<string> | undefined;
  uses: ConnectionUses;
}

/** The internal requirement a document handle carries in place of a profile object. */
interface DocumentHandleFields {
  _requirement?: ConnectionRequirement;
}

//#endregion

//#region Errors

function unknownConnection(
  name: string,
  where: string,
  manifest: ConnectionManifestEntries,
): NoeticConfigError {
  const declared = Object.keys(manifest);
  return new NoeticConfigError({
    code: 'CONNECTION_UNKNOWN',
    message: `${where} uses connection '${name}', which the document's connections do not declare.`,
    hint:
      declared.length > 0
        ? `Use one of ${declared.join(', ')}, or add '${name}' to the document's "connections".`
        : `Declare it in the document: "connections": { "${name}": { "profile": "<profile>@<range>" } }.`,
  });
}

function noConnection(where: string, manifest: ConnectionManifestEntries): NoeticConfigError {
  return new NoeticConfigError({
    code: 'CONNECTION_INVALID',
    message: `${where} names no connection, and the document has ${Object.keys(manifest).length} connections, so none is implied.`,
    hint: 'Give the node a "connection", or run it inside a verify whose subject is the connection.',
  });
}

function notAllowed(message: string, hint: string): NoeticConfigError {
  return new NoeticConfigError({
    code: 'CONNECTION_NOT_ALLOWED',
    message,
    hint,
  });
}

//#endregion

//#region Value wrappers

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `value` is a wrapper whose one key is `key`. */
function isWrapper(value: unknown, key: string): boolean {
  return isObject(value) && Object.hasOwn(value, key) && Object.keys(value).length === 1;
}

/** Whether a value passes through as is: a `$secret`, `$ref` or `$blob` the registry resolves. */
function isOpaqueWrapper(value: unknown): boolean {
  return isWrapper(value, '$secret') || isWrapper(value, '$ref') || isWrapper(value, '$blob');
}

function compileExprValue(
  value: Record<string, unknown>,
  where: string,
  limits: ExpressionLimits | undefined,
): ValueTemplate {
  const compiled = compileExpression(String(value.$expr), where, limits);
  return (input, bindings) => computeMaybe(compiled, input, bindings);
}

function compileArray(
  values: unknown[],
  where: string,
  limits: ExpressionLimits | undefined,
): ValueTemplate {
  const items = values.map((v) => compileValue(frameworkCast<WorkflowValue>(v), where, limits));
  return async (input, bindings) => {
    const out: unknown[] = [];
    for (const item of items) {
      const resolved = await item(input, bindings);
      out.push(resolved === undefined ? null : resolved);
    }
    return out;
  };
}

function compileObject(
  value: Record<string, unknown>,
  where: string,
  limits: ExpressionLimits | undefined,
): ValueTemplate {
  const fields = Object.entries(value).map(
    ([key, v]) =>
      [
        key,
        compileValue(frameworkCast<WorkflowValue>(v), where, limits),
      ] as const,
  );
  return async (input, bindings) => {
    const out: Record<string, unknown> = {};
    for (const [key, field] of fields) {
      const resolved = await field(input, bindings);
      // An expression with no value leaves the field out rather than sending null.
      if (resolved !== undefined) {
        out[key] = resolved;
      }
    }
    return out;
  };
}

/**
 * Compiles a connection argument value (spec 35 § JSON workflows, Values):
 * `{ "$expr" }` evaluates against the node's input, `{ "$literal" }` passes its
 * value through untouched, `{ "$secret" }`, `{ "$ref" }` and `{ "$blob" }` pass
 * through for the registry to resolve, and arrays and objects compile field by field.
 *
 * @throws `NoeticConfigError` `WORKFLOW_VALIDATION_FAILED` when an expression does not parse.
 */
export function compileValue(
  value: WorkflowValue,
  where: string,
  limits: ExpressionLimits | undefined,
): ValueTemplate {
  if (Array.isArray(value)) {
    return compileArray(value, where, limits);
  }
  if (!isObject(value)) {
    return async () => value;
  }
  if (isWrapper(value, '$expr')) {
    return compileExprValue(value, where, limits);
  }
  if (isWrapper(value, '$literal')) {
    const literal = value.$literal;
    return async () => literal;
  }
  if (isOpaqueWrapper(value)) {
    return async () => value;
  }
  return compileObject(value, where, limits);
}

/**
 * Compiles a node's `args`: an object of values, or one `{ "$expr" }` computing
 * them all (which must give a value).
 */
export function compileArgs(
  args: WorkflowArgs | undefined,
  where: string,
  limits: ExpressionLimits | undefined,
): ValueTemplate {
  if (args === undefined) {
    return async () => ({});
  }
  if (isWrapper(args, '$expr')) {
    const compiled: CompiledExpression = compileExpression(
      String(frameworkCast<Record<string, unknown>>(args).$expr),
      where,
      limits,
    );
    return (input, bindings) => compute(compiled, input, bindings);
  }
  return compileValue(frameworkCast<WorkflowValue>(args), where, limits);
}

//#endregion

//#region Connection resolution

/**
 * The manifest names a node's connection ref stands for: one name, every fan-out
 * name for an expression inside a fan-out, or the enclosing connection(s) when absent.
 *
 * @throws `NoeticConfigError` `CONNECTION_UNKNOWN` for a name the manifest does not declare; `CONNECTION_INVALID` when no connection is named or implied.
 */
function namesOf(
  ref: WorkflowConnectionRef | undefined,
  where: string,
  scope: WalkScope,
): ReadonlyArray<string> {
  if (typeof ref === 'string') {
    if (!Object.hasOwn(scope.manifest, ref)) {
      throw unknownConnection(ref, where, scope.manifest);
    }
    return [
      ref,
    ];
  }
  if (ref !== undefined) {
    // An expression picks at run time: within a fan-out, any of its names.
    return scope.fanOut ?? Object.keys(scope.manifest);
  }
  if (scope.enclosing) {
    return scope.enclosing;
  }
  const declared = Object.keys(scope.manifest);
  if (declared.length === 1) {
    return declared;
  }
  throw noConnection(where, scope.manifest);
}

function useOf(scope: WalkScope, name: string): ConnectionUse {
  const existing = scope.uses.get(name);
  if (existing) {
    return existing;
  }
  const created: ConnectionUse = {
    ops: new Set(),
    events: new Set(),
    secrets: [],
  };
  scope.uses.set(name, created);
  return created;
}

/** Every `{ "$secret" }` in a value, with the dotted path of the field holding it. */
function secretsIn(
  value: unknown,
  path: string[],
): Array<{
  name: string;
  field: string;
}> {
  if (isWrapper(value, '$secret')) {
    return [
      {
        name: String(frameworkCast<Record<string, unknown>>(value).$secret),
        field: path.join('.'),
      },
    ];
  }
  if (isWrapper(value, '$expr')) {
    return [];
  }
  // A `$literal` passes its value through untouched, so a `$secret` inside it is
  // still resolved by the gates: it counts as a use of that secret.
  if (isWrapper(value, '$literal')) {
    return secretsIn(frameworkCast<Record<string, unknown>>(value).$literal, path);
  }
  if (Array.isArray(value)) {
    return value.flatMap((v) => secretsIn(v, path));
  }
  if (!isObject(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, v]) =>
    secretsIn(v, [
      ...path,
      key,
    ]),
  );
}

function recordCall(
  call: {
    op: string;
    args: WorkflowArgs | undefined;
  },
  names: ReadonlyArray<string>,
  scope: WalkScope,
): void {
  const { op, args } = call;
  for (const name of names) {
    const use = useOf(scope, name);
    use.ops.add(op);
    for (const secret of secretsIn(args, [])) {
      use.secrets.push({
        name: secret.name,
        op,
        field: secret.field,
      });
    }
  }
}

/**
 * The secrets a node's `args` write out, each with the dotted field it fills.
 * The gates refuse any other secret a document call sends — one an expression
 * produced at run time is never something the allowlist was checked against.
 */
export function documentSecretsOf(args: WorkflowArgs | undefined): Array<{
  name: string;
  field: string;
}> {
  return secretsIn(args, []);
}

//#endregion

//#region Walk

function walkEntries(list: WorkflowStepList, parentId: string, scope: WalkScope): void {
  for (const entry of stepListEntries(list)) {
    walkEntry(entry, parentId, scope);
  }
}

function walkEntry(entry: WorkflowStepEntry, parentId: string, scope: WalkScope): void {
  if (!isWorkflowOpShorthand(entry)) {
    walkNode(entry, scope);
    return;
  }
  for (const [op, args] of Object.entries(entry)) {
    const where = `operation '${op}' in node '${parentId}'`;
    recordCall(
      {
        op,
        args,
      },
      namesOf(undefined, where, scope),
      scope,
    );
  }
}

function walkWait(
  node: Extract<
    WorkflowNode,
    {
      kind: 'wait';
    }
  >,
  scope: WalkScope,
): void {
  const names = namesOf(node.connection, `wait node '${node.id}'`, scope);
  for (const name of names) {
    useOf(scope, name).events.add(node.event);
  }
  if (node.around !== undefined) {
    walkEntries(node.around, node.id, {
      ...scope,
      enclosing: names,
    });
  }
}

function subjectNames(
  node: Extract<
    WorkflowNode,
    {
      kind: 'verify';
    }
  >,
  scope: WalkScope,
): ReadonlyArray<string> {
  const where = `verify node '${node.id}'`;
  if (Array.isArray(node.subject)) {
    return node.subject.flatMap((name) => namesOf(name, where, scope));
  }
  return namesOf(node.subject, where, scope);
}

function walkVerify(
  node: Extract<
    WorkflowNode,
    {
      kind: 'verify';
    }
  >,
  scope: WalkScope,
): void {
  const subjects = subjectNames(node, scope);
  for (const witness of node.witnesses ?? []) {
    namesOf(witness, `witnesses of verify node '${node.id}'`, scope);
  }
  walkEntries(node.act, node.id, {
    ...scope,
    enclosing: subjects,
  });
}

function walkInParallel(
  node: Extract<
    WorkflowNode,
    {
      kind: 'inParallel';
    }
  >,
  scope: WalkScope,
): void {
  const over = node.over;
  if (Array.isArray(over)) {
    for (const name of over) {
      namesOf(name, `over of inParallel node '${node.id}'`, scope);
    }
  }
  const inner: WalkScope = Array.isArray(over)
    ? {
        ...scope,
        fanOut: over,
      }
    : scope;
  for (const child of node.each
    ? [
        node.each,
      ]
    : (node.paths ?? [])) {
    walkNode(child, inner);
  }
}

/** Walks every node that can hold a connection use; other kinds recurse through their children. */
function walkNode(node: WorkflowNode, scope: WalkScope): void {
  switch (node.kind) {
    case 'call':
      recordCall(
        {
          op: node.op,
          args: node.args,
        },
        namesOf(node.connection, `call node '${node.id}'`, scope),
        scope,
      );
      return;
    case 'wait':
      walkWait(node, scope);
      return;
    case 'verify':
      walkVerify(node, scope);
      return;
    case 'sequence':
      walkEntries(node.steps, node.id, scope);
      return;
    case 'inParallel':
      walkInParallel(node, scope);
      return;
    default:
      for (const child of directChildren(node)) {
        walkNode(child, scope);
      }
  }
}

/** Child nodes of the kinds `walkNode` does not handle itself. */
function directChildren(node: WorkflowNode): WorkflowNode[] {
  switch (node.kind) {
    case 'conditional':
      return [
        ...node.routes.map((r) => r.target),
        ...(node.default
          ? [
              node.default,
            ]
          : []),
      ];
    case 'routeSwitch':
      return [
        ...Object.values(node.cases),
        node.uncertain,
      ];
    case 'spawn':
    case 'withContext':
      return [
        node.child,
      ];
    case 'loop':
      return [
        node.body,
      ];
    case 'schedule':
      return [
        node.step,
      ];
    case 'subflow':
      return node.document
        ? [
            node.document.root,
          ]
        : [];
    default:
      return [];
  }
}

//#endregion

//#region Public API

/**
 * Works out what a document uses of each manifest entry — the operations and
 * events its nodes use and the secrets it passes — checking every connection a
 * node names against the manifest. An inline subflow's nodes count against the
 * enclosing document's manifest.
 *
 * @throws `NoeticConfigError` `CONNECTION_UNKNOWN` for a connection the manifest does not declare, `CONNECTION_INVALID` for a node whose connection is neither named nor implied.
 */
export function documentConnectionUses(doc: WorkflowDocument): ConnectionUses {
  const scope: WalkScope = {
    manifest: doc.connections ?? {},
    enclosing: undefined,
    fanOut: undefined,
    uses: new Map(),
  };
  walkNode(doc.root, scope);
  return scope.uses;
}

/**
 * Checks a document's connection nodes against its manifest: every name is
 * declared, and a source entry (one declaring only `events`) is waited on only
 * for the events it lists and never called.
 *
 * @throws `NoeticConfigError` `CONNECTION_UNKNOWN`, `CONNECTION_INVALID`, or `CONNECTION_UNSATISFIED`-shaped `CONNECTION_INVALID` for a source used beyond its events.
 */
export function checkDocumentConnections(doc: WorkflowDocument): ConnectionUses {
  const uses = documentConnectionUses(doc);
  const manifest = doc.connections ?? {};
  for (const [name, use] of uses) {
    const entry = manifest[name];
    if (
      !entry ||
      entry.profile !== undefined ||
      entry.extensions !== undefined ||
      entry.events === undefined
    ) {
      continue;
    }
    const declared = new Set(entry.events);
    const undeclared = [
      ...use.events,
    ].filter((event) => !declared.has(event));
    if (undeclared.length > 0 || use.ops.size > 0) {
      throw new NoeticConfigError({
        code: 'CONNECTION_INVALID',
        message: `Connection '${name}' declares only the events ${entry.events.join(', ')}, but the document ${
          use.ops.size > 0
            ? `calls ${[
                ...use.ops,
              ].join(', ')} on it`
            : `waits for ${undeclared.join(', ')}`
        }.`,
        hint: `List every event the document waits for in "events", or give '${name}' a "profile" whose operations it calls.`,
      });
    }
  }
  return uses;
}

/**
 * The requirement a manifest entry negotiates: its profile and extension ranges,
 * plus the operations and events the document uses of it.
 */
export function manifestRequirement(
  entry: WorkflowConnectionRequirement,
  use: ConnectionUse | undefined,
): ConnectionRequirement {
  const profile = entry.profile === undefined ? undefined : parseProfileRequirement(entry.profile);
  const events = new Set([
    ...(entry.events ?? []),
    ...(use?.events ?? []),
  ]);
  const operations = [
    ...(use?.ops ?? []),
  ];
  return {
    ...(profile
      ? {
          profile: {
            name: profile.profile,
            range: profile.range,
          },
        }
      : {}),
    ...(entry.extensions
      ? {
          extensions: entry.extensions,
        }
      : {}),
    ...(operations.length > 0
      ? {
          operations,
        }
      : {}),
    ...(events.size > 0
      ? {
          events: [
            ...events,
          ],
        }
      : {}),
  };
}

/**
 * A handle for a manifest entry, carrying the entry's requirement in place of a
 * profile object (core never imports profile packages).
 */
export function documentHandle(
  name: string,
  entry: WorkflowConnectionRequirement,
  use: ConnectionUse | undefined,
): ConnectionHandle {
  const handle: ConnectionHandle & DocumentHandleFields = {
    kind: 'connection-handle',
    name,
    profile: undefined,
    options: {
      ...(entry.from
        ? {
            from: entry.from,
          }
        : {}),
      ...(entry.fresh
        ? {
            fresh: entry.fresh,
          }
        : {}),
      ...(entry.setup
        ? {
            setup: entry.setup,
          }
        : {}),
    },
    _requirement: manifestRequirement(entry, use),
  };
  return handle;
}

/** The requirement a document handle carries, when it is one. */
export function documentRequirementOf(handle: ConnectionHandle): ConnectionRequirement | undefined {
  return frameworkCast<DocumentHandleFields>(handle)._requirement;
}

//#endregion

//#region Allowlist

/** `*` matches any run of characters; everything else literally. */
export function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

function anyGlob(patterns: ReadonlyArray<string> | undefined, value: string): boolean {
  return (patterns ?? []).some((p) => globMatches(p, value));
}

function checkSetup(
  name: string,
  setup: Readonly<Record<string, unknown>> | undefined,
  allowed: ConnectionAllowlistEntry,
): void {
  for (const [field, value] of Object.entries(setup ?? {})) {
    const patterns = allowed.setup?.[field];
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (patterns && anyGlob(patterns, text)) {
      continue;
    }
    throw notAllowed(
      `Connection '${name}' sets setup field '${field}' to ${JSON.stringify(value)}, which the host does not allow.`,
      patterns
        ? `Use a value matching ${patterns.join(', ')}.`
        : `Leave '${field}' to the host, or ask the host to allow it in the connection's allowlist "setup".`,
    );
  }
}

function checkUse(name: string, use: ConnectionUse, allowed: ConnectionAllowlistEntry): void {
  for (const op of use.ops) {
    if (!anyGlob(allowed.ops, op)) {
      throw notAllowed(
        `The document calls '${op}' on '${name}', which the host does not allow.`,
        `Allowed operations: ${(allowed.ops ?? []).join(', ') || '(none)'}.`,
      );
    }
  }
  for (const event of use.events) {
    if (!anyGlob(allowed.events, event)) {
      throw notAllowed(
        `The document waits for '${event}' on '${name}', which the host does not allow.`,
        `Allowed events: ${(allowed.events ?? []).join(', ') || '(none)'}.`,
      );
    }
  }
  for (const secret of use.secrets) {
    const binding = `${secret.op}.${secret.field}`;
    if (allowed.secrets?.[secret.name] === binding) {
      continue;
    }
    throw notAllowed(
      `The document uses secret '${secret.name}' in ${binding} on '${name}', which the host does not allow.`,
      allowed.secrets?.[secret.name]
        ? `Secret '${secret.name}' may fill only ${allowed.secrets[secret.name]}.`
        : `The host allows no secret named '${secret.name}' on '${name}'.`,
    );
  }
}

/**
 * Checks a document against the host's allowlist (spec 35 § What a document may
 * use). Each manifest entry binds to the harness connection `from ?? name`, which
 * the allowlist must name; the operations, events, setup values and secrets the
 * document uses of it must all be granted.
 *
 * @throws `NoeticConfigError` `CONNECTION_NOT_ALLOWED` when the document asks for more than the allowlist grants (or has connections and there is no allowlist); `CONNECTION_UNKNOWN` / `CONNECTION_INVALID` from `checkDocumentConnections`.
 */
export function checkConnectionAllowlist(
  doc: WorkflowDocument,
  allowlist: ConnectionAllowlist | undefined,
): void {
  const manifest = doc.connections ?? {};
  const uses = checkDocumentConnections(doc);
  const names = Object.keys(manifest);
  if (names.length === 0) {
    return;
  }
  if (!allowlist) {
    throw notAllowed(
      `The document asks for connections (${names.join(', ')}), but the host allows none.`,
      'Pass an allowlist, e.g. dynamicWorkflow({ connections: { browsers: { ops: ["ui.*"] } } }).',
    );
  }
  for (const name of names) {
    const entry = manifest[name];
    const target = entry?.from ?? name;
    const allowed = allowlist[target];
    if (!entry || !allowed) {
      throw notAllowed(
        `The document asks for connection '${target}', which the host does not allow.`,
        `Allowed connections: ${Object.keys(allowlist).join(', ') || '(none)'}.`,
      );
    }
    checkSetup(name, entry.setup, allowed);
    checkUse(
      name,
      uses.get(name) ?? {
        ops: new Set(),
        events: new Set(),
        secrets: [],
      },
      allowed,
    );
  }
}

//#endregion
