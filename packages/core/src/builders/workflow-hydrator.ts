/**
 * Converts a validated `WorkflowDocument` into a live `Step` tree.
 *
 * Each node kind maps to the corresponding builder (`callModel`, `inParallel`,
 * `loop`, etc.) so hydrated steps are indistinguishable from programmatic
 * ones — they register in the step registry, carry retry policies, etc.
 */

import type { ContextData, ContextLayer } from '@noetic-tools/context';
import type {
  AcpAgent,
  Context,
  CustomItemMap,
  ExecuteStepFn,
  OutputCodec,
  ProcessSubprocessRequest,
  ServerToolSpec,
  Step,
  StepCall,
  StepConnectionTarget,
  StepDecide,
  StepWait,
  SubprocessAdapter,
  Tool,
  ToolContext,
  ToolExecutionContext,
  Until,
} from '@noetic-tools/types';
import { frameworkCast, isServerToolSpec, NoeticConfigError } from '@noetic-tools/types';
import type {
  CompiledExpression,
  ExpressionBindings,
  ExpressionLimits,
} from '../expression/jsonata';
import { compileExpression, compute, passes, readInput } from '../expression/jsonata';
import { markRecorded, stepOutputsOf } from '../expression/step-outputs';
import type {
  CallModelWorkflowNode,
  ConditionalRoute,
  DecideWorkflowNode,
  OutputCodecRef,
  SubflowWorkflowNode,
  UntilPredicate,
  WorkflowConnectionRef,
  WorkflowDocument,
  WorkflowNode,
  WorkflowStepList,
} from '../schemas/workflow';
import { shorthandStepId, stepEntryToNode, stepListEntries } from '../schemas/workflow';
import { getDefaultRegistrar } from '../types/step-registrar';
import { all, any } from '../until/combinators';
import { until } from '../until/predicates';
import { DetachedHandleImpl } from '../util/detached-handle';

import { conditional, inParallel } from './control-flow-builders';
import { decide, routeSwitch } from './decide-builders';
import { schedule } from './every';
import { loop } from './loop-builder';
import { outputText } from './output-text';
import { withContext } from './provide-builder';
import { spawn } from './spawn-builder';
import { callModel, runCode, step } from './step-builders';
import type { ConnectionManifestEntries, ConnectionUses } from './workflow-connections';
import {
  checkDocumentConnections,
  compileArgs,
  documentHandle,
  documentSecretsOf,
} from './workflow-connections';
import {
  documentScope,
  everyDocumentItem,
  hydrateEmitItems,
  nodeScope,
} from './workflow-custom-items';
import { workflowReplayKey } from './workflow-replay-key';
import { hydrateVerifyNode } from './workflow-verify';

//#region Types

/** @public Context required to hydrate a JSON workflow into live steps. */
export interface HydrationContext {
  tools: ReadonlyMap<string, Tool>;
  executeStep: ExecuteStepFn;
  layers?: ReadonlyMap<string, ContextLayer>;
  /**
   * ACP agent adapters keyed by `agentId`, resolving an `acp-agent` node's
   * `agent` field. An OPEN registry — supporting a new agent needs no schema
   * change, only another entry here.
   */
  acpAgents?: ReadonlyMap<string, AcpAgent>;
  /**
   * Output codecs keyed by the `library` ref a `callModel` node's `output` codec
   * reference names — the live codec built from a component library, e.g.
   * `new Map([['dashboard-lib', openUi(dashboardLibrary)]])` from
   * `@noetic-tools/openui`. Resolved the same way ACP agent adapters are.
   */
  uiLibraries?: ReadonlyMap<string, OutputCodec>;
  /**
   * Resolves a named subprocess adapter ref declared on a `runCode` node's
   * `subprocess` field. When a node omits the ref, the step falls back to
   * `ctx.subprocess` at execution time.
   */
  resolveSubprocess?: (ref: string) => SubprocessAdapter | undefined;
  /**
   * Named sub-workflow documents that `subflow` nodes resolve via `ref`.
   * Resolution is lazy (first execution), so a live map view may gain
   * entries after hydration.
   */
  workflows?: ReadonlyMap<string, WorkflowDocument>;
  /**
   * Deepest allowed chain of named-ref resolutions on one execution path.
   * Positive integer or `Infinity`. Default: 100.
   */
  maxRecursionDepth?: number;
  /**
   * Named-ref resolutions above the node being hydrated. Threaded internally
   * by the subflow hydrator — callers never set it.
   */
  recursionDepth?: number;
  /** Bounds on each expression evaluation; unset fields use `DEFAULT_EXPRESSION_LIMITS`. */
  expressionLimits?: ExpressionLimits;
  /**
   * The hydrated document's identity for `$steps`: each `hydrateWorkflow` call
   * makes a new one, so two documents in one run never read each other's node
   * outputs. Set internally — callers never set it.
   */
  documentScope?: object;
  /**
   * Custom items the nodes being hydrated may emit (spec 34): the enclosing document's
   * root scope. Threaded by `hydrateWorkflow` and the subflow hydrator.
   */
  customItems?: CustomItemMap;
  /**
   * The connections the enclosing document declares (spec 35 § JSON workflows).
   * Threaded by `hydrateWorkflow`; a node naming a connection outside it fails
   * with `CONNECTION_UNKNOWN`. Without a manifest, names pass to the registry as they are.
   */
  connections?: ConnectionManifestEntries;
  /** What the document uses of each connection, for negotiation and gate 1. Threaded by `hydrateWorkflow`. */
  connectionUses?: ConnectionUses;
  /**
   * The connection an operation written by name, or a node without
   * `connection`, runs on: a `verify` subject or a `wait`'s connection. Without
   * one, the document's only connection.
   */
  enclosingConnection?: WorkflowConnectionRef;
  /** The connection name `$item` holds on a fan-out path (an `inParallel` whose `over` lists connections). */
  fanOutItem?: string;
}

type NodeHydrator = (
  node: WorkflowNode,
  ctx: HydrationContext,
) => Step<ContextData, string, string>;

//#endregion

//#region Constants

const DEFAULT_MAX_RECURSION_DEPTH = 100;

//#endregion

//#region Until Predicate Hydration

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

//#endregion

//#region Node Hydrators

/**
 * Resolve an llm node's `tools` entries into a combined client+server list.
 *
 * Every entry is `{ type, parameters? }`. A reserved `openrouter:*` literal is
 * a SERVER tool (flows through unchanged); any other `type` is a CLIENT tool
 * whose `type` is the registered tool NAME (resolved from the registry). Both
 * kinds combine into one `tools` array; the interpreter partitions them again
 * at execution.
 */
function resolveCallModelTools(
  entries: CallModelWorkflowNode['tools'],
  registry: ReadonlyMap<string, Tool>,
): (Tool | ServerToolSpec)[] {
  const toolNames: string[] = [];
  const serverSpecs: ServerToolSpec[] = [];
  for (const entry of entries ?? []) {
    if (isServerToolSpec(entry)) {
      serverSpecs.push(entry);
    } else {
      toolNames.push(entry.type);
    }
  }
  return [
    ...resolveTools(toolNames, registry),
    ...serverSpecs,
  ];
}

function hydrateCallModelNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'callModel') {
    return frameworkCast(undefined);
  }

  const combined = resolveCallModelTools(node.tools, ctx.tools);

  return callModel({
    id: node.id,
    model: node.model ?? 'openai/gpt-4o',
    instructions: node.instructions,
    tools: combined.length > 0 ? combined : undefined,
    toolChoice: node.toolChoice,
    params: node.params,
    output: resolveOutputCodec(node.output, node.id, ctx),
  });
}

/**
 * Resolve a `callModel` node's `output` codec reference to a live `OutputCodec`.
 *
 * Hydrated steps are typed `<string, string>` (the JSON boundary erases output
 * types), so the resolved codec is cast to the step's erased output type — the
 * runtime still returns the codec's real value. This is the same erasure the
 * rest of the hydrator applies via `frameworkCast`.
 */
/** A complete sentence naming what is registered, for a hint. */
function registeredSentence(noun: string, names: Iterable<string>): string {
  const list = [
    ...names,
  ];
  if (list.length === 0) {
    return `No ${noun} are registered.`;
  }
  return `Registered ${noun}: ${list.join(', ')}.`;
}

function resolveOutputCodec(
  ref: OutputCodecRef | undefined,
  nodeId: string,
  ctx: HydrationContext,
): OutputCodec<string> | undefined {
  if (!ref) {
    return undefined;
  }
  const codec = ctx.uiLibraries?.get(ref.library);
  if (codec) {
    return frameworkCast<OutputCodec<string>>(codec);
  }
  throw new NoeticConfigError({
    code: 'UNKNOWN_UI_LIBRARY_REFERENCE',
    message: `UI library '${ref.library}' referenced in workflow node '${nodeId}' is not registered.`,
    hint: `Pass output codecs via HydrationContext.uiLibraries, e.g. new Map([['${ref.library}', openUi(myLibrary)]]) from @noetic-tools/openui. ${registeredSentence('UI libraries', ctx.uiLibraries?.keys() ?? [])}`,
  });
}

function hydrateInvokeToolNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'invokeTool') {
    return frameworkCast(undefined);
  }

  const resolved = ctx.tools.get(node.toolName);
  if (!resolved) {
    throw new NoeticConfigError({
      code: 'UNKNOWN_TOOL_REFERENCE',
      message: `Tool '${node.toolName}' referenced in workflow node '${node.id}' is not registered.`,
      hint: `Register '${node.toolName}' in HydrationContext.tools before hydrating. ${registeredSentence('tools', ctx.tools.keys())}`,
    });
  }

  return frameworkCast(
    runCode({
      id: node.id,
      execute: async (_input: string, execCtx: Context) => {
        const args = node.args ?? {};
        const callId = `call-${node.id}-${Date.now()}`;
        const callItem = {
          id: callId,
          type: 'function_call' as const,
          status: 'completed' as const,
          name: node.toolName,
          callId,
          arguments: JSON.stringify(args),
        };
        execCtx.itemLog.append(callItem);
        const layerState: ToolContext = {
          get: <T>(_layerId: string): T | undefined => undefined,
          set: <T>(_layerId: string, _state: T): void => {},
        };
        const toolCtx: ToolExecutionContext = {
          ctx: execCtx,
          harness: execCtx.harness,
          fs: execCtx.fs,
          shell: execCtx.shell,
          context: layerState,
          assembledView: execCtx.itemLog.items,
          lastStepMeta: execCtx.lastStepMeta,
        };
        const result = await resolved.execute(args, toolCtx);
        return outputText(result);
      },
    }),
  );
}

function hydrateRunCodeNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'runCode') {
    return frameworkCast(undefined);
  }
  const code = node.execute;
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

function hydrateComputeNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'compute') {
    return frameworkCast(undefined);
  }
  const expr = compileExpression(node.expr, `compute node '${node.id}'`, ctx.expressionLimits);
  return frameworkCast(
    runCode({
      id: node.id,
      execute: async (input: string, execCtx: Context) =>
        outputText(await compute(expr, readInput(input), bindingsFor(execCtx, ctx))),
    }),
  );
}

function hydrateConditionalNode(
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

function hydrateDecideNode(
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

function hydrateRouteSwitchNode(
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

function hydrateInParallelNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'inParallel') {
    return frameworkCast(undefined);
  }

  // Static inParallel: paths are known at hydration time and feed the optimizer.
  // Dynamic inParallel (`each`): paths are produced per inParallel-input at runtime, one
  // child per array item, so they cannot be pre-computed or optimized.
  const dynamic = node.each !== undefined;
  const eachTemplate = node.each;
  if (Array.isArray(node.over)) {
    for (const name of node.over) {
      checkManifestName(name, `over of inParallel node '${node.id}'`, ctx);
    }
  }
  const staticPaths = dynamic ? [] : (node.paths ?? []).map((p) => hydrateNode(p, ctx));

  const pathsFactory = (input: string): Step<ContextData, string, string>[] => {
    if (!dynamic || !eachTemplate) {
      return staticPaths;
    }
    if (Array.isArray(node.over)) {
      return node.over.map((name, i) =>
        buildConnectionPathStep({
          forkId: node.id,
          eachTemplate,
          name,
          index: i,
          ctx,
        }),
      );
    }
    const items = selectArray(input, node.over, node.id);
    return items.map((item, i) =>
      buildPerItemStep({
        forkId: node.id,
        eachTemplate,
        item,
        index: i,
        ctx,
      }),
    );
  };
  const optimizable = dynamic ? undefined : frameworkCast<Step<ContextData>[]>(staticPaths);

  if (node.mode === 'race') {
    return inParallel({
      id: node.id,
      mode: 'race',
      paths: pathsFactory,
      concurrency: node.concurrency,
      _optimizable: optimizable,
    });
  }

  const mergeFn = buildMerge(node.merge ?? 'last');

  if (node.mode === 'settle') {
    return inParallel({
      id: node.id,
      mode: 'settle',
      paths: pathsFactory,
      merge: (results) => {
        const values = results.filter((r) => r.status === 'fulfilled').map((r) => r.value ?? '');
        return mergeFn(values);
      },
      concurrency: node.concurrency,
      _optimizable: optimizable,
    });
  }

  return inParallel({
    id: node.id,
    mode: 'all',
    paths: pathsFactory,
    merge: mergeFn,
    concurrency: node.concurrency,
    _optimizable: optimizable,
  });
}

/**
 * Resolves layer names declared on a `withContext` / `spawn` node against the
 * registry on `HydrationContext.layers`. Returns `[]` when no registry was
 * supplied — the host runs with its harness-default layers in that case.
 */
function resolveNamedLayers({
  names,
  nodeKind,
  nodeId,
  ctx,
}: {
  names: ReadonlyArray<string>;
  nodeKind: string;
  nodeId: string;
  ctx: HydrationContext;
}): ContextLayer[] {
  if (!ctx.layers) {
    return [];
  }
  return names.map((name) => {
    const layer = ctx.layers?.get(name);
    if (!layer) {
      throw new NoeticConfigError({
        code: 'UNKNOWN_LAYER_REFERENCE',
        message: `Context layer '${name}' referenced in ${nodeKind} node '${nodeId}' is not registered.`,
        hint: `Available layers: ${
          [
            ...(ctx.layers?.keys() ?? []),
          ].join(', ') || '(none)'
        }. Pass named layers via HydrationContext.layers.`,
      });
    }
    return layer;
  });
}

function hydrateSpawnNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'spawn') {
    return frameworkCast(undefined);
  }
  // `context` is left undefined when the node names no layers so the child
  // inherits the parent's layers (spec 04). An explicit list replaces them.
  const resolvedLayers = node.layers
    ? resolveNamedLayers({
        names: node.layers,
        nodeKind: 'spawn',
        nodeId: node.id,
        ctx,
      })
    : undefined;
  return spawn({
    id: node.id,
    child: hydrateNode(node.child, ctx),
    timeout: node.timeout,
    context: resolvedLayers,
    steers: node.steers,
  });
}

function hydrateWithContextNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'withContext') {
    return frameworkCast(undefined);
  }
  return withContext({
    id: node.id,
    child: hydrateNode(node.child, ctx),
    context: resolveNamedLayers({
      names: node.layers,
      nodeKind: 'withContext',
      nodeId: node.id,
      ctx,
    }),
  });
}

function hydrateLoopNode(
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

function hydrateSequenceNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'sequence') {
    return frameworkCast(undefined);
  }

  const children = node.steps.map((s, i) =>
    hydrateNode(stepEntryToNode(s, shorthandStepId(node.id, i)), ctx),
  );

  return frameworkCast(
    runCode({
      id: node.id,
      execute: async (input: string, execCtx: Context) => {
        let current: unknown = input;
        for (const child of children) {
          const childInput = outputText(current);
          current = await ctx.executeStep(child, childInput, execCtx);
        }
        return outputText(current);
      },
    }),
  );
}

function hydrateScheduleNode(
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

function hydrateAcpAgentNode(
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
  return step.acpAgent({
    id: node.id,
    agent,
    prompt: node.prompt,
    cwd: node.cwd,
    mode: node.mode,
    model: node.model,
    mcpServers: node.mcpServers,
    permissions: node.permissions,
    clientCapabilities: node.clientCapabilities,
    session: node.session,
  });
}

/**
 * Hydrates a `subflow` node lazily: the target document resolves and hydrates
 * on first execution, memoized. Lazy because `HydrationContext.workflows` may
 * be a live view that gains entries after hydration, and because a recursive
 * ref must hydrate only the levels execution reaches — eager hydration of
 * A→A would never end. Each level gets its own tree whose ids carry the
 * calling node's (already suffixed) id, so levels never share step ids.
 */
function hydrateSubflowNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'subflow') {
    return frameworkCast(undefined);
  }
  let cached: Step<ContextData, string, string> | undefined;
  const resolve = (): Step<ContextData, string, string> => {
    if (!cached) {
      const { doc, childCtx } = resolveSubflowDocument(node, ctx);
      cached = hydrateNode(suffixNodeIds(doc.root, `-${node.id}`), {
        ...childCtx,
        customItems: documentScope(doc, ctx.customItems),
      });
    }
    return cached;
  };
  return frameworkCast(
    runCode({
      id: node.id,
      execute: async (input: string, execCtx: Context) => {
        const child = resolve();
        return outputText(await ctx.executeStep(child, node.input ?? input, execCtx));
      },
    }),
  );
}

function resolveSubflowDocument(
  node: SubflowWorkflowNode,
  ctx: HydrationContext,
): {
  doc: WorkflowDocument;
  childCtx: HydrationContext;
} {
  if (node.document) {
    // Inline documents are finite JSON trees — they cannot recurse, so they
    // add nothing to the recursion depth.
    return {
      doc: node.document,
      childCtx: ctx,
    };
  }
  const ref = node.ref ?? '';
  const depth = (ctx.recursionDepth ?? 0) + 1;
  const limit = maxRecursionDepth(ctx);
  if (depth > limit) {
    throw new NoeticConfigError({
      code: 'WORKFLOW_RECURSION_LIMIT',
      message: `Sub-workflow '${ref}' referenced in subflow node '${node.id}' would resolve at recursion depth ${depth}, past the limit of ${limit}.`,
      hint: 'Give the recursion a base case (e.g. a conditional that stops calling the subflow), or raise maxRecursionDepth.',
    });
  }
  const doc = ctx.workflows?.get(ref);
  if (!doc) {
    throw new NoeticConfigError({
      code: 'UNKNOWN_WORKFLOW_REFERENCE',
      message: `Sub-workflow '${ref}' referenced in subflow node '${node.id}' is not registered.`,
      hint: `Pass named workflows via HydrationContext.workflows. Available: ${
        [
          ...(ctx.workflows?.keys() ?? []),
        ].join(', ') || '(none)'
      }.`,
    });
  }
  return {
    doc,
    childCtx: {
      ...ctx,
      recursionDepth: depth,
    },
  };
}

/** Nodes hydrated outside any `hydrateWorkflow` (a bare `hydrateNode`) share one scope. */
const BARE_DOCUMENT_SCOPE: object = {};

/** The `$steps` scope of the document `ctx` is hydrating. */
export function documentScopeOf(ctx: HydrationContext): object {
  return ctx.documentScope ?? BARE_DOCUMENT_SCOPE;
}

//#region Connection Node Hydrators

/** The bindings an expression evaluated in `execCtx` sees: `$steps`, and `$item` on a fan-out path. */
function bindingsFor(execCtx: Context, ctx: HydrationContext): ExpressionBindings {
  return {
    steps: stepOutputsOf(execCtx, documentScopeOf(ctx)),
    ...(ctx.fanOutItem === undefined
      ? {}
      : {
          item: ctx.fanOutItem,
        }),
  };
}

/**
 * Checks a connection name against the document's manifest, when there is one.
 *
 * @throws `NoeticConfigError` `CONNECTION_UNKNOWN` for a name the manifest does not declare.
 */
function checkManifestName(name: string, where: string, ctx: HydrationContext): void {
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

/**
 * Hydrates a step list (`around`, `act`, a sequence's steps): each entry a node,
 * or an operation written by name that becomes a `call` with id `<parentId>[i]`
 * on `enclosing` (when given).
 *
 * @public
 */
export function hydrateStepList(opts: {
  list: WorkflowStepList;
  parentId: string;
  ctx: HydrationContext;
  enclosing?: WorkflowConnectionRef;
}): Step<ContextData, string, unknown>[] {
  const { list, parentId, ctx, enclosing } = opts;
  const childCtx: HydrationContext =
    enclosing === undefined
      ? ctx
      : {
          ...ctx,
          enclosingConnection: enclosing,
        };
  return stepListEntries(list).map((entry, i) =>
    frameworkCast<Step<ContextData, string, unknown>>(
      hydrateNode(stepEntryToNode(entry, shorthandStepId(parentId, i)), childCtx),
    ),
  );
}

/** Registers a step built here as an object literal, like the builders do. */
function registered<S extends Step<ContextData, string, string>>(built: S): S {
  getDefaultRegistrar().register(frameworkCast<Step>(built));
  return built;
}

function hydrateCallNode(
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

function hydrateWaitNode(
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

//#region Handler Registry

const NODE_HYDRATORS: Record<string, NodeHydrator> = {
  callModel: hydrateCallModelNode,
  invokeTool: hydrateInvokeToolNode,
  runCode: hydrateRunCodeNode,
  compute: hydrateComputeNode,
  conditional: hydrateConditionalNode,
  decide: hydrateDecideNode,
  routeSwitch: hydrateRouteSwitchNode,
  inParallel: hydrateInParallelNode,
  spawn: hydrateSpawnNode,
  withContext: hydrateWithContextNode,
  loop: hydrateLoopNode,
  sequence: hydrateSequenceNode,
  schedule: hydrateScheduleNode,
  subflow: hydrateSubflowNode,
  'acp-agent': hydrateAcpAgentNode,
  call: hydrateCallNode,
  wait: hydrateWaitNode,
  // Owned by the verification slice (spec 37); it hydrates `act` through `hydrateStepList`.
  verify: hydrateVerifyNode,
};

//#endregion

//#region Helpers

/** The context's recursion limit, defaulted; anything but a positive integer or `Infinity` throws. */
function maxRecursionDepth(ctx: HydrationContext): number {
  const limit = ctx.maxRecursionDepth ?? DEFAULT_MAX_RECURSION_DEPTH;
  if (limit === Number.POSITIVE_INFINITY || (Number.isInteger(limit) && limit >= 1)) {
    return limit;
  }
  throw new NoeticConfigError({
    code: 'INVALID_MAX_RECURSION_DEPTH',
    message: `maxRecursionDepth must be a positive integer or Infinity, got ${limit}.`,
    hint: 'Pass a positive integer such as 100 (the default), or Infinity to let named workflows recurse without a limit.',
  });
}

function resolveTools(
  toolNames: string[] | undefined,
  registry: ReadonlyMap<string, Tool>,
): Tool[] {
  if (!toolNames || toolNames.length === 0) {
    return [];
  }
  return toolNames.map((name) => {
    const resolved = registry.get(name);
    if (!resolved) {
      throw new NoeticConfigError({
        code: 'UNKNOWN_TOOL_REFERENCE',
        message: `Tool '${name}' referenced in workflow is not registered.`,
        hint: `Register '${name}' in HydrationContext.tools before hydrating. ${registeredSentence('tools', registry.keys())}`,
      });
    }
    return resolved;
  });
}

/** Paths may return objects (a `decide` node's answers): `concat` writes them as JSON, `first`/`last` pass them through. */
function buildMerge(strategy: 'last' | 'first' | 'concat'): (results: string[]) => string {
  if (strategy === 'first') {
    return (r) => r[0] ?? '';
  }
  if (strategy === 'concat') {
    return (r) => r.map(outputText).join('\n');
  }
  return (r) => r[r.length - 1] ?? '';
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

//#endregion

//#region Dynamic Fork Helpers

/**
 * Parses the inParallel input (a JSON string) and locates the array to fan out over.
 * When `over` is set, reads that property off the parsed object; otherwise the
 * parsed value itself must be an array.
 */
function selectArray(input: string, over: string | undefined, nodeId: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new NoeticConfigError({
      code: 'INVALID_FORK_INPUT',
      message: `Dynamic inParallel '${nodeId}' could not parse its input as JSON.`,
      hint: 'A dynamic inParallel (with `each`) expects its input to be a JSON array (or a JSON object when `over` is set).',
    });
  }
  const candidate =
    over === undefined ? parsed : frameworkCast<Record<string, unknown> | null>(parsed)?.[over];
  if (!Array.isArray(candidate)) {
    throw new NoeticConfigError({
      code: 'INVALID_FORK_INPUT',
      message: `Dynamic inParallel '${nodeId}' did not resolve an array${
        over ? ` at key '${over}'` : ''
      }.`,
      hint: over
        ? `Ensure the input JSON object has an array at '${over}'.`
        : 'Ensure the input is a JSON array, or set `over` to select an array property.',
    });
  }
  return candidate;
}

/**
 * Builds one inParallel path for a single dynamic fan-out item. The item is injected as
 * the body's input (inParallel steps pass the same input to every path), and the
 * template's node ids are suffixed with `-${i}` so each instantiation has
 * unique ids for tracing and step-registry uniqueness.
 */
function buildPerItemStep(opts: {
  forkId: string;
  eachTemplate: WorkflowNode;
  item: unknown;
  index: number;
  ctx: HydrationContext;
}): Step<ContextData, string, string> {
  const { forkId, eachTemplate, item, index, ctx } = opts;
  const hydratedEach = hydrateNode(suffixNodeIds(eachTemplate, `-${index}`), ctx);
  return frameworkCast(
    runCode({
      id: `${forkId}-item-${index}`,
      execute: async (_input: string, execCtx: Context) => {
        const itemInput = JSON.stringify(item);
        return outputText(await ctx.executeStep(hydratedEach, itemInput, execCtx));
      },
    }),
  );
}

/**
 * Builds one path of a connection fan-out (`over` a list of connection names):
 * the template hydrates with `$item` bound to the name, ids suffixed `-<i>`, and
 * runs on the fork's own input.
 */
function buildConnectionPathStep(opts: {
  forkId: string;
  eachTemplate: WorkflowNode;
  name: string;
  index: number;
  ctx: HydrationContext;
}): Step<ContextData, string, string> {
  const { forkId, eachTemplate, name, index, ctx } = opts;
  const hydratedEach = hydrateNode(suffixNodeIds(eachTemplate, `-${index}`), {
    ...ctx,
    fanOutItem: name,
  });
  return frameworkCast(
    runCode({
      id: `${forkId}-item-${index}`,
      execute: async (input: string, execCtx: Context) =>
        outputText(await ctx.executeStep(hydratedEach, input, execCtx)),
    }),
  );
}

/** Keys whose values are opaque data bags, never child workflow nodes. */
const NON_NODE_KEYS = new Set([
  'args',
  'params',
  'parameters',
]);

/**
 * Deep-clones a workflow node template, appending `suffix` to the `id` of every
 * nested node so a per-item instantiation has globally-unique step ids.
 */
function suffixNodeIds(node: WorkflowNode, suffix: string): WorkflowNode {
  const clone = structuredClone(node);
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') {
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        walk(entry);
      }
      return;
    }
    const record = frameworkCast<Record<string, unknown>>(value);
    if (typeof record.kind === 'string' && typeof record.id === 'string') {
      record.id = `${record.id}${suffix}`;
    }
    for (const [key, child] of Object.entries(record)) {
      if (NON_NODE_KEYS.has(key)) {
        continue;
      }
      walk(child);
    }
  };
  walk(clone);
  return clone;
}

//#endregion

//#region Run Node Helpers

/**
 * Resolves the subprocess adapter for a `runCode` node. When the node names an
 * adapter ref, the host must supply a `resolveSubprocess` resolver; otherwise
 * the step falls back to the harness adapter on the execution context.
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
  if (!resolved) {
    throw new NoeticConfigError({
      code: 'UNKNOWN_SUBPROCESS_REFERENCE',
      message: `Subprocess adapter '${ref}' referenced in run node '${nodeId}' could not be resolved.`,
      hint: 'Pass a `resolveSubprocess(ref)` mapping in the HydrationContext, or omit `subprocess` to use the harness default (ctx.subprocess).',
    });
  }
  return resolved;
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

//#region Public API

/**
 * Hydrates a single `WorkflowNode` into a live `Step`.
 *
 * @public
 * @param node - Validated workflow node.
 * @param ctx - Hydration context with tool registry and step executor.
 * @returns A live `Step` ready for execution.
 * @throws `NoeticConfigError` with code `UNKNOWN_NODE_KIND` if the node kind is unrecognised.
 * @throws `NoeticConfigError` with code `UNKNOWN_TOOL_REFERENCE` if a tool name cannot be resolved.
 * @throws `NoeticConfigError` with code `UNKNOWN_UNTIL_PREDICATE` if an until predicate kind is unrecognised.
 * @throws `NoeticConfigError` with code `INVALID_UNTIL_DECIDER` if a decide until predicate does not ask exactly one boolean question.
 * @throws `NoeticConfigError` with code `UNKNOWN_WORKFLOW_REFERENCE` (at execution time) if a subflow ref names no registered workflow.
 * @throws `NoeticConfigError` with code `WORKFLOW_RECURSION_LIMIT` (at execution time) if named sub-workflow refs nest deeper than `maxRecursionDepth`.
 * @throws `NoeticConfigError` with code `INVALID_MAX_RECURSION_DEPTH` (at execution time) when a named ref resolves under a `maxRecursionDepth` that is not a positive integer or `Infinity`.
 * @throws `NoeticConfigError` with code `WORKFLOW_VALIDATION_FAILED` if a `compute` expression, a conditional route's `expr`, an `expr` until predicate, or an `emitItems` expression does not parse.
 * @throws `NoeticConfigError` with code `INVALID_EXPRESSION_LIMITS` if an expression compiles under `expressionLimits` holding a value that is not a positive integer or `Infinity`.
 * @throws `NoeticConfigError` with code `EXPRESSION_FAILED` or `EXPRESSION_LIMIT_EXCEEDED` (at execution time) if an expression fails or exceeds its limits.
 */
export function hydrateNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  const hydrator = NODE_HYDRATORS[node.kind];
  if (!hydrator) {
    throw new NoeticConfigError({
      code: 'UNKNOWN_NODE_KIND',
      message: `Unknown workflow node kind: '${node.kind}'.`,
      hint: `Supported kinds: ${Object.keys(NODE_HYDRATORS).join(', ')}.`,
    });
  }
  const hydrated = hydrator(node, ctx);
  // Its output becomes `$steps.<id>` for later expressions of its document once it completes.
  markRecorded(hydrated, documentScopeOf(ctx));
  // Set in place rather than copied: builders register the step object itself.
  if (node.durable !== undefined) {
    hydrated.durable = node.durable;
  }
  if (node.replayKey !== undefined) {
    hydrated.replayKey = workflowReplayKey(node.id, node.replayKey);
  }
  const scope = nodeScope(node, ctx.customItems);
  if (Object.keys(scope).length > 0) {
    hydrated.customItems = scope;
  }
  if (node.emitItems !== undefined) {
    hydrated.emitItems = hydrateEmitItems({
      nodeId: node.id,
      option: node.emitItems,
      scope,
      limits: ctx.expressionLimits,
    });
  }
  return hydrated;
}

/**
 * Hydrates a complete `WorkflowDocument` into a live `Step` tree.
 *
 * @public
 * @param doc - Validated workflow document (version 1).
 * @param ctx - Hydration context with tool registry and step executor.
 * @param customItems - TypeScript declarations of the document's root custom items (spec 34).
 * @returns The root `Step` of the hydrated workflow.
 * @throws `NoeticConfigError` with code `CUSTOM_ITEM_MISMATCH` when `customItems` and the document give one name different types.
 * @throws `NoeticConfigError` with code `CONNECTION_UNKNOWN` when a node uses a connection the document's `connections` do not declare, or `CONNECTION_INVALID` when a node's connection is neither named nor implied, or a source entry is used beyond its events.
 */
export function hydrateWorkflow(
  doc: WorkflowDocument,
  ctx: HydrationContext,
  customItems?: CustomItemMap,
): Step<ContextData, string, string> {
  const connectionUses = checkDocumentConnections(doc);
  const root = hydrateNode(doc.root, {
    ...ctx,
    documentScope: {},
    customItems: documentScope(doc, ctx.customItems, customItems),
    connections: doc.connections ?? {},
    connectionUses,
  });
  // The root's dispatch accepts every item the document declares before anything
  // runs or replays; keyed by type, they cannot shadow the root's own names.
  root.customItems = {
    ...everyDocumentItem(doc),
    ...root.customItems,
  };
  return root;
}

//#endregion
