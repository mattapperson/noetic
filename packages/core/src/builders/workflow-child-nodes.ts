/**
 * Hydrators for the JSON workflow nodes that run their children as child
 * executions: `inParallel` (static and fan-out paths), `spawn`, `withContext`,
 * and `subflow` (a named or inline sub-document).
 */

import type { ContextData, ContextLayer } from '@noetic-tools/context';
import type { Context, Step } from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import type { SubflowWorkflowNode, WorkflowDocument, WorkflowNode } from '../schemas/workflow';
import { inParallel } from './control-flow-builders';
import { outputText } from './output-text';
import { withContext } from './provide-builder';
import { spawn } from './spawn-builder';
import { runCode } from './step-builders';
import { checkManifestName } from './workflow-connection-nodes';
import { documentScope } from './workflow-custom-items';
import type { HydrationContext } from './workflow-hydrator';
import { hydrateNode } from './workflow-hydrator';

//#region Child-Execution Node Hydrators

export function hydrateInParallelNode(
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

export function hydrateSpawnNode(
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

export function hydrateWithContextNode(
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

/**
 * Hydrates a `subflow` node lazily: the target document resolves and hydrates
 * on first execution, memoized. Lazy because `HydrationContext.workflows` may
 * be a live view that gains entries after hydration, and because a recursive
 * ref must hydrate only the levels execution reaches — eager hydration of
 * A→A would never end. Each level gets its own tree whose ids carry the
 * calling node's (already suffixed) id, so levels never share step ids.
 */
export function hydrateSubflowNode(
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

const DEFAULT_MAX_RECURSION_DEPTH = 100;

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

//#endregion
