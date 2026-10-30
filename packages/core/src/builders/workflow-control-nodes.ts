/**
 * Hydrators for the control-flow nodes of a JSON workflow: `conditional`,
 * `decide`, `routeSwitch`, `loop` (with its until predicates), and `schedule`.
 */

import type { ContextData } from '@noetic-tools/context';
import type { Context, Step, StepDecide, Until } from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import type { ExpressionBindings, ExpressionLimits } from '../expression/jsonata';
import { compileExpression, passes, readInput } from '../expression/jsonata';
import { stepOutputsOf } from '../expression/step-outputs';
import type {
  ConditionalRoute,
  DecideWorkflowNode,
  UntilPredicate,
  WorkflowNode,
} from '../schemas/workflow';
import { all, any } from '../until/combinators';
import { until } from '../until/predicates';
import { conditional } from './control-flow-builders';
import { decide, routeSwitch } from './decide-builders';
import { schedule } from './every';
import { loop } from './loop-builder';
import type { HydrationContext } from './workflow-hydrator';
import { bindingsFor, documentScopeOf, hydrateNode } from './workflow-hydrator';

//#region Control-Flow Node Hydrators

/**
 * A `decide` predicate hydrates to the decide step itself; the loop runs it as
 * the decider. `where` names the loop in errors from its `expr` predicates.
 */
function hydrateUntilPredicate(
  pred: UntilPredicate,
  ctx: HydrationContext,
  where: string,
): Until | StepDecide<ContextData> {
  const hydrate = (p: UntilPredicate): Until | StepDecide<ContextData> =>
    hydrateUntilPredicate(p, ctx, where);
  switch (pred.kind) {
    case 'maxSteps':
      return until.maxSteps(pred.n);
    case 'maxCost':
      return until.maxCost(pred.usd);
    case 'maxDuration':
      return until.maxDuration(pred.duration);
    case 'noToolCalls':
      return until.noToolCalls();
    case 'never':
      return until.never();
    case 'outputContains':
      return until.outputContains(pred.marker);
    case 'outputEquals':
      return until.outputEquals(pred.sentinel);
    case 'converged':
      return until.converged({
        threshold: pred.threshold,
      });
    case 'expr':
      return untilExpr(pred.expr, where, ctx);
    case 'any':
      return any(...pred.predicates.map(hydrate));
    case 'all':
      return all(...pred.predicates.map(hydrate));
    case 'decide':
      return frameworkCast<StepDecide<ContextData>>(hydrateNode(pred, ctx));
    default:
      throw new NoeticConfigError({
        code: 'UNKNOWN_UNTIL_PREDICATE',
        message: `Unknown until predicate kind: '${frameworkCast<UntilPredicate>(pred).kind}'.`,
        hint: 'Supported kinds: maxSteps, maxCost, maxDuration, noToolCalls, never, outputContains, outputEquals, converged, expr, any, all, decide.',
      });
  }
}

/**
 * Stops when `expr` gives `true` against the loop's last output, read as an
 * expression input. A failing expression throws `NoeticConfigError`, which
 * fails the loop instead of stopping it (spec 05, Error Behavior).
 */
function untilExpr(expr: string, where: string, ctx: HydrationContext): Until {
  const compiled = compileExpression(expr, where, ctx.expressionLimits);
  const scope = documentScopeOf(ctx);
  return async (snap, run) => {
    const stop = await passes(compiled, readInput(snap.lastOutput), {
      steps: run ? stepOutputsOf(frameworkCast<Context>(run.ctx), scope) : {},
    });
    return {
      stop,
      reason: stop ? `expr gave true: ${expr}` : undefined,
    };
  };
}

export function hydrateConditionalNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'conditional') {
    return frameworkCast(undefined);
  }

  const hydratedRoutes = node.routes.map((r, i) => ({
    passes: routeTest(r, `route ${i} of conditional node '${node.id}'`, ctx.expressionLimits),
    target: hydrateNode(r.target, ctx),
  }));
  const defaultTarget = node.default ? hydrateNode(node.default, ctx) : null;

  const allTargets = hydratedRoutes.map((r) => r.target);
  if (defaultTarget) {
    allTargets.push(defaultTarget);
  }

  return conditional({
    id: node.id,
    route: async (input: string, execCtx: Context) => {
      const view: RouteInput = {
        text: routeText(input).trim().toLowerCase(),
        value: readInput(input),
        bindings: bindingsFor(execCtx, ctx),
      };
      for (const r of hydratedRoutes) {
        if (await r.passes(view)) {
          return r.target;
        }
      }
      return defaultTarget;
    },
    _optimizable: frameworkCast(allTargets),
  });
}

/** A conditional's input as its routes read it: lower-cased text for `match`, the read value for `expr`. */
interface RouteInput {
  text: string;
  value: unknown;
  bindings: ExpressionBindings;
}

function routeTest(
  route: ConditionalRoute,
  where: string,
  limits: ExpressionLimits | undefined,
): (input: RouteInput) => boolean | Promise<boolean> {
  if (route.expr !== undefined) {
    const compiled = compileExpression(route.expr, where, limits);
    return (input) => passes(compiled, input.value, input.bindings);
  }
  const needle = (route.match ?? '').toLowerCase();
  return (input) => input.text.includes(needle);
}

/**
 * The text a branch matches against. An object input — a `decide` node's
 * answers, or their JSON once a sequence has stringified them — matches on its
 * string values only: its keys and probability maps name every choice, so
 * matching the JSON would hit every route.
 */
function routeText(input: unknown): string {
  const value = typeof input === 'string' ? parseJsonObject(input) : input;
  if (typeof value === 'string') {
    return value;
  }
  const values: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      values.push(value);
      return;
    }
    if (typeof value !== 'object' || value === null) {
      return;
    }
    for (const child of Object.values(value)) {
      walk(child);
    }
  };
  walk(value);
  return values.join('\n');
}

/** The parsed object or array when `text` is one in JSON, else `text` itself. */
function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return text;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null ? parsed : text;
  } catch {
    return text;
  }
}

export function hydrateDecideNode(
  node: WorkflowNode,
  _ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'decide') {
    return frameworkCast(undefined);
  }
  return frameworkCast(decideFromNode(node));
}

function decideFromNode(node: DecideWorkflowNode) {
  return decide({
    id: node.id,
    model: node.model,
    instructions: node.instructions,
    questions: node.questions,
    view: node.view,
    samples: node.samples,
  });
}

export function hydrateRouteSwitchNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'routeSwitch') {
    return frameworkCast(undefined);
  }
  const cases: Record<string, Step<ContextData, string, string>> = {};
  for (const [key, target] of Object.entries(node.cases)) {
    cases[key] = hydrateNode(target, ctx);
  }
  // A JSON node's outcomes are only known at runtime; the builder checks them.
  return frameworkCast(
    routeSwitch({
      id: node.id,
      decide: decideFromNode(node.decide),
      on: node.on,
      cases: frameworkCast<Record<never, Step<ContextData, string, string>>>(cases),
      minConfidence: node.minConfidence,
      uncertain: hydrateNode(node.uncertain, ctx),
    }),
  );
}

export function hydrateLoopNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'loop') {
    return frameworkCast(undefined);
  }
  return loop({
    id: node.id,
    steps: [
      hydrateNode(node.body, ctx),
    ],
    until: hydrateUntilPredicate(node.until, ctx, `until of loop node '${node.id}'`),
    maxIterations:
      node.maxIterations === 'infinity' ? Number.POSITIVE_INFINITY : node.maxIterations,
  });
}

export function hydrateScheduleNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'schedule') {
    return frameworkCast(undefined);
  }
  return schedule({
    id: node.id,
    step: hydrateNode(node.step, ctx),
    interval: node.interval,
    onError: node.onError,
  });
}

//#endregion
