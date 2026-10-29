/**
 * Hydrates the JSON `verify` node (spec 37 § In JSON, spec 26) into a
 * `StepVerify`. Operations written by name in `act` — and `call`/`wait` nodes
 * without a `connection` — run on the subject. A list subject hydrates one
 * verify per connection (ids `<id>.<name>`, each with `act` on its own
 * subject), run in parallel under the node's id with the worst outcome.
 */

import type { ContextData } from '@noetic-tools/context';
import type {
  ConnectionHandle,
  Context,
  Step,
  StepVerify,
  WorkflowVerifyMatcher,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError, verifyMatcherFromJson } from '@noetic-tools/types';
import type { RunOutcome, VerifyMatcher, VerifyOutput } from '@noetic-tools/types/verify';
import { VerifyConfigErrorCode } from '@noetic-tools/types/verify';
import { compileExpression, compute, readInput } from '../expression/jsonata';
import { stepOutputsOf } from '../expression/step-outputs';
import type { WorkflowConnectionRef, WorkflowNode } from '../schemas/workflow';
import { getDefaultRegistrar } from '../types/step-registrar';
import type { VerifyEachOutput } from './verify-builder';
import { documentHandle } from './workflow-connections';
import type { HydrationContext } from './workflow-hydrator';
import { documentScopeOf, hydrateStepList } from './workflow-hydrator';

//#region Types

type VerifyWorkflowNode = Extract<
  WorkflowNode,
  {
    kind: 'verify';
  }
>;

type Target = ConnectionHandle | string;

//#endregion

//#region Constants

const OUTCOME_RANK: Readonly<Record<RunOutcome, number>> = {
  pass: 0,
  unknown: 1,
  partial: 2,
  fail: 3,
};

//#endregion

//#region Helpers

function registered<S extends Step<ContextData, string, string>>(built: S): S {
  getDefaultRegistrar().register(frameworkCast<Step>(built));
  return built;
}

/**
 * A JSON matcher in its TypeScript form.
 *
 * @throws `NoeticConfigError` `VERIFY_INVALID` when it names no sense or event.
 */
function matcherOf(json: WorkflowVerifyMatcher, where: string): VerifyMatcher {
  const matcher = verifyMatcherFromJson(json);
  if (matcher) {
    return matcher;
  }
  throw new NoeticConfigError({
    code: VerifyConfigErrorCode.Invalid,
    message: `${where} names no sense or event: ${JSON.stringify(json)}.`,
    hint: 'Write a matcher as one sense key and its matcher text, e.g. { "net": "POST /api/orders 201", "count": 1 }.',
  });
}

/**
 * A connection the node names, bound to its manifest entry when the document declares one.
 *
 * @throws `NoeticConfigError` `CONNECTION_UNKNOWN` for a name the manifest does not declare.
 */
function documentTarget(name: string, where: string, ctx: HydrationContext): Target {
  if (!ctx.connections) {
    return name;
  }
  const entry = ctx.connections[name];
  if (entry) {
    return documentHandle(name, entry, ctx.connectionUses?.get(name));
  }
  const declared = Object.keys(ctx.connections);
  throw new NoeticConfigError({
    code: 'CONNECTION_UNKNOWN',
    message: `${where} uses connection '${name}', which the document's connections do not declare.`,
    hint: `Use one of ${declared.join(', ') || '(none)'}, or add '${name}' to the document's "connections".`,
  });
}

/** A subject expression, evaluated per run against the node's input. */
function expressionTarget(
  expr: string,
  where: string,
  ctx: HydrationContext,
): (input: string, execCtx: Context) => Promise<Target> {
  const compiled = compileExpression(expr, `subject of ${where}`, ctx.expressionLimits);
  return async (input, execCtx) => {
    const name = await compute(compiled, readInput(input), {
      steps: stepOutputsOf(execCtx, documentScopeOf(ctx)),
      ...(ctx.fanOutItem === undefined
        ? {}
        : {
            item: ctx.fanOutItem,
          }),
    });
    if (typeof name !== 'string' || name.length === 0) {
      throw new NoeticConfigError({
        code: 'CONNECTION_INVALID',
        message: `The subject expression of ${where} gave ${JSON.stringify(name)}, not a connection name.`,
        hint: 'Write an expression that gives a declared connection name, e.g. { "$expr": "$item" } inside a fan-out.',
      });
    }
    return documentTarget(name, where, ctx);
  };
}

function hydrateOne(opts: {
  node: VerifyWorkflowNode;
  id: string;
  subject: WorkflowConnectionRef;
  ctx: HydrationContext;
}): StepVerify<ContextData, string, string> {
  const { node, id, subject, ctx } = opts;
  const where = `verify node '${id}'`;
  const built: StepVerify<ContextData, string, string> = {
    kind: 'verify',
    id,
    subject:
      typeof subject === 'string'
        ? documentTarget(subject, where, ctx)
        : expressionTarget(subject.$expr, where, ctx),
    act: frameworkCast<ReadonlyArray<Step<ContextData, string, unknown>>>(
      hydrateStepList({
        list: node.act,
        parentId: id,
        ctx,
        enclosing: subject,
      }),
    ),
    ...(node.expect === undefined
      ? {}
      : {
          expect: node.expect.map((m, i) => matcherOf(m, `expect[${i}] of ${where}`)),
        }),
    ...(node.never === undefined
      ? {}
      : {
          never: node.never.map((m, i) => matcherOf(m, `never[${i}] of ${where}`)),
        }),
    ...(node.claims === undefined
      ? {}
      : {
          claims: node.claims,
        }),
    ...(node.constraints === undefined
      ? {}
      : {
          constraints: node.constraints,
        }),
    ...(node.witnesses === undefined
      ? {}
      : {
          witnesses: node.witnesses.map((w) => documentTarget(w, `witnesses of ${where}`, ctx)),
        }),
    ...(node.close === undefined
      ? {}
      : {
          close: node.close,
        }),
    ...(node.intent === undefined
      ? {}
      : {
          intent: node.intent,
        }),
  };
  return registered(built);
}

/** One verify per listed connection, run in parallel; the worst outcome wins. */
function hydrateEach(
  node: VerifyWorkflowNode,
  names: ReadonlyArray<string>,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  const verifies = names.map((name) => ({
    name,
    step: hydrateOne({
      node,
      id: `${node.id}.${name}`,
      subject: name,
      ctx,
    }),
  }));
  const built: Step<ContextData, string, string> = {
    kind: 'runCode',
    id: node.id,
    execute: async (input: string, execCtx: Context) => {
      const outputs = await Promise.all(
        verifies.map(async (v) => ({
          name: v.name,
          output: frameworkCast<VerifyOutput>(await ctx.executeStep(v.step, input, execCtx)),
        })),
      );
      const result: VerifyEachOutput = {
        outcome: outputs.reduce<RunOutcome>(
          (worst, o) =>
            OUTCOME_RANK[o.output.outcome] > OUTCOME_RANK[worst] ? o.output.outcome : worst,
          'pass',
        ),
        subjects: Object.fromEntries(
          outputs.map((o) => [
            o.name,
            o.output,
          ]),
        ),
      };
      return frameworkCast<string>(result);
    },
  };
  return registered(built);
}

//#endregion

//#region Public API

/**
 * Hydrates a JSON `verify` node.
 *
 * @public
 * @throws `NoeticConfigError` `VERIFY_INVALID` for a matcher that names no sense or event;
 *   `CONNECTION_UNKNOWN` for a subject or witness the document's connections do not declare.
 */
export function hydrateVerifyNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'verify') {
    return frameworkCast(undefined);
  }
  if (Array.isArray(node.subject)) {
    return hydrateEach(node, node.subject, ctx);
  }
  return hydrateOne({
    node,
    id: node.id,
    subject: node.subject,
    ctx,
  });
}

//#endregion
