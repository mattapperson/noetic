/**
 * Model tools (spec 35 § Model tools). How a connection's operations reach the
 * model is its `expose` setting:
 *
 * - `'eager'` (default): the operations its profile marks `eager`, plus
 *   `<name>_ops` (lists the rest) and `<name>_call` (runs one, or reads an
 *   `'ask'` read). A connection with no profile has no eager set, so its tools
 *   are exposed as they are.
 * - `'all'`: every operation as its own tool.
 * - `'call'`: only `<name>_ops` and `<name>_call`.
 * - `'none'`: none; the connection is for steps and triggers only.
 *
 * Tools are named `<name>_<op>` (dots become underscores). When two
 * connections offer the same profile operation, the model gets one tool named
 * after the operation (`ui_tap`) with a `target` argument naming the
 * connection; two or more `'call'` connections likewise share one `ops` and
 * one `call`. Two operations that would still share a name are a
 * `CONNECTION_TOOL_COLLISION`. Every call passes the same gates as a step.
 *
 * The tools are built once per turn, from the harness's connections and the
 * ones the turn attached, so a connection gives the same tools wherever it is
 * attached. `connectionTools(handle, { ops })` picks part of them for a step,
 * and each tool cuts itself to what the step picked (`cutForStep`).
 */

import type {
  AnyProfile,
  ConnectionEntry,
  ConnectionHandle,
  ConnectionOperationInfo,
  ConnectionPick,
  Context,
  JsonSchemaObject,
  StandardSchemaV1,
  Tool,
  ToolExecutionContext,
} from '@noetic-tools/types';
import { frameworkCast, isConnectionEntry } from '@noetic-tools/types';
import { z } from 'zod';
import { harnessInternal } from '../util/harness-internals';
import { orderedCallId, toolIdempotencyKey } from './durability';
import { entryName } from './entries';
import { deniedError, invalidConnectionError, toolCollisionError } from './errors';
import { matchesAnyGlob } from './glob';
import { CONNECTION_NAME_PATTERN, handleTarget } from './handle';
import { requirementFor } from './negotiation';
import { refConnections } from './refs';
import type { ConnectionRuntime, RuntimeResolveRequest } from './registry';
import { isPlainRecord } from './values';

//#region Types

/** `connectionTools()` options. */
export interface ConnectionToolsOptions {
  /** Operation globs to offer; default every operation. */
  readonly ops?: ReadonlyArray<string>;
}

/** Whether a step may run operation, or read resource, `name` of `connection`. */
export type StepAllows = (connection: string, name: string) => boolean;

/**
 * A connection tool cut to what a step may use: the tool itself when the step
 * may use all of it, a copy under the same name reaching only what it may,
 * or undefined when it may use none of it.
 */
type StepCut = (allows: StepAllows) => Tool | undefined;

/** The connections of one turn: the harness's and the ones the turn attached under `rootId`. */
interface TurnConnections {
  readonly runtime: ConnectionRuntime;
  readonly rootId?: string;
}

/** One operation offered as its own tool on one connection. */
interface DirectExposure {
  readonly connection: string;
  readonly op: string;
  readonly info: ConnectionOperationInfo;
}

type ToolInput = StandardSchemaV1<unknown, Record<string, unknown>>;

/** A connection tool: object arguments, any output. */
type ConnectionTool = Tool<ToolInput, z.ZodUnknown>;

//#endregion

//#region Helpers

/** Accepts any JSON object; the gates validate against the operation's own schema. */
const ANY_OBJECT_INPUT: ToolInput = {
  '~standard': {
    version: 1,
    vendor: 'noetic-connections',
    validate: (value: unknown) =>
      isPlainRecord(value)
        ? {
            value,
          }
        : {
            issues: [
              {
                message: 'expected an object of arguments',
              },
            ],
          },
  },
};

const ANY_OUTPUT = z.unknown();

const CUTS = new WeakMap<Tool, StepCut>();

function cutting<T extends Tool>(tool: T, cut: StepCut): T {
  CUTS.set(tool, cut);
  return tool;
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** `<connection>_<op>` with dots and other characters a tool name cannot carry as `_`. */
export function connectionToolName(connection: string, op: string): string {
  return `${sanitize(connection)}_${sanitize(op)}`;
}

function toolContext(toolCtx: unknown): ToolExecutionContext {
  return frameworkCast<ToolExecutionContext>(toolCtx);
}

/** The registry a harness exposes, if it has one. */
export function runtimeOf(harness: unknown): ConnectionRuntime | undefined {
  return harnessInternal<ConnectionRuntime>(harness, 'connectionRegistry');
}

/** The tool call's id, or — when a step runs the tool directly and there is no call — one from the step and the call's order. */
function callIdOf(toolCtx: ToolExecutionContext): string {
  return toolCtx.callId ?? orderedCallId(toolCtx.ctx, toolCtx.ctx);
}

/** The run's abort signal: cancelling the run cancels the call and any long operation it waits on. */
function signalOf(ctx: Context): AbortSignal {
  return (
    frameworkCast<{
      abortSignal?: AbortSignal;
    }>(ctx).abortSignal ?? new AbortController().signal
  );
}

function scopeOf(ctx: Context): RuntimeResolveRequest['scope'] {
  return {
    executionId: ctx.id,
    threadId: ctx.threadId,
    scopeKey: ctx.id,
    signal: signalOf(ctx),
  };
}

async function callThrough(
  runtime: ConnectionRuntime,
  request: Omit<RuntimeResolveRequest, 'scope'> & {
    readonly op: string;
    readonly args: unknown;
    readonly toolCtx: ToolExecutionContext;
  },
): Promise<unknown> {
  const ctx = request.toolCtx.ctx;
  const scope = scopeOf(ctx);
  const resolved = await runtime.resolve({
    ...request,
    scope,
    ctx,
    caller: 'model',
  });
  const toolCallId = callIdOf(request.toolCtx);
  const output = await resolved.call(request.op, request.args, {
    signal: scope.signal,
    caller: 'model',
    idempotencyKey: toolIdempotencyKey(ctx.id, toolCallId),
    toolCallId,
    ctx,
  });
  // The model never sees a sensitive blob (spec 35 § Refs and blobs).
  return runtime.withholdSensitive(output);
}

function withTarget(schema: JsonSchemaObject, targets: ReadonlyArray<string>): JsonSchemaObject {
  const properties = isPlainRecord(schema.properties) ? schema.properties : {};
  return {
    ...schema,
    type: 'object',
    properties: {
      ...properties,
      target: {
        type: 'string',
        enum: [
          ...targets,
        ],
        description: 'The connection to run it on.',
      },
    },
  };
}

function withoutTarget(args: Record<string, unknown>): Record<string, unknown> {
  const { target: _target, ...rest } = args;
  return rest;
}

function pickTarget(args: Record<string, unknown>, targets: ReadonlyArray<string>): string {
  const target = args.target;
  if (typeof target === 'string' && targets.includes(target)) {
    return target;
  }
  const byRef = [
    ...refConnections(args),
  ].filter((name) => targets.includes(name));
  const routed = byRef.length === 1 ? byRef[0] : undefined;
  if (routed) {
    return routed;
  }
  throw deniedError(`pass target: one of ${targets.join(', ')}`);
}

function directTool(runtime: ConnectionRuntime, exposure: DirectExposure): ConnectionTool {
  const tool: ConnectionTool = {
    name: connectionToolName(exposure.connection, exposure.op),
    description: exposure.info.description ?? `${exposure.op} on ${exposure.connection}`,
    input: ANY_OBJECT_INPUT,
    inputJsonSchema: {
      ...exposure.info.inputSchema,
    },
    output: ANY_OUTPUT,
    execute: (args, toolCtx) =>
      callThrough(runtime, {
        name: exposure.connection,
        op: exposure.op,
        args,
        toolCtx: toolContext(toolCtx),
      }),
  };
  return cutting(tool, (allows) => (allows(exposure.connection, exposure.op) ? tool : undefined));
}

function mergedTool(
  runtime: ConnectionRuntime,
  group: ReadonlyArray<DirectExposure>,
): ConnectionTool {
  const first = group[0];
  if (!first) {
    throw deniedError('internal: empty tool group');
  }
  const targets = group.map((e) => e.connection);
  const tool: ConnectionTool = {
    name: sanitize(first.op),
    description: `${first.info.description ?? first.op} (on ${targets.join(' or ')}; pass target)`,
    input: ANY_OBJECT_INPUT,
    inputJsonSchema: withTarget(first.info.inputSchema, targets),
    output: ANY_OUTPUT,
    execute: (args, toolCtx) =>
      callThrough(runtime, {
        name: pickTarget(args, targets),
        op: first.op,
        args: withoutTarget(args),
        toolCtx: toolContext(toolCtx),
      }),
  };
  return cutting(tool, (allows) => {
    const kept = group.filter((e) => allows(e.connection, e.op));
    if (kept.length === group.length) {
      return tool;
    }
    return kept.length > 0 ? mergedTool(runtime, kept) : undefined;
  });
}

/**
 * The reads `<name>_call({ read })` serves: the connection's own `'ask'` reads
 * (every read when no view shows any, see `hasView`) that the step may use.
 */
function askReads(
  turn: TurnConnections,
  generic: GenericExposure,
): Array<{
  read: string;
  description?: string;
}> {
  const { name } = generic;
  const manifest = turn.runtime.current(name, turn.rootId)?.manifest;
  const viewed = hasView(turn, name);
  const look = turn.runtime.config(name, turn.rootId)?.look ?? {};
  return Object.values(manifest?.resources ?? {})
    .filter((r) => !viewed || (look[r.name] ?? r.look ?? 'ask') === 'ask')
    .filter((r) => generic.reads(r.name))
    .map((r) => ({
      read: r.name,
      description: r.description,
    }));
}

/** Whether a view layer renders the connection's `'turn'` and `'effect'` reads. */
function hasView(turn: TurnConnections, name: string): boolean {
  return turn.runtime.viewed(name, turn.rootId);
}

/** What `<name>_ops` lists for one connection. */
function listOps(
  turn: TurnConnections,
  generic: GenericExposure,
  filter: string,
): Record<string, unknown> {
  const { name, hidden } = generic;
  const manifest = turn.runtime.current(name, turn.rootId)?.manifest;
  const operations = hidden
    .filter((op) =>
      matchesAnyGlob(
        [
          filter,
        ],
        op,
      ),
    )
    .map((op) => manifest?.operations[op])
    .filter((info): info is ConnectionOperationInfo => info !== undefined)
    .map((info) => ({
      op: info.name,
      description: info.description,
      inputSchema: info.inputSchema,
    }));
  return {
    operations,
    reads: askReads(turn, generic),
  };
}

/** Runs what `<name>_call` was asked: one listed operation, or a read. */
async function runCall(
  turn: TurnConnections,
  generic: GenericExposure,
  call: {
    readonly args: Record<string, unknown>;
    readonly toolCtx: ToolExecutionContext;
  },
): Promise<unknown> {
  const { args, toolCtx } = call;
  const { runtime } = turn;
  const { name, hidden } = generic;
  if (typeof args.read === 'string') {
    const read = args.read;
    if (!askReads(turn, generic).some((r) => r.read === read)) {
      throw deniedError(`'${read}' is not a read ${sanitize(name)}_call can serve`);
    }
    const resolved = await runtime.resolve({
      name,
      scope: scopeOf(toolCtx.ctx),
      ctx: toolCtx.ctx,
      caller: 'model',
    });
    const value = await resolved.read(read, {
      signal: signalOf(toolCtx.ctx),
    });
    return runtime.withholdSensitive(value);
  }
  const op = typeof args.op === 'string' ? args.op : '';
  if (!hidden.includes(op)) {
    throw deniedError(`'${op}' is not an operation ${sanitize(name)}_call can run`);
  }
  return callThrough(runtime, {
    name,
    op,
    args: args.args ?? {},
    toolCtx,
  });
}

const everyRead = (): boolean => true;

const OPS_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    filter: {
      type: 'string',
      description: "A glob over operation names, e.g. 'ui.*'.",
    },
  },
};

const CALL_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
    },
    args: {
      type: 'object',
    },
    read: {
      type: 'string',
    },
  },
};

function filterOf(args: Record<string, unknown>): string {
  return typeof args.filter === 'string' ? args.filter : '*';
}

/** `<name>_ops` and `<name>_call` for one connection. */
function genericTools(turn: TurnConnections, generic: GenericExposure): ConnectionTool[] {
  const { name } = generic;
  const ops: ConnectionTool = {
    name: `${sanitize(name)}_ops`,
    description: `List the operations of ${name} that are not tools of their own, and the state you can read with ${sanitize(name)}_call({ read }).`,
    input: ANY_OBJECT_INPUT,
    inputJsonSchema: OPS_SCHEMA,
    output: ANY_OUTPUT,
    execute: async (args) => listOps(turn, generic, filterOf(args)),
  };
  const call: ConnectionTool = {
    name: `${sanitize(name)}_call`,
    description: `Run one operation of ${name} listed by ${sanitize(name)}_ops ({ op, args }), or read its state ({ read }).`,
    input: ANY_OBJECT_INPUT,
    inputJsonSchema: CALL_SCHEMA,
    output: ANY_OUTPUT,
    execute: (args, toolCtx) =>
      runCall(turn, generic, {
        args,
        toolCtx: toolContext(toolCtx),
      }),
  };
  const tools: [
    ConnectionTool,
    ConnectionTool,
  ] = [
    ops,
    call,
  ];
  return tools.map((tool, i) =>
    cutting(tool, (allows) => {
      const cut = cutGeneric(turn, generic, allows);
      if (cut === 'whole') {
        return tool;
      }
      return cut === 'none' ? undefined : genericTools(turn, cut)[i];
    }),
  );
}

/** One `ops` and one `call` shared by every `'call'` connection, each taking `target`. */
function mergedGenericTools(
  turn: TurnConnections,
  group: ReadonlyArray<GenericExposure>,
): ConnectionTool[] {
  const targets = group.map((g) => g.name);
  const byName = new Map(
    group.map((g) => [
      g.name,
      g,
    ]),
  );
  const generic = (args: Record<string, unknown>): GenericExposure => {
    const found = byName.get(pickTarget(args, targets));
    if (!found) {
      throw deniedError(`pass target: one of ${targets.join(', ')}`);
    }
    return found;
  };
  const ops: ConnectionTool = {
    name: 'ops',
    description: `List the operations of ${targets.join(' or ')} (pass target), and the state you can read with call({ target, read }).`,
    input: ANY_OBJECT_INPUT,
    inputJsonSchema: withTarget(OPS_SCHEMA, targets),
    output: ANY_OUTPUT,
    execute: async (args) => {
      return listOps(turn, generic(args), filterOf(args));
    },
  };
  const call: ConnectionTool = {
    name: 'call',
    description: `Run one operation listed by ops on ${targets.join(' or ')} ({ target, op, args }), or read its state ({ target, read }).`,
    input: ANY_OBJECT_INPUT,
    inputJsonSchema: withTarget(CALL_SCHEMA, targets),
    output: ANY_OUTPUT,
    execute: async (args, toolCtx) =>
      runCall(turn, generic(args), {
        args: withoutTarget(args),
        toolCtx: toolContext(toolCtx),
      }),
  };
  const tools: [
    ConnectionTool,
    ConnectionTool,
  ] = [
    ops,
    call,
  ];
  return tools.map((tool, i) =>
    cutting(tool, (allows) => {
      const cuts = group.map((g) => cutGeneric(turn, g, allows));
      if (cuts.every((cut) => cut === 'whole')) {
        return tool;
      }
      const kept = group.flatMap((member, j) => {
        const cut = cuts[j];
        if (cut === 'none' || cut === undefined) {
          return [];
        }
        return [
          cut === 'whole' ? member : cut,
        ];
      });
      return kept.length > 0 ? mergedGenericTools(turn, kept)[i] : undefined;
    }),
  );
}

/** The operations and reads a connection serves through `<name>_ops` / `<name>_call`. */
interface GenericExposure {
  readonly name: string;
  readonly hidden: ReadonlyArray<string>;
  /** Whether the step may read resource `read`. */
  readonly reads: (read: string) => boolean;
}

/**
 * `generic` cut to what a step may use: `'whole'` when it may use all of it,
 * `'none'` when it may use nothing, else the part it may.
 */
function cutGeneric(
  turn: TurnConnections,
  generic: GenericExposure,
  allows: StepAllows,
): GenericExposure | 'whole' | 'none' {
  const { name } = generic;
  const hidden = generic.hidden.filter((op) => allows(name, op));
  const reads = askReads(turn, generic);
  const kept = reads.filter((r) => allows(name, r.read));
  if (hidden.length === generic.hidden.length && kept.length === reads.length) {
    return 'whole';
  }
  if (hidden.length === 0 && kept.length === 0) {
    return 'none';
  }
  return {
    name,
    hidden,
    reads: (read) => generic.reads(read) && allows(name, read),
  };
}

function exposuresFor(
  turn: TurnConnections,
  name: string,
): {
  readonly direct: DirectExposure[];
  readonly hidden: string[];
} {
  const config = turn.runtime.config(name, turn.rootId);
  const connection = turn.runtime.current(name, turn.rootId);
  const expose = config?.expose ?? 'eager';
  if (!connection || config?.pool || expose === 'none') {
    return {
      direct: [],
      hidden: [],
    };
  }
  const manifest = connection.manifest;
  const hasProfile = Object.keys(manifest.profiles).length > 0;
  const direct: DirectExposure[] = [];
  const hidden: string[] = [];
  for (const [op, info] of Object.entries(manifest.operations)) {
    const own = expose !== 'call' && (expose === 'all' || !hasProfile || info.eager === true);
    if (own) {
      direct.push({
        connection: name,
        op,
        info,
      });
      continue;
    }
    hidden.push(op);
  }
  return {
    direct,
    hidden,
  };
}

/** Tools by name, refusing a second tool under a name already taken. */
class ToolSet {
  private readonly tools = new Map<string, Tool>();
  private readonly owners = new Map<string, string>();

  add(tool: Tool, owner: string): void {
    const existing = this.owners.get(tool.name);
    if (existing !== undefined) {
      throw toolCollisionError(tool.name, existing, owner);
    }
    this.owners.set(tool.name, owner);
    this.tools.set(tool.name, tool);
  }

  list(): Tool[] {
    return [
      ...this.tools.values(),
    ];
  }
}

function needsGenericTools(
  turn: TurnConnections,
  name: string,
  hidden: ReadonlyArray<string>,
): boolean {
  const config = turn.runtime.config(name, turn.rootId);
  if (config?.pool || config?.expose === 'none') {
    return false;
  }
  return (
    hidden.length > 0 ||
    askReads(turn, {
      name,
      hidden,
      reads: everyRead,
    }).length > 0
  );
}

/** Adds each `'call'` connection's ops and call, merged when there are two or more. */
function addGenericTools(
  turn: TurnConnections,
  tools: ToolSet,
  groups: {
    /** Connections whose ops and call are their own. */
    readonly generics: ReadonlyArray<GenericExposure>;
    /** `'call'` connections, which share one ops and one call when there are two or more. */
    readonly called: ReadonlyArray<GenericExposure>;
  },
): void {
  const { generics, called } = groups;
  for (const generic of generics) {
    for (const tool of genericTools(turn, generic)) {
      tools.add(tool, `${generic.name} (${tool.name.endsWith('_ops') ? 'ops' : 'call'})`);
    }
  }
  if (called.length > 1) {
    for (const tool of mergedGenericTools(turn, called)) {
      tools.add(tool, `${tool.name} on ${called.map((g) => g.name).join(', ')}`);
    }
    return;
  }
  for (const generic of called) {
    for (const tool of genericTools(turn, generic)) {
      tools.add(tool, `${generic.name} (${tool.name.endsWith('_ops') ? 'ops' : 'call'})`);
    }
  }
}

//#endregion

//#region Public API

/**
 * The model tools for every ready connection of a turn — the harness's, and
 * the ones attached under `rootId` — built fresh each turn so a renegotiated
 * connection's tools change at the next turn, never mid-turn.
 *
 * @throws NoeticConfigError `CONNECTION_TOOL_COLLISION` when two operations would share a tool name.
 */
export function buildConnectionTools(runtime: ConnectionRuntime, rootId?: string): Tool[] {
  const turn: TurnConnections = {
    runtime,
    rootId,
  };
  const tools = new ToolSet();
  const byProfileOp = new Map<string, DirectExposure[]>();
  const plain: DirectExposure[] = [];
  const generics: GenericExposure[] = [];
  const called: GenericExposure[] = [];
  for (const name of runtime.visibleNames(rootId)) {
    const { direct, hidden } = exposuresFor(turn, name);
    for (const exposure of direct) {
      if (!exposure.info.profile && !exposure.info.extension) {
        plain.push(exposure);
        continue;
      }
      const group = byProfileOp.get(exposure.op) ?? [];
      group.push(exposure);
      byProfileOp.set(exposure.op, group);
    }
    if (!needsGenericTools(turn, name, hidden)) {
      continue;
    }
    const isCalled = runtime.config(name, rootId)?.expose === 'call';
    (isCalled ? called : generics).push({
      name,
      hidden,
      reads: everyRead,
    });
  }
  addGenericTools(turn, tools, {
    generics,
    called,
  });
  for (const [op, group] of byProfileOp) {
    if (group.length > 1) {
      tools.add(
        mergedTool(runtime, group),
        `'${op}' on ${group.map((g) => g.connection).join(', ')}`,
      );
      continue;
    }
    plain.push(...group);
  }
  for (const exposure of plain) {
    tools.add(directTool(runtime, exposure), `'${exposure.op}' on ${exposure.connection}`);
  }
  return tools.list();
}

/**
 * Cuts a tool built by `buildConnectionTools` to what a step may use (see
 * `StepCut`): a merged tool keeps only the targets the step may use, its
 * `target` enum and routing with them, and `<name>_ops` / `<name>_call` only
 * the operations and reads. Returns `'not-connection'` for any other tool.
 */
export function cutForStep(tool: Tool, allows: StepAllows): Tool | undefined | 'not-connection' {
  const cut = CUTS.get(tool);
  return cut ? cut(allows) : 'not-connection';
}

/**
 * @public
 * Picks part of one connection's model tools for a step: the tools the turn
 * built for it, under the same names — `<name>_<op>`, `<name>_ops` /
 * `<name>_call`, and merged profile tools that take `target` — narrowed to the
 * operations matching `ops`. A step that lists the pick is offered a tool only
 * when every operation the tool can run matches, so `<name>_call` comes with a
 * pick only when every operation behind it does. Picking from an entry
 * (`mcp({ name, … })`) attaches it to the step, as listing the entry would.
 * A name picks a connection the harness or the turn attaches; it is checked
 * when the turn's tool set is built.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` for a handle with `fresh` (a
 * pool has no model tools), an entry with no name, or a malformed name. The
 * turn fails with `CONNECTION_UNKNOWN` when no connection has the name.
 */
export function connectionTools(
  target: string | ConnectionHandle | ConnectionEntry,
  options: ConnectionToolsOptions = {},
): ConnectionPick {
  const ops =
    options.ops === undefined
      ? {}
      : {
          ops: [
            ...options.ops,
          ],
        };
  if (typeof target === 'string') {
    if (!CONNECTION_NAME_PATTERN.test(target)) {
      throw invalidConnectionError(
        `connectionTools(${JSON.stringify(target)}) is not a connection name.`,
        'A connection name is a letter followed by letters, digits, _ or -.',
      );
    }
    return {
      kind: 'connection-pick',
      connection: target,
      ...ops,
    };
  }
  if (isConnectionEntry(target)) {
    const name = entryName(target);
    if (name === undefined) {
      throw invalidConnectionError(
        'connectionTools() was given a connection with no name.',
        "Name it on the provider: connectionTools(mcp({ name: 'linear', … })).",
      );
    }
    return {
      kind: 'connection-pick',
      connection: name,
      ...ops,
      entry: target,
    };
  }
  if (target.options.fresh) {
    throw invalidConnectionError(
      `connectionTools(connection('${target.name}')) names a fresh connection.`,
      'A pool gives no model tools; drive it from steps (step.call) instead.',
    );
  }
  const profile: AnyProfile | undefined = target.profile;
  return {
    kind: 'connection-pick',
    connection: handleTarget(target),
    ...ops,
    ...(profile
      ? {
          requirement: requirementFor(target),
          profile,
        }
      : {}),
  };
}

//#endregion
