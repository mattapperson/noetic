/**
 * Hydrators for the control-flow nodes of a JSON workflow: `conditional`,
 * `decide`, `routeSwitch`, `loop` (with its until predicates), and `schedule`.
 */

import type { ContextData } from '@noetic-tools/context';
import type {
  Channel,
  Context,
  DecideQuestions,
  DecideStep,
  Lazy,
  Step,
  StepDecide,
  Until,
  Verdict,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';
import type { ExpressionBindings, ExpressionLimits } from '../expression/jsonata';
import { compileExpression, passes, readInput } from '../expression/jsonata';
import { loopRunsOf, stepOutputsOf } from '../expression/step-outputs';
import type {
  ConditionalRoute,
  DecideWorkflowNode,
  UntilPredicate,
  WorkflowChannel,
  WorkflowNode,
} from '../schemas/workflow';
import { all, any } from '../until/combinators';
import { until } from '../until/predicates';
import { channel } from './channel-builder';
import { conditional } from './control-flow-builders';
import { decide, routeSwitch } from './decide-builders';
import { schedule } from './every';
import { loop } from './loop-builder';
import type { HydrationContext } from './workflow-hydrator';
import { bindingsFor, documentScopeOf, hydrateNode } from './workflow-hydrator';
import {
  emitOption,
  fromParam,
  fromParamSync,
  lazyOption,
  paramFor,
  paramFunction,
} from './workflow-params';

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
    case 'param':
      return untilParam(pred.name, where);
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
        hint: 'Supported kinds: maxSteps, maxCost, maxDuration, noToolCalls, never, outputContains, outputEquals, converged, expr, param, any, all, decide.',
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
    const runCtx = run ? frameworkCast<Context>(run.ctx) : undefined;
    const stop = await passes(compiled, readInput(snap.lastOutput), {
      steps: runCtx ? stepOutputsOf(runCtx, scope) : {},
      runs: runCtx ? loopRunsOf(runCtx, scope) : {},
    });
    return {
      stop,
      reason: stop ? `expr gave true: ${expr}` : undefined,
    };
  };
}

/**
 * Asks the `Until` function a harness param holds, read each time the loop
 * asks. With no run to read params from, the loop goes on.
 */
function untilParam(name: string, where: string): Until {
  return async (snap, run) => {
    if (!run) {
      return {
        stop: false,
      };
    }
    const ask = paramFunction(frameworkCast<Context>(run.ctx), {
      name,
      where,
    });
    return checkedVerdict(await ask(snap, run), name, where);
  };
}

/**
 * What an `Until` function from a param gave, as a verdict.
 *
 * @throws `NoeticConfigError` `INVALID_UNTIL_VERDICT` when it is not `{ stop: boolean, … }`: a loop cannot guess whether to go on.
 */
function checkedVerdict(value: unknown, name: string, where: string): Verdict {
  if (
    typeof value === 'object' &&
    value !== null &&
    'stop' in value &&
    typeof value.stop === 'boolean'
  ) {
    return frameworkCast<Verdict>(value);
  }
  throw new NoeticConfigError({
    code: 'INVALID_UNTIL_VERDICT',
    message: `The ${where} asked harness param '${name}', which gave ${JSON.stringify(value)}, not a verdict.`,
    hint: `Make params.${name} return { stop: true } or { stop: false }, with an optional reason.`,
  });
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
  const routeParam = paramFor(node, 'route');

  return conditional({
    id: node.id,
    route: async (input: string, execCtx: Context, run) => {
      if (routeParam) {
        const id = await fromParam(execCtx, routeParam, [
          input,
          execCtx,
          run,
        ]);
        // The function names a target by the id the document wrote.
        return id === undefined || id === null
          ? defaultTarget
          : targetById(allTargets, `${String(id)}${ctx.idSuffix ?? ''}`, routeParam.where);
      }
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

/**
 * The target a route function named.
 *
 * @throws `NoeticConfigError` `UNKNOWN_ROUTE_TARGET` when no target has that id.
 */
function targetById(
  targets: ReadonlyArray<Step<ContextData, string, string>>,
  id: string,
  where: string,
): Step<ContextData, string, string> {
  const target = targets.find((step) => step.id === id);
  if (target) {
    return target;
  }
  throw new NoeticConfigError({
    code: 'UNKNOWN_ROUTE_TARGET',
    message: `${where} gave ${JSON.stringify(id)}, which is not the id of one of its targets.`,
    hint: `Give the id of a target (${targets.map((step) => step.id).join(', ')}), or nothing for the default.`,
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
  if (route.match === undefined) {
    // A route with no test is one a route function picks by id.
    return () => false;
  }
  const needle = route.match.toLowerCase();
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
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'decide') {
    return frameworkCast(undefined);
  }
  return frameworkCast(decideFromNode(node, ctx));
}

/** A `routeSwitch`'s decide node as a step, hydrated like any node so its own options apply. */
function decideStep(
  node: DecideWorkflowNode,
  ctx: HydrationContext,
): DecideStep<ContextData, unknown, DecideQuestions> {
  return frameworkCast(hydrateNode(node, ctx));
}

function decideFromNode(
  node: DecideWorkflowNode,
  ctx: HydrationContext,
): DecideStep<ContextData, unknown, DecideQuestions> {
  const context = paramFor(node, 'context');
  return decide({
    id: node.id,
    // A param that gives no model fails the step with MISSING_MODEL, as a getter's would.
    model: frameworkCast<Lazy<string> | undefined>(lazyOption(node, 'model', node.model)),
    instructions: lazyOption(node, 'instructions', node.instructions),
    questions: node.questions,
    view: node.view,
    samples: node.samples,
    headers: node.headers,
    projection: node.projection,
    // A document the host did not write cannot hide its model calls from the stream.
    emit: ctx.acpBounds ? undefined : emitOption(node),
    context: context
      ? async (execCtx: Context) =>
          frameworkCast<Record<string, unknown>>(
            await fromParam(execCtx, context, [
              execCtx,
            ]),
          )
      : undefined,
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
  const uncertain = node.uncertain && hydrateNode(node.uncertain, ctx);
  const on = paramFor(node, 'on');
  if (on) {
    return frameworkCast(
      routeSwitch({
        id: node.id,
        decide: decideStep(node.decide, ctx),
        on: (answers: unknown, execCtx: Context) =>
          String(
            fromParamSync(execCtx, on, [
              answers,
              execCtx,
            ]),
          ),
        cases: frameworkCast<Record<never, Step<ContextData, string, string>>>(cases),
        // The schema gives a node routed by a function its default.
        default: frameworkCast<Step<ContextData, string, string>>(
          node.default && hydrateNode(node.default, ctx),
        ),
        uncertain,
      }),
    );
  }
  // A JSON node's outcomes are only known at runtime; the builder checks them.
  return frameworkCast(
    routeSwitch({
      id: node.id,
      decide: decideStep(node.decide, ctx),
      on: node.on ?? '',
      cases: frameworkCast<Record<never, Step<ContextData, string, string>>>(cases),
      minConfidence: node.minConfidence,
      uncertain: frameworkCast<Step<ContextData, string, string>>(uncertain),
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
  const prepareNext = paramFor(node, 'prepareNext');
  const onError = paramFor(node, 'onError');
  const fixedOnError = node.onError;
  return loop({
    id: node.id,
    steps: [
      hydrateNode(node.body, ctx),
    ],
    until: hydrateUntilPredicate(node.until, ctx, `until of loop node '${node.id}'`),
    maxIterations:
      node.maxIterations === 'infinity' ? Number.POSITIVE_INFINITY : node.maxIterations,
    maxHistorySize: node.maxHistorySize,
    parkTimeout: node.parkTimeout,
    inbox: node.inbox && channelOf(node.inbox, z.string()),
    prepareNext: prepareNext
      ? (output, verdict, execCtx) =>
          frameworkCast<string>(
            fromParamSync(execCtx, prepareNext, [
              output,
              verdict,
              execCtx,
            ]),
          )
      : undefined,
    onError: onError
      ? (error, execCtx) =>
          frameworkCast<'retry' | 'skip' | 'abort'>(
            fromParamSync(execCtx, onError, [
              error,
              execCtx,
            ]),
          )
      : fixedOnError && (() => fixedOnError),
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
    jitter: node.jitter,
    inbox: node.inbox && channelOf(node.inbox, z.unknown()),
  });
}

/** The channel a node's `inbox` names: a queue unless the node says otherwise. */
function channelOf<T>(inbox: WorkflowChannel, schema: z.ZodType<T>): Channel<T> {
  return channel(inbox.name, {
    schema,
    mode: inbox.mode ?? 'queue',
    capacity: inbox.capacity,
    external: inbox.external,
  });
}

//#endregion
