/**
 * Hydrators for the connection nodes of a JSON workflow (spec 35): `call` and
 * `wait`, plus resolving the connection a node runs on against the document's
 * manifest.
 */

import type { ContextData } from '@noetic-tools/context';
import type { Context, Step, StepCall, StepConnectionTarget, StepWait } from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import type { CompiledExpression } from '../expression/jsonata';
import { compileExpression, compute, passes, readInput } from '../expression/jsonata';
import type { WorkflowConnectionRef, WorkflowNode } from '../schemas/workflow';
import { getDefaultRegistrar } from '../types/step-registrar';
import { compileArgs, documentHandle, documentSecretsOf } from './workflow-connections';
import type { HydrationContext } from './workflow-hydrator';
import { bindingsFor, hydrateStepList } from './workflow-hydrator';

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
  ref: WorkflowConnectionRef | undefined,
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
  const compiled = compileExpression(
    effective.$expr,
    `connection of ${where}`,
    ctx.expressionLimits,
  );
  return async (input: string, execCtx: Context) => {
    const name = await compute(compiled, readInput(input), bindingsFor(execCtx, ctx));
    if (typeof name !== 'string' || name.length === 0) {
      throw new NoeticConfigError({
        code: 'CONNECTION_INVALID',
        message: `The connection expression of ${where} gave ${JSON.stringify(name)}, not a connection name.`,
        hint: 'Write an expression that gives a declared connection name, e.g. { "$expr": "$item" } inside a fan-out.',
      });
    }
    const target = documentTarget(name, where, ctx);
    return typeof target === 'function' ? name : target;
  };
}

/** The document's only connection, which a node without one runs on. */
function onlyConnection(ctx: HydrationContext): string | undefined {
  const names = Object.keys(ctx.connections ?? {});
  return names.length === 1 ? names[0] : undefined;
}

/** The operations the document uses on a node's connection (gate 1), when the name is static. */
function declaredOpsFor(
  ref: WorkflowConnectionRef | undefined,
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
  const connection = connectionTargetFor(node.connection, where, ctx);
  const args = compileArgs(node.args, `args of ${where}`, ctx.expressionLimits);
  const built: StepCall<ContextData, string, string> & {
    _caller: 'document';
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
    args: (input: string, execCtx: Context) => args(readInput(input), bindingsFor(execCtx, ctx)),
    _caller: 'document',
    _declaredOps: declaredOpsFor(node.connection ?? ctx.enclosingConnection, node.op, ctx),
    _documentSecrets: documentSecretsOf(node.args),
  };
  return registered(built);
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
  const connectionRef = node.connection ?? ctx.enclosingConnection ?? onlyConnection(ctx);
  const connection = connectionTargetFor(node.connection, where, ctx);
  const filter =
    node.filter === undefined
      ? undefined
      : waitFilter(compileExpression(node.filter, `filter of ${where}`, ctx.expressionLimits), ctx);
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
