/**
 * Converts a validated `WorkflowDocument` into a live `Step` tree.
 *
 * Each node kind maps to the corresponding builder (`callModel`, `inParallel`,
 * `loop`, etc.) so hydrated steps are indistinguishable from programmatic
 * ones — they register in the step registry, carry retry policies, etc.
 */

import type { ContextData, ContextLayer } from '@noetic-tools/context';
import type {
  Context,
  ExecuteStepFn,
  OutputCodec,
  ProcessSubprocessRequest,
  ServerToolSpec,
  Step,
  SubHarness,
  SubHarnessKind,
  SubHarnessSessionPolicy,
  SubHarnessSettings,
  SubprocessAdapter,
  Tool,
  ToolContext,
  ToolExecutionContext,
  Until,
} from '@noetic-tools/types';
import { frameworkCast, isServerToolSpec, NoeticConfigError } from '@noetic-tools/types';
import type {
  CallModelWorkflowNode,
  OutputCodecRef,
  SubflowWorkflowNode,
  UntilPredicate,
  WorkflowDocument,
  WorkflowNode,
} from '../schemas/workflow';
import { all, any } from '../until/combinators';
import { until } from '../until/predicates';
import { DetachedHandleImpl } from '../util/detached-handle';

import { conditional, inParallel } from './control-flow-builders';
import { schedule } from './every';
import { loop } from './loop-builder';
import { withContext } from './provide-builder';
import { spawn } from './spawn-builder';
import { callModel, runCode, step } from './step-builders';

//#region Types

/** @public Context required to hydrate a JSON workflow into live steps. */
export interface HydrationContext {
  tools: ReadonlyMap<string, Tool>;
  executeStep: ExecuteStepFn;
  layers?: ReadonlyMap<string, ContextLayer>;
  /** SubHarness adapters keyed by harness id, resolving `claude-code`/`codex`/… nodes. */
  subHarnesses?: ReadonlyMap<SubHarnessKind, SubHarness>;
  /**
   * Output codecs keyed by the `library` ref a `callModel` node's `output` codec
   * reference names — the live codec built from a component library, e.g.
   * `new Map([['dashboard-lib', openUi(dashboardLibrary)]])` from
   * `@noetic-tools/openui`. Resolved the same way sub-harness adapters are.
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
   * Ancestor ref chain for cycle detection on named sub-workflow references.
   * Threaded internally by the subflow hydrator — callers never set it.
   */
  subflowAncestry?: ReadonlySet<string>;
}

interface SubHarnessBuilderOpts {
  id: string;
  harness: SubHarness;
  prompt: string;
  instructions?: string;
  settings?: SubHarnessSettings;
  session?: SubHarnessSessionPolicy;
}

type SubHarnessStepBuilder = (opts: SubHarnessBuilderOpts) => Step<ContextData, string, string>;

type NodeHydrator = (
  node: WorkflowNode,
  ctx: HydrationContext,
) => Step<ContextData, string, string>;

//#endregion

//#region Until Predicate Hydration

function hydrateUntilPredicate(pred: UntilPredicate): Until {
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
    case 'any':
      return any(...pred.predicates.map(hydrateUntilPredicate));
    case 'all':
      return all(...pred.predicates.map(hydrateUntilPredicate));
    default:
      throw new NoeticConfigError({
        code: 'UNKNOWN_UNTIL_PREDICATE',
        message: `Unknown until predicate kind: '${frameworkCast<UntilPredicate>(pred).kind}'.`,
        hint: 'Supported kinds: maxSteps, maxCost, maxDuration, noToolCalls, never, outputContains, outputEquals, converged, any, all.',
      });
  }
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
function availableLibraries(ctx: HydrationContext): string {
  if (!ctx.uiLibraries || ctx.uiLibraries.size === 0) {
    return '(none)';
  }
  return [
    ...ctx.uiLibraries.keys(),
  ].join(', ');
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
    hint: `Pass output codecs via HydrationContext.uiLibraries, e.g. new Map([['${ref.library}', openUi(myLibrary)]]) from @noetic-tools/openui. Available: ${availableLibraries(ctx)}`,
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
      hint: `Available tools: ${
        [
          ...ctx.tools.keys(),
        ].join(', ') || '(none)'
      }`,
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
        return stringifyResult(result);
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
          input: stringifyResult(input),
        });
      },
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

  const hydratedRoutes = node.routes.map((r) => ({
    match: r.match,
    target: hydrateNode(r.target, ctx),
  }));
  const defaultTarget = node.default ? hydrateNode(node.default, ctx) : null;

  const allTargets = hydratedRoutes.map((r) => r.target);
  if (defaultTarget) {
    allTargets.push(defaultTarget);
  }

  return conditional({
    id: node.id,
    route: (input: string) => {
      const trimmed = input.trim().toLowerCase();
      for (const r of hydratedRoutes) {
        if (trimmed.includes(r.match.toLowerCase())) {
          return r.target;
        }
      }
      return defaultTarget;
    },
    _optimizable: frameworkCast(allTargets),
  });
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
  const staticPaths = dynamic ? [] : (node.paths ?? []).map((p) => hydrateNode(p, ctx));

  const pathsFactory = (input: string): Step<ContextData, string, string>[] => {
    if (!dynamic || !eachTemplate) {
      return staticPaths;
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
    until: hydrateUntilPredicate(node.until),
    maxIterations: node.maxIterations,
  });
}

function hydrateSequenceNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'sequence') {
    return frameworkCast(undefined);
  }

  const children = node.steps.map((s) => hydrateNode(s, ctx));

  return frameworkCast(
    runCode({
      id: node.id,
      execute: async (input: string, execCtx: Context) => {
        let current: unknown = input;
        for (const child of children) {
          const childInput = stringifyResult(current);
          current = await ctx.executeStep(child, childInput, execCtx);
        }
        return stringifyResult(current);
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

const SUB_HARNESS_BUILDERS: Record<SubHarnessKind, SubHarnessStepBuilder> = {
  'claude-code': (opts) => step.claudeCode(opts),
  codex: (opts) => step.codex(opts),
  opencode: (opts) => step.opencode(opts),
  pi: (opts) => step.pi(opts),
};

function hydrateSubHarnessNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (
    node.kind !== 'claude-code' &&
    node.kind !== 'codex' &&
    node.kind !== 'opencode' &&
    node.kind !== 'pi'
  ) {
    return frameworkCast(undefined);
  }
  const harness = ctx.subHarnesses?.get(node.kind);
  if (!harness) {
    throw new NoeticConfigError({
      code: 'UNKNOWN_SUB_HARNESS_REFERENCE',
      message: `SubHarness '${node.kind}' referenced in workflow node '${node.id}' is not registered.`,
      hint: `Pass harness adapters via HydrationContext.subHarnesses, e.g. new Map([['${node.kind}', ${node.kind.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}({ model })]]).`,
    });
  }
  return SUB_HARNESS_BUILDERS[node.kind]({
    id: node.id,
    harness,
    prompt: node.prompt,
    instructions: node.instructions,
    settings: node.settings,
    session: node.session,
  });
}

/**
 * Hydrates a `subflow` node lazily: the target document resolves and hydrates
 * on first execution, memoized. Lazy because `HydrationContext.workflows` may
 * be a live view that gains entries after hydration, and because it keeps
 * cycle detection path-scoped — each ref chain threads its own ancestry set,
 * so diamond reuse of a named workflow is legal while A→B→A throws.
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
      cached = hydrateNode(suffixNodeIds(doc.root, `-${node.id}`), childCtx);
    }
    return cached;
  };
  return frameworkCast(
    runCode({
      id: node.id,
      execute: async (input: string, execCtx: Context) => {
        const child = resolve();
        return stringifyResult(await ctx.executeStep(child, node.input ?? input, execCtx));
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
    // Inline documents are finite JSON trees — they cannot cycle, so they
    // add nothing to the ancestry chain.
    return {
      doc: node.document,
      childCtx: ctx,
    };
  }
  const ref = node.ref ?? '';
  const ancestry = ctx.subflowAncestry ?? new Set<string>();
  if (ancestry.has(ref)) {
    throw new NoeticConfigError({
      code: 'WORKFLOW_CYCLE',
      message: `Sub-workflow '${ref}' referenced in subflow node '${node.id}' forms a reference cycle (${[
        ...ancestry,
        ref,
      ].join(' -> ')}).`,
      hint: 'A named sub-workflow may not reference itself, directly or transitively. Break the cycle or inline the document.',
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
      subflowAncestry: new Set([
        ...ancestry,
        ref,
      ]),
    },
  };
}

//#endregion

//#region Handler Registry

const NODE_HYDRATORS: Record<string, NodeHydrator> = {
  callModel: hydrateCallModelNode,
  invokeTool: hydrateInvokeToolNode,
  runCode: hydrateRunCodeNode,
  conditional: hydrateConditionalNode,
  inParallel: hydrateInParallelNode,
  spawn: hydrateSpawnNode,
  withContext: hydrateWithContextNode,
  loop: hydrateLoopNode,
  sequence: hydrateSequenceNode,
  schedule: hydrateScheduleNode,
  subflow: hydrateSubflowNode,
  'claude-code': hydrateSubHarnessNode,
  codex: hydrateSubHarnessNode,
  opencode: hydrateSubHarnessNode,
  pi: hydrateSubHarnessNode,
};

//#endregion

//#region Helpers

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
        hint: `Available tools: ${
          [
            ...registry.keys(),
          ].join(', ') || '(none)'
        }`,
      });
    }
    return resolved;
  });
}

function buildMerge(strategy: 'last' | 'first' | 'concat'): (results: string[]) => string {
  if (strategy === 'first') {
    return (r) => r[0] ?? '';
  }
  if (strategy === 'concat') {
    return (r) => r.join('\n');
  }
  return (r) => r[r.length - 1] ?? '';
}

function stringifyResult(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  return JSON.stringify(value);
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
        return stringifyResult(await ctx.executeStep(hydratedEach, itemInput, execCtx));
      },
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
  const spawnPromise = adapter.spawn(request);
  const handle = new DetachedHandleImpl<string>({
    id: `run-${nodeId}`,
    stepId: nodeId,
    adapter,
    spawnPromise,
  });
  const result = await handle.await();
  return stringifyResult(result);
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
 * @throws `NoeticConfigError` with code `UNKNOWN_WORKFLOW_REFERENCE` (at execution time) if a subflow ref names no registered workflow.
 * @throws `NoeticConfigError` with code `WORKFLOW_CYCLE` (at execution time) if named sub-workflow refs form a cycle.
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
  return hydrator(node, ctx);
}

/**
 * Hydrates a complete `WorkflowDocument` into a live `Step` tree.
 *
 * @public
 * @param doc - Validated workflow document (version 1).
 * @param ctx - Hydration context with tool registry and step executor.
 * @returns The root `Step` of the hydrated workflow.
 */
export function hydrateWorkflow(
  doc: WorkflowDocument,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  return hydrateNode(doc.root, ctx);
}

//#endregion
