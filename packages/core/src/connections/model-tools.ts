/**
 * Model tools (spec 35 § Model tools). How a connection's operations reach the
 * model is its `expose` setting:
 *
 * - `'eager'` (default): the operations its profile marks `eager`, plus
 *   `<name>_ops` (lists the rest) and `<name>_call` (runs one, or reads an
 *   `'ask'` read). A connection with no profile has no eager set, so its tools
 *   are exposed as they are.
 * - `'all'`: every operation as its own tool.
 * - `'none'`: none; the connection is for steps and triggers only.
 *
 * Tools are named `<name>_<op>` (dots become underscores). When two
 * connections offer the same profile operation, the model gets one tool named
 * after the operation (`ui_tap`) with a `target` argument naming the
 * connection. Two operations that would still share a name are a
 * `CONNECTION_TOOL_COLLISION`. Every call passes the same gates as a step.
 *
 * `connectionTools(handle, { ops })` builds tools for one handle, for a
 * `callModel` step that narrows what it offers.
 */

import type {
  ConnectionHandle,
  ConnectionOperationInfo,
  Context,
  JsonSchemaObject,
  StandardSchemaV1,
  Tool,
  ToolExecutionContext,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { toolIdempotencyKey } from './durability';
import { deniedError, toolCollisionError } from './errors';
import { matchesAnyGlob } from './glob';
import { handleTarget } from './handle';
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

/** The internal property the harness exposes its registry on. */
const RUNTIME_PROPERTY = 'connectionRegistry';

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
  if (typeof harness !== 'object' || harness === null || !(RUNTIME_PROPERTY in harness)) {
    return undefined;
  }
  return frameworkCast<{
    connectionRegistry?: ConnectionRuntime;
  }>(harness).connectionRegistry;
}

/** FNV-1a over `text`, as 8 hex digits: a short, stable digest. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * The tool call's id, or — when the pipeline gave none — one derived from the
 * operation and its arguments, so the idempotency key is stable across a resume.
 */
function callIdOf(toolCtx: ToolExecutionContext, op: string, args: unknown): string {
  const call = toolCtx.turnContext?.toolCall;
  return call?.callId ?? call?.id ?? `derived-${digest(`${op}\u0000${JSON.stringify(args)}`)}`;
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
  });
  const toolCallId = callIdOf(request.toolCtx, request.op, request.args);
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
  return {
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
  return {
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
}

function opsTool(
  runtime: ConnectionRuntime,
  name: string,
  hidden: ReadonlyArray<string>,
): ConnectionTool {
  return {
    name: `${sanitize(name)}_ops`,
    description: `List the operations of ${name} that are not tools of their own, and the state you can read with ${sanitize(name)}_call({ read }).`,
    input: ANY_OBJECT_INPUT,
    inputJsonSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description: "A glob over operation names, e.g. 'ui.*'.",
        },
      },
    },
    output: ANY_OUTPUT,
    execute: async (args) => {
      const manifest = runtime.current(name)?.manifest;
      const filter = typeof args.filter === 'string' ? args.filter : '*';
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
      const look = runtime.config(name)?.look ?? {};
      const reads = Object.values(manifest?.resources ?? {})
        .filter((r) => (look[r.name] ?? r.look ?? 'ask') === 'ask')
        .map((r) => ({
          read: r.name,
          description: r.description,
        }));
      return {
        operations,
        reads,
      };
    },
  };
}

function callTool(
  runtime: ConnectionRuntime,
  name: string,
  allowed: ReadonlyArray<string>,
): ConnectionTool {
  return {
    name: `${sanitize(name)}_call`,
    description: `Run one operation of ${name} listed by ${sanitize(name)}_ops ({ op, args }), or read its state ({ read }).`,
    input: ANY_OBJECT_INPUT,
    inputJsonSchema: {
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
    },
    output: ANY_OUTPUT,
    execute: async (args, toolCtx) => {
      const tc = toolContext(toolCtx);
      if (typeof args.read === 'string') {
        const resolved = await runtime.resolve({
          name,
          scope: scopeOf(tc.ctx),
          ctx: tc.ctx,
        });
        const value = await resolved.read(args.read, {
          signal: signalOf(tc.ctx),
        });
        return runtime.withholdSensitive(value);
      }
      const op = typeof args.op === 'string' ? args.op : '';
      if (!allowed.includes(op)) {
        throw deniedError(`'${op}' is not an operation ${sanitize(name)}_call can run`);
      }
      return callThrough(runtime, {
        name,
        op,
        args: args.args ?? {},
        toolCtx: tc,
      });
    },
  };
}

function exposuresFor(
  runtime: ConnectionRuntime,
  name: string,
): {
  readonly direct: DirectExposure[];
  readonly hidden: string[];
} {
  const config = runtime.config(name);
  const connection = runtime.current(name);
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
    const own = expose === 'all' || !hasProfile || info.eager === true;
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
  runtime: ConnectionRuntime,
  name: string,
  hidden: ReadonlyArray<string>,
): boolean {
  const config = runtime.config(name);
  if (config?.pool || config?.expose === 'none') {
    return false;
  }
  if (hidden.length > 0) {
    return true;
  }
  const manifest = runtime.current(name)?.manifest;
  const look = runtime.config(name)?.look ?? {};
  return Object.values(manifest?.resources ?? {}).some(
    (r) => (look[r.name] ?? r.look ?? 'ask') === 'ask',
  );
}

//#endregion

//#region Public API

/**
 * The model tools for every ready connection in `runtime`, built fresh each
 * turn so a renegotiated connection's tools change at the next turn, never
 * mid-turn.
 *
 * @throws NoeticConfigError `CONNECTION_TOOL_COLLISION` when two operations would share a tool name.
 */
export function buildConnectionTools(runtime: ConnectionRuntime): Tool[] {
  const tools = new ToolSet();
  const byProfileOp = new Map<string, DirectExposure[]>();
  const plain: DirectExposure[] = [];
  for (const name of runtime.names()) {
    const { direct, hidden } = exposuresFor(runtime, name);
    for (const exposure of direct) {
      if (!exposure.info.profile && !exposure.info.extension) {
        plain.push(exposure);
        continue;
      }
      const group = byProfileOp.get(exposure.op) ?? [];
      group.push(exposure);
      byProfileOp.set(exposure.op, group);
    }
    if (needsGenericTools(runtime, name, hidden)) {
      tools.add(opsTool(runtime, name, hidden), `${name} (ops)`);
      tools.add(callTool(runtime, name, hidden), `${name} (call)`);
    }
  }
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
 * @public
 * Tools for one connection handle, for a `callModel` step that narrows what it
 * offers: one tool per profile operation matching `ops`, or — for a handle with
 * no profile — one `<name>_call` tool limited to `ops`.
 */
export function connectionTools(
  handle: ConnectionHandle,
  options: ConnectionToolsOptions = {},
): Tool[] {
  const patterns = options.ops ?? [
    '*',
  ];
  const target = handleTarget(handle);
  const profile = handle.profile;
  const resolveRuntime = (toolCtx: ToolExecutionContext): ConnectionRuntime => {
    const runtime = runtimeOf(toolCtx.harness);
    if (!runtime) {
      throw deniedError('this harness has no connections');
    }
    return runtime;
  };
  if (!profile) {
    const generic: ConnectionTool = {
      name: `${sanitize(handle.name)}_call`,
      description: `Run an operation of ${handle.name}: { op, args }.`,
      input: ANY_OBJECT_INPUT,
      inputJsonSchema: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
          },
          args: {
            type: 'object',
          },
        },
        required: [
          'op',
        ],
      },
      output: ANY_OUTPUT,
      execute: (args, toolCtx) => {
        const tc = toolContext(toolCtx);
        const op = typeof args.op === 'string' ? args.op : '';
        if (!matchesAnyGlob(patterns, op)) {
          throw deniedError(`'${op}' is not offered to this step`);
        }
        return callThrough(resolveRuntime(tc), {
          name: target,
          op,
          args: args.args ?? {},
          toolCtx: tc,
          requirement: requirementFor(handle),
          fresh: handle.options.fresh,
          setup: handle.options.setup,
        });
      },
    };
    return [
      generic,
    ];
  }
  return Object.entries(profile.operations)
    .filter(([op]) => matchesAnyGlob(patterns, op))
    .map(
      ([op, def]): ConnectionTool => ({
        name: connectionToolName(handle.name, op),
        description: def.description,
        input: ANY_OBJECT_INPUT,
        inputJsonSchema: z.toJSONSchema(def.input, {
          unrepresentable: 'any',
        }),
        output: ANY_OUTPUT,
        execute: (args, toolCtx) => {
          const tc = toolContext(toolCtx);
          return callThrough(resolveRuntime(tc), {
            name: target,
            op,
            args,
            toolCtx: tc,
            profile,
            requirement: requirementFor(handle, {
              operations: [
                op,
              ],
            }),
            fresh: handle.options.fresh,
            setup: handle.options.setup,
          });
        },
      }),
    );
}

//#endregion
