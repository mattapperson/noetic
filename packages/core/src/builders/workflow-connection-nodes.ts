/**
 * Hydrators for the JSON workflow nodes that reach outside the workflow:
 * `call` and `wait` (spec 35), resolving the connection a node runs on against
 * the document's manifest; `acp-agent` with its tools (spec 27); and `runCode`,
 * which runs its code through a subprocess adapter.
 */

import type { ContextData } from '@noetic-tools/context';
import type {
  AcpContentBlock,
  AcpPermissionHandler,
  AcpPermissionOutcome,
  AcpPermissionPolicy,
  AcpPermissionRule,
  ConnectionHandle,
  Context,
  ProcessSubprocessRequest,
  Step,
  StepCall,
  StepConnectionTarget,
  StepWait,
  SubprocessAdapter,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import type { CompiledExpression } from '../expression/jsonata';
import { compileExpression, compute, passes, readInput } from '../expression/jsonata';
import type { AcpAgentWorkflowNode, WaitWorkflowNode, WorkflowNode } from '../schemas/workflow';
import { getDefaultRegistrar } from '../types/step-registrar';
import { DetachedHandleImpl } from '../util/detached-handle';
import { outputText } from './output-text';
import { runCode, step } from './step-builders';
import { boundedAcpSettings } from './workflow-acp-grants';
import { compileArgs, documentHandle, documentSecretsOf } from './workflow-connections';
import type { ConnectionRef, HydrationContext } from './workflow-hydrator';
import { bindingsFor, hydrateStepList } from './workflow-hydrator';
import { outputSchemaOf } from './workflow-output';
import {
  emitOption,
  fromParam,
  isParamUse,
  lazyOption,
  paramFor,
  paramFunction,
} from './workflow-params';
import { checkRunCodeNode } from './workflow-run-code-grant';
import { nodeTools, withCeiling } from './workflow-tool-entries';

//#region Connection Node Hydrators

/**
 * Checks a connection name against the document's manifest, when there is one.
 *
 * @throws `NoeticConfigError` `CONNECTION_UNKNOWN` for a name the manifest does not declare.
 */
export function checkManifestName(name: string, where: string, ctx: HydrationContext): void {
  if (!ctx.connections || Object.hasOwn(ctx.connections, name)) {
    return;
  }
  const declared = Object.keys(ctx.connections);
  throw new NoeticConfigError({
    code: 'CONNECTION_UNKNOWN',
    message: `${where} uses connection '${name}', which the document's connections do not declare.`,
    hint: `Use one of ${declared.join(', ') || '(none)'}, or add '${name}' to the document's "connections".`,
  });
}

/** The connection a document name binds to: a handle carrying its manifest entry, or the bare name without a manifest. */
function documentTarget(
  name: string,
  where: string,
  ctx: HydrationContext,
): StepConnectionTarget<ContextData, string> {
  checkManifestName(name, where, ctx);
  const entry = ctx.connections?.[name];
  return entry ? documentHandle(name, entry, ctx.connectionUses?.get(name)) : name;
}

/**
 * The connection a `call` or `wait` node runs on: its own, else the enclosing
 * one, else the document's only connection. An expression is evaluated per run.
 *
 * @throws `NoeticConfigError` `CONNECTION_UNKNOWN` for an undeclared name, `CONNECTION_INVALID` when none is named or implied (or an expression gives no name).
 */
function connectionTargetFor(
  ref: ConnectionRef | undefined,
  where: string,
  ctx: HydrationContext,
): StepConnectionTarget<ContextData, string> {
  const effective = ref ?? ctx.enclosingConnection ?? onlyConnection(ctx);
  if (effective === undefined) {
    throw new NoeticConfigError({
      code: 'CONNECTION_INVALID',
      message: `${where} names no connection, and none is implied.`,
      hint: 'Give the node a "connection", or run it inside a verify whose subject is the connection.',
    });
  }
  if (typeof effective === 'string') {
    return documentTarget(effective, where, ctx);
  }
  if (isParamUse(effective)) {
    return async (input: string, execCtx: Context) =>
      namedTarget(
        await fromParam(execCtx, effective, [
          input,
          execCtx,
        ]),
        where,
        ctx,
      );
  }
  const compiled = compileExpression(
    effective.$expr,
    `connection of ${where}`,
    ctx.expressionLimits,
  );
  return async (input: string, execCtx: Context) =>
    namedTarget(await compute(compiled, readInput(input), bindingsFor(execCtx, ctx)), where, ctx);
}

/**
 * The connection a name computed at run time stands for.
 *
 * @throws `NoeticConfigError` `CONNECTION_INVALID` when `name` is not a connection name, `CONNECTION_UNKNOWN` when the manifest does not declare it.
 */
function namedTarget(
  name: unknown,
  where: string,
  ctx: HydrationContext,
): ConnectionHandle | string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new NoeticConfigError({
      code: 'CONNECTION_INVALID',
      message: `The connection of ${where} was computed as ${JSON.stringify(name)}, not a connection name.`,
      hint: 'Give a declared connection name, e.g. { "$expr": "$item" } inside a fan-out.',
    });
  }
  const target = documentTarget(name, where, ctx);
  return typeof target === 'function' ? name : target;
}

/** The document's only connection, which a node without one runs on. */
function onlyConnection(ctx: HydrationContext): string | undefined {
  const names = Object.keys(ctx.connections ?? {});
  return names.length === 1 ? names[0] : undefined;
}

/** The operations the document uses on a node's connection (gate 1), when the name is static. */
function declaredOpsFor(
  ref: ConnectionRef | undefined,
  op: string,
  ctx: HydrationContext,
): string[] {
  const name = typeof ref === 'string' ? ref : undefined;
  const used = name === undefined ? undefined : ctx.connectionUses?.get(name)?.ops;
  if (used && used.size > 0) {
    return [
      ...used,
    ];
  }
  const all = new Set<string>([
    op,
  ]);
  for (const use of ctx.connectionUses?.values() ?? []) {
    for (const usedOp of use.ops) {
      all.add(usedOp);
    }
  }
  return [
    ...all,
  ];
}

/** Registers a step built here as an object literal, like the builders do. */
function registered<S extends Step<ContextData, string, string>>(built: S): S {
  getDefaultRegistrar().register(frameworkCast<Step>(built));
  return built;
}

export function hydrateCallNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'call') {
    return frameworkCast(undefined);
  }
  const where = `call node '${node.id}'`;
  const ref = paramFor(node, 'connection') ?? node.connection;
  const connection = connectionTargetFor(ref, where, ctx);
  const args = compileArgs(node.args, `args of ${where}`, ctx.expressionLimits);
  const argsParam = paramFor(node, 'args');
  const built: StepCall<ContextData, string, string> & {
    _caller: 'document' | 'step';
    _declaredOps: string[];
    _documentSecrets: Array<{
      name: string;
      field: string;
    }>;
  } = {
    kind: 'call',
    id: node.id,
    connection,
    op: node.op,
    args: (input: string, execCtx: Context) =>
      argsParam
        ? fromParam(execCtx, argsParam, [
            input,
            execCtx,
          ])
        : args(readInput(input), bindingsFor(execCtx, ctx)),
    // Args a host's own function gives, in a document the host wrote, are a
    // step's args: they may carry a secret no document wrote out.
    _caller: argsParam && !ctx.acpBounds ? 'step' : 'document',
    _declaredOps: declaredOpsFor(ref ?? ctx.enclosingConnection, node.op, ctx),
    _documentSecrets: documentSecretsOf(node.args),
  };
  return registered(built);
}

/** A `wait` node's filter: its function from a param, its expression, or none. */
function waitFilterOf(
  node: WaitWorkflowNode,
  where: string,
  ctx: HydrationContext,
): StepWait<ContextData, string, string>['filter'] {
  const param = paramFor(node, 'filter');
  if (param) {
    return async (event, input, execCtx) =>
      (await fromParam(execCtx, param, [
        event,
        input,
        execCtx,
      ])) === true;
  }
  if (node.filter === undefined) {
    return undefined;
  }
  return waitFilter(
    compileExpression(node.filter, `filter of ${where}`, ctx.expressionLimits),
    ctx,
  );
}

/** A wait filter expression: a test against `{ event, input }`. */
function waitFilter(
  compiled: CompiledExpression,
  ctx: HydrationContext,
): NonNullable<StepWait<ContextData, string, string>['filter']> {
  return (event, input, execCtx) =>
    passes(
      compiled,
      {
        event,
        input: readInput(input),
      },
      bindingsFor(execCtx, ctx),
    );
}

export function hydrateWaitNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'wait') {
    return frameworkCast(undefined);
  }
  const where = `wait node '${node.id}'`;
  const ref = paramFor(node, 'connection') ?? node.connection;
  const connectionRef = ref ?? ctx.enclosingConnection ?? onlyConnection(ctx);
  const connection = connectionTargetFor(ref, where, ctx);
  const filter = waitFilterOf(node, where, ctx);
  const around =
    node.around === undefined
      ? undefined
      : hydrateStepList({
          list: node.around,
          parentId: node.id,
          ctx,
          enclosing: connectionRef,
        });
  const built: StepWait<ContextData, string, string> = {
    kind: 'wait',
    id: node.id,
    connection,
    event: node.event,
    timeoutMs: node.timeoutMs,
    ...(filter
      ? {
          filter,
        }
      : {}),
    ...(around
      ? {
          around,
        }
      : {}),
  };
  return registered(built);
}

//#endregion

//#region Agent and Code Node Hydrators

/**
 * Hydrates an `acp-agent` node into `step.acpAgent`. Under `ctx.acpBounds` the
 * node's cwd, client capabilities and session key are held to its agent's
 * grant (see `boundedAcpSettings`).
 *
 * @throws `NoeticConfigError` `UNKNOWN_ACP_AGENT_REFERENCE` when `ctx.acpAgents` has no adapter for the node's agent.
 */
export function hydrateAcpAgentNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'acp-agent') {
    return frameworkCast(undefined);
  }
  const agent = ctx.acpAgents?.get(node.agent);
  if (!agent) {
    throw new NoeticConfigError({
      code: 'UNKNOWN_ACP_AGENT_REFERENCE',
      message: `ACP agent '${node.agent}' referenced in workflow node '${node.id}' is not registered.`,
      hint: 'Pass agent adapters via HydrationContext.acpAgents, e.g. createAcpAgentRegistry(claudeCode()) from @noetic-tools/acp.',
    });
  }
  const bounded = ctx.acpBounds ? boundedAcpSettings(node, ctx.acpBounds) : node;
  const built: Step<ContextData, string, string> = step.acpAgent({
    id: node.id,
    agent,
    // An empty prompt makes the step's input the prompt.
    prompt: lazyOption(node, 'prompt', node.prompt ?? ''),
    content: lazyOption(
      node,
      'content',
      frameworkCast<ReadonlyArray<AcpContentBlock> | undefined>(node.content),
    ),
    instructions: lazyOption(node, 'instructions', node.instructions),
    cwd: lazyOption(node, 'cwd', bounded.cwd),
    mode: lazyOption(node, 'mode', node.mode),
    model: lazyOption(node, 'model', node.model),
    tools: lazyOption(
      node,
      'tools',
      nodeTools(node, {
        ...ctx,
        spawn: agent.spawn,
      }),
    ),
    permissions: node.permissions && permissionPolicy(node.permissions),
    onPermissionRequest: permissionHandler(node),
    clientCapabilities: bounded.clientCapabilities,
    session: bounded.session,
    subprocess: node.subprocess,
    fs: node.fs,
    shell: node.shell,
    output: node.output && frameworkCast(outputSchemaOf(node.output.schema, node.id)),
    // A document the host did not write cannot hide its agent's turn from the stream.
    emit: ctx.acpBounds ? undefined : emitOption(node),
  });
  return withCeiling(built, node, ctx);
}

export function hydrateRunCodeNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'runCode') {
    return frameworkCast(undefined);
  }
  const inProcess = paramFor(node, 'execute');
  if (inProcess) {
    return frameworkCast(
      runCode({
        id: node.id,
        retry: node.retry,
        subprocess: namedSubprocess(node.subprocess, node.id, ctx),
        // Not `async`: a generator the function gives must reach the step as one.
        execute: (input: string, execCtx: Context) =>
          frameworkCast<Promise<string>>(
            fromParam(execCtx, inProcess, [
              input,
              execCtx,
            ]),
          ),
      }),
    );
  }
  // The schema gives a node without `fromParams.execute` its code.
  const code = node.execute ?? '';
  const subprocessRef = node.subprocess;
  return frameworkCast(
    runCode({
      id: node.id,
      retry: node.retry,
      execute: async (input: string, execCtx: Context) => {
        const adapter = resolveSubprocessAdapter({
          ref: subprocessRef,
          hydrationCtx: ctx,
          execCtx,
          nodeId: node.id,
        });
        return runCodeViaSubprocess({
          adapter,
          nodeId: node.id,
          code,
          input: outputText(input),
        });
      },
    }),
  );
}

//#endregion

//#region Run Node Helpers

/**
 * The subprocess adapter a node names, resolved when the document hydrates.
 *
 * @throws `NoeticConfigError` `UNKNOWN_SUBPROCESS_REFERENCE` when the hydration context resolves no such adapter.
 */
export function namedSubprocess(
  ref: string | undefined,
  nodeId: string,
  ctx: HydrationContext,
): SubprocessAdapter | undefined {
  if (ref === undefined) {
    return undefined;
  }
  const adapter = ctx.resolveSubprocess?.(ref);
  if (adapter) {
    return adapter;
  }
  throw new NoeticConfigError({
    code: 'UNKNOWN_SUBPROCESS_REFERENCE',
    message: `Subprocess adapter '${ref}' referenced in node '${nodeId}' could not be resolved.`,
    hint: 'Pass a `resolveSubprocess(ref)` mapping in the HydrationContext, or omit `subprocess` to use the harness adapter.',
  });
}

/** A node's permission policy as the step takes it: a `titlePattern` becomes the `RegExp` title it stands for. */
function permissionPolicy(
  policy: NonNullable<AcpAgentWorkflowNode['permissions']>,
): AcpPermissionPolicy {
  const rules = (list: typeof policy.allow): AcpPermissionRule[] | undefined =>
    list?.map((rule) => ({
      kind: rule.kind,
      title:
        rule.titlePattern === undefined
          ? rule.title
          : new RegExp(rule.titlePattern, rule.titleFlags),
    }));
  return {
    default: policy.default,
    allow: rules(policy.allow),
    deny: rules(policy.deny),
    persist: policy.persist,
  };
}

/** The step's permission handler, when the node names a param holding one. */
function permissionHandler(node: AcpAgentWorkflowNode): AcpPermissionHandler | undefined {
  const param = paramFor(node, 'onPermissionRequest');
  return param
    ? async (request, execCtx, info) =>
        frameworkCast<AcpPermissionOutcome>(
          await paramFunction(execCtx, param)(request, execCtx, info),
        )
    : undefined;
}

/**
 * The subprocess adapter a `runCode` node runs through: the harness's default
 * when it names none, else the one the host's `resolveSubprocess` gives for
 * the name, else the harness's adapter of that name. `resolveSubprocess` is
 * the host's own code and needs no grant; a harness name does, under
 * `runCodeBounds`.
 *
 * @throws `NoeticConfigError` `CONNECTION_NOT_ALLOWED` for a harness name the bounds do not grant,
 * `UNKNOWN_SUBPROCESS_REFERENCE` when neither knows the name.
 */
function resolveSubprocessAdapter(opts: {
  ref: string | undefined;
  hydrationCtx: HydrationContext;
  execCtx: Context;
  nodeId: string;
}): SubprocessAdapter {
  const { ref, hydrationCtx, execCtx, nodeId } = opts;
  if (ref === undefined) {
    return execCtx.subprocess;
  }
  const resolved = hydrationCtx.resolveSubprocess?.(ref);
  if (resolved) {
    return resolved;
  }
  const bounds = hydrationCtx.runCodeBounds;
  if (bounds) {
    checkRunCodeNode(
      {
        id: nodeId,
        subprocess: ref,
      },
      bounds,
    );
  }
  const names = execCtx.adapters.subprocess.list().map((adapter) => adapter.name);
  if (names.includes(ref)) {
    return execCtx.adapters.subprocess.get(ref);
  }
  // Only a document the host wrote is told the harness's names.
  const known = bounds ? '' : ` The harness has ${names.map((name) => `'${name}'`).join(', ')}.`;
  throw new NoeticConfigError({
    code: 'UNKNOWN_SUBPROCESS_REFERENCE',
    message: `Subprocess adapter '${ref}' referenced in run node '${nodeId}' could not be resolved.${known}`,
    hint: bounds
      ? 'Omit `subprocess` to run on the default adapter.'
      : 'Name one of the harness adapters, map the name in `HydrationContext.resolveSubprocess`, or omit `subprocess` to use the harness default (ctx.subprocess).',
  });
}

/**
 * Dispatches a `runCode` node's code string through a subprocess adapter: ships the
 * code plus the JSON-stringified input as a process request (input on stdin),
 * waits for the handle to settle, and returns the captured stdout as the step
 * output. A non-zero exit / failed handle surfaces as a thrown error.
 *
 * The code is never eval'd in-process (Cloudflare Workers forbid eval). The
 * adapter owns running the code and capturing stdout into `handle.metadata.result`.
 */
async function runCodeViaSubprocess(opts: {
  adapter: SubprocessAdapter;
  nodeId: string;
  code: string;
  input: string;
}): Promise<string> {
  const { adapter, nodeId, code, input } = opts;
  const request: ProcessSubprocessRequest = {
    kind: 'process',
    command: 'node',
    args: [
      '-e',
      code,
    ],
    stdin: input,
    metadata: {
      noeticRun: true,
      stepId: nodeId,
      code,
      input,
    },
  };
  const handle = new DetachedHandleImpl<string>({
    id: `run-${nodeId}`,
    stepId: nodeId,
    spawned: adapter.spawn(request),
  });
  const result = await handle.await();
  return outputText(result);
}

//#endregion
