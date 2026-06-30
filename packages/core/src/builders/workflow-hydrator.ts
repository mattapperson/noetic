/**
 * Converts a validated `WorkflowDocument` into a live `Step` tree.
 *
 * Each node kind maps to the corresponding builder (`step.llm`, `fork`,
 * `loop`, etc.) so hydrated steps are indistinguishable from programmatic
 * ones — they register in the step registry, carry retry policies, etc.
 */

import type { ContextMemory, MemoryLayer } from '@noetic-tools/memory';
import type {
  Context,
  ExecuteStepFn,
  ProcessSubprocessRequest,
  ServerToolSpec,
  Step,
  SubHarness,
  SubHarnessKind,
  SubHarnessSessionPolicy,
  SubHarnessSettings,
  SubprocessAdapter,
  Tool,
  Until,
} from '@noetic-tools/types';
import { frameworkCast, isServerToolSpec, NoeticConfigError } from '@noetic-tools/types';
import { DetachedHandleImpl } from '../runtime/detached-handle';
import type { UntilPredicate, WorkflowDocument, WorkflowNode } from '../schemas/workflow';
import { all, any } from '../until/combinators';
import { until } from '../until/predicates';

import { branch, fork } from './control-flow-builders';
import { every } from './every';
import { loop } from './loop-builder';
import { provide } from './provide-builder';
import { spawn } from './spawn-builder';
import { step } from './step-builders';

//#region Types

/** @public Context required to hydrate a JSON workflow into live steps. */
export interface HydrationContext {
  tools: ReadonlyMap<string, Tool>;
  executeStep: ExecuteStepFn;
  layers?: ReadonlyMap<string, MemoryLayer>;
  /** SubHarness adapters keyed by harness id, resolving `claude-code`/`codex`/… nodes. */
  subHarnesses?: ReadonlyMap<SubHarnessKind, SubHarness>;
  /**
   * Resolves a named subprocess adapter ref declared on a `run` node's
   * `subprocess` field. When a node omits the ref, the step falls back to
   * `ctx.subprocess` at execution time.
   */
  resolveSubprocess?: (ref: string) => SubprocessAdapter | undefined;
}

interface SubHarnessBuilderOpts {
  id: string;
  harness: SubHarness;
  prompt: string;
  instructions?: string;
  settings?: SubHarnessSettings;
  session?: SubHarnessSessionPolicy;
}

type SubHarnessStepBuilder = (opts: SubHarnessBuilderOpts) => Step<ContextMemory, string, string>;

type NodeHydrator = (
  node: WorkflowNode,
  ctx: HydrationContext,
) => Step<ContextMemory, string, string>;

//#endregion

//#region Until Predicate Hydration

function hydrateUntilPredicate(pred: UntilPredicate): Until {
  switch (pred.kind) {
    case 'maxSteps':
      return until.maxSteps(pred.n);
    case 'maxCost':
      return until.maxCost(pred.usd);
    case 'maxDuration':
      return until.maxDuration(pred.ms);
    case 'noToolCalls':
      return until.noToolCalls();
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
        hint: 'Supported kinds: maxSteps, maxCost, maxDuration, noToolCalls, outputContains, outputEquals, converged, any, all.',
      });
  }
}

//#endregion

//#region Node Hydrators

function hydrateLlmNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextMemory, string, string> {
  if (node.kind !== 'llm') {
    return frameworkCast(undefined);
  }

  // Every `tools` entry is an object `{ type, parameters? }`. Partition by the
  // `type` value: a reserved `openrouter:*` server-tool literal is a SERVER
  // tool (flows through unchanged); any other `type` is a CLIENT tool whose
  // `type` is the registered tool NAME (resolved from the registry; a client
  // entry's `parameters` is ignored). Both kinds are combined back into one
  // `tools` array; the interpreter partitions them again at execution (server
  // specs bypass the client-tool machinery and reach the model call's
  // server-tool channel).
  const toolNames: string[] = [];
  const serverSpecs: ServerToolSpec[] = [];
  for (const entry of node.tools ?? []) {
    if (isServerToolSpec(entry)) {
      serverSpecs.push(entry);
    } else {
      toolNames.push(entry.type);
    }
  }
  const resolvedTools = resolveTools(toolNames, ctx.tools);
  const combined: (Tool | ServerToolSpec)[] = [
    ...resolvedTools,
    ...serverSpecs,
  ];

  return step.llm({
    id: node.id,
    model: node.model ?? 'openai/gpt-4o',
    instructions: node.instructions,
    tools: combined.length > 0 ? combined : undefined,
    params: node.params,
  });
}

function hydrateToolNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextMemory, string, string> {
  if (node.kind !== 'tool') {
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
    step.run({
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
        const toolCtx = {
          ctx: execCtx,
          harness: execCtx.harness,
          fs: execCtx.fs,
          shell: execCtx.shell,
          memory: {
            get: <T>(_layerId: string): T | undefined => undefined,
            set: <T>(_layerId: string, _state: T): void => {},
          },
          assembledView: execCtx.itemLog.items,
          lastStepMeta: execCtx.lastStepMeta,
        };
        const result = await resolved.execute(args, toolCtx);
        return stringifyResult(result);
      },
    }),
  );
}

function hydrateRunNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextMemory, string, string> {
  if (node.kind !== 'run') {
    return frameworkCast(undefined);
  }
  const code = node.execute;
  const subprocessRef = node.subprocess;
  return frameworkCast(
    step.run({
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

function hydrateBranchNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextMemory, string, string> {
  if (node.kind !== 'branch') {
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

  return branch({
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

function hydrateForkNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextMemory, string, string> {
  if (node.kind !== 'fork') {
    return frameworkCast(undefined);
  }

  // Static fork: paths are known at hydration time and feed the optimizer.
  // Dynamic fork (`each`): paths are produced per fork-input at runtime, one
  // child per array item, so they cannot be pre-computed or optimized.
  const dynamic = node.each !== undefined;
  const eachTemplate = node.each;
  const staticPaths = dynamic ? [] : (node.paths ?? []).map((p) => hydrateNode(p, ctx));

  const pathsFactory = (input: string): Step<ContextMemory, string, string>[] => {
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
  const optimizable = dynamic ? undefined : frameworkCast<Step<ContextMemory>[]>(staticPaths);

  if (node.mode === 'race') {
    return fork({
      id: node.id,
      mode: 'race',
      paths: pathsFactory,
      concurrency: node.concurrency,
      _optimizable: optimizable,
    });
  }

  const mergeFn = buildMerge(node.merge ?? 'last');

  if (node.mode === 'settle') {
    return fork({
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

  return fork({
    id: node.id,
    mode: 'all',
    paths: pathsFactory,
    merge: mergeFn,
    concurrency: node.concurrency,
    _optimizable: optimizable,
  });
}

function hydrateSpawnNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextMemory, string, string> {
  if (node.kind !== 'spawn') {
    return frameworkCast(undefined);
  }
  return spawn({
    id: node.id,
    child: hydrateNode(node.child, ctx),
    timeout: node.timeout,
  });
}

function hydrateProvideNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextMemory, string, string> {
  if (node.kind !== 'provide') {
    return frameworkCast(undefined);
  }
  const resolvedLayers = ctx.layers
    ? node.layers.map((name) => {
        const layer = ctx.layers?.get(name);
        if (!layer) {
          throw new NoeticConfigError({
            code: 'UNKNOWN_LAYER_REFERENCE',
            message: `Memory layer '${name}' referenced in provide node '${node.id}' is not registered.`,
            hint: `Available layers: ${
              [
                ...(ctx.layers?.keys() ?? []),
              ].join(', ') || '(none)'
            }. Pass named layers via HydrationContext.layers.`,
          });
        }
        return layer;
      })
    : [];
  return provide({
    id: node.id,
    child: hydrateNode(node.child, ctx),
    memory: resolvedLayers,
  });
}

function hydrateLoopNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextMemory, string, string> {
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
): Step<ContextMemory, string, string> {
  if (node.kind !== 'sequence') {
    return frameworkCast(undefined);
  }

  const children = node.steps.map((s) => hydrateNode(s, ctx));

  return frameworkCast(
    step.run({
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

function hydrateEveryNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextMemory, string, string> {
  if (node.kind !== 'every') {
    return frameworkCast(undefined);
  }
  return every({
    id: node.id,
    step: hydrateNode(node.step, ctx),
    ms: node.ms,
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
): Step<ContextMemory, string, string> {
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

//#endregion

//#region Handler Registry

const NODE_HYDRATORS: Record<string, NodeHydrator> = {
  llm: hydrateLlmNode,
  tool: hydrateToolNode,
  run: hydrateRunNode,
  branch: hydrateBranchNode,
  fork: hydrateForkNode,
  spawn: hydrateSpawnNode,
  provide: hydrateProvideNode,
  loop: hydrateLoopNode,
  sequence: hydrateSequenceNode,
  every: hydrateEveryNode,
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
 * Parses the fork input (a JSON string) and locates the array to fan out over.
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
      message: `Dynamic fork '${nodeId}' could not parse its input as JSON.`,
      hint: 'A dynamic fork (with `each`) expects its input to be a JSON array (or a JSON object when `over` is set).',
    });
  }
  const candidate =
    over === undefined ? parsed : frameworkCast<Record<string, unknown> | null>(parsed)?.[over];
  if (!Array.isArray(candidate)) {
    throw new NoeticConfigError({
      code: 'INVALID_FORK_INPUT',
      message: `Dynamic fork '${nodeId}' did not resolve an array${
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
 * Builds one fork path for a single dynamic-fork item. The item is injected as
 * the body's input (forks pass the same fork-input to every path), and the
 * template's node ids are suffixed with `-${i}` so each instantiation has
 * unique ids for tracing and step-registry uniqueness.
 */
function buildPerItemStep(opts: {
  forkId: string;
  eachTemplate: WorkflowNode;
  item: unknown;
  index: number;
  ctx: HydrationContext;
}): Step<ContextMemory, string, string> {
  const { forkId, eachTemplate, item, index, ctx } = opts;
  const hydratedEach = hydrateNode(suffixNodeIds(eachTemplate, `-${index}`), ctx);
  return frameworkCast(
    step.run({
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
 * Resolves the subprocess adapter for a `run` node. When the node names an
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
 * Dispatches a `run` node's code string through a subprocess adapter: ships the
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
 */
export function hydrateNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextMemory, string, string> {
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
): Step<ContextMemory, string, string> {
  return hydrateNode(doc.root, ctx);
}

//#endregion
