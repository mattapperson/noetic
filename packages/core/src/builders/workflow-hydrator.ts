/**
 * Converts a validated `WorkflowDocument` into a live `Step` tree.
 *
 * Each node kind maps to the corresponding builder (`step.llm`, `fork`,
 * `loop`, etc.) so hydrated steps are indistinguishable from programmatic
 * ones — they register in the step registry, carry retry policies, etc.
 */

import { NoeticConfigError } from '../errors/noetic-config-error';
import type { UntilPredicate, WorkflowDocument, WorkflowNode } from '../schemas/workflow';
import type { Context } from '../types/context';
import type { ContextMemory, MemoryLayer } from '../types/memory';
import type { ExecuteStepFn, Step, Until } from '../types/step';
import type { Tool } from '../types/tool';
import { all, any } from '../until/combinators';
import { until } from '../until/predicates';
import { frameworkCast } from '../util/framework-cast';

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
}

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

  const resolvedTools = resolveTools(node.tools, ctx.tools);

  return step.llm({
    id: node.id,
    model: node.model ?? 'openai/gpt-4o',
    instructions: node.instructions,
    tools: resolvedTools.length > 0 ? resolvedTools : undefined,
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

  const hydratedPaths = node.paths.map((p) => hydrateNode(p, ctx));

  if (node.mode === 'race') {
    return fork({
      id: node.id,
      mode: 'race',
      paths: () => hydratedPaths,
      concurrency: node.concurrency,
      _optimizable: frameworkCast(hydratedPaths),
    });
  }

  const mergeFn = buildMerge(node.merge ?? 'last');

  if (node.mode === 'settle') {
    return fork({
      id: node.id,
      mode: 'settle',
      paths: () => hydratedPaths,
      merge: (results) => {
        const values = results.filter((r) => r.status === 'fulfilled').map((r) => r.value ?? '');
        return mergeFn(values);
      },
      concurrency: node.concurrency,
      _optimizable: frameworkCast(hydratedPaths),
    });
  }

  return fork({
    id: node.id,
    mode: 'all',
    paths: () => hydratedPaths,
    merge: mergeFn,
    concurrency: node.concurrency,
    _optimizable: frameworkCast(hydratedPaths),
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

//#endregion

//#region Handler Registry

const NODE_HYDRATORS: Record<string, NodeHydrator> = {
  llm: hydrateLlmNode,
  tool: hydrateToolNode,
  branch: hydrateBranchNode,
  fork: hydrateForkNode,
  spawn: hydrateSpawnNode,
  provide: hydrateProvideNode,
  loop: hydrateLoopNode,
  sequence: hydrateSequenceNode,
  every: hydrateEveryNode,
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
