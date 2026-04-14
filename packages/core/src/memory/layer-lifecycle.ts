import { NoeticConfigError } from '../errors/noetic-config-error';
import { frameworkCast } from '../interpreter/framework-cast';
import { createMessage, estimateTokens } from '../interpreter/message-helpers';
import type { LLMResponse } from '../types/common';
import type { ItemLog } from '../types/context';
import type { Item } from '../types/items';
import type { ExecutionContext, MemoryLayer, StorageAdapter } from '../types/memory';
import type { SteeringDecision } from '../types/steering';
import { SteeringAction } from '../types/steering';
import { createScopedStorage, resolveScopeKey } from './scope';

//#region Types

export interface LayerStateStore {
  get<T>(executionId: string, layerId: string): T | undefined;
  set<T>(executionId: string, layerId: string, state: T): void;
  cleanup(executionId: string): void;
  diagnostic: (layerId: string, hook: string, error: unknown) => void;
}

interface InitLayersParams {
  layers: MemoryLayer[];
  ctx: ExecutionContext;
  storage: StorageAdapter;
  store: LayerStateStore;
}

interface RecallLayersParams {
  layers: MemoryLayer[];
  query: string;
  ctx: ExecutionContext;
  log: ItemLog;
  budgets: Map<string, number>;
  store: LayerStateStore;
}

interface StoreLayersParams {
  layers: MemoryLayer[];
  response: LLMResponse;
  ctx: ExecutionContext;
  log: ItemLog;
  store: LayerStateStore;
}

interface SpawnLayersParams {
  layers: MemoryLayer[];
  parentCtx: ExecutionContext;
  childCtx: ExecutionContext;
  store: LayerStateStore;
}

interface ReturnLayersParams<T = unknown> {
  layers: MemoryLayer[];
  parentCtx: ExecutionContext;
  childCtx: ExecutionContext;
  childLog: ItemLog;
  result: T;
  store: LayerStateStore;
}

interface CompleteLayersParams {
  layers: MemoryLayer[];
  ctx: ExecutionContext;
  log: ItemLog;
  outcome: 'success' | 'failure' | 'aborted';
  store: LayerStateStore;
}

interface DisposeLayersParams {
  layers: MemoryLayer[];
  ctx: ExecutionContext;
  store: LayerStateStore;
}

interface BeforeToolCallLayersParams {
  layers: MemoryLayer[];
  toolName: string;
  toolArgs: unknown;
  ctx: ExecutionContext;
  store: LayerStateStore;
}

interface AfterModelCallLayersParams {
  layers: MemoryLayer[];
  response: LLMResponse;
  ctx: ExecutionContext;
  store: LayerStateStore;
}

/** @public A request to re-render the context window, collected from onItemAppend hooks. */
export interface RerenderRequest {
  layerId: string;
  slot: number;
  timing: 'immediate' | 'batched';
  scope: 'self' | 'slot-after' | 'all';
}

/** @public Result of running items through the onItemAppend pipeline. */
export interface AppendPipelineResult {
  /** Final items to append after all transformations. */
  items: Item[];
  /** Re-render requests collected from layers. */
  rerenderRequests: RerenderRequest[];
}

interface RunAppendPipelineParams {
  layers: MemoryLayer[];
  items: Item[];
  ctx: ExecutionContext;
  log: ItemLog;
  store: LayerStateStore;
}

interface ExecuteRerenderParams {
  requests: RerenderRequest[];
  layers: MemoryLayer[];
  ctx: ExecutionContext;
  log: ItemLog;
  budgets: Map<string, number>;
  store: LayerStateStore;
  /** Query for context-aware recall (e.g., last user message) */
  query?: string;
  /** Current re-render depth (for loop protection) */
  depth?: number;
}

/** Maximum allowed re-render depth to prevent infinite loops */
const MAX_RERENDER_DEPTH = 3;

/**
 * Default per-layer token budget when a layer has no `budget` config or uses
 * `'auto'`. Big enough that budget-respecting layers (e.g. file-reference)
 * render their content; real auto-allocation across layers is future work.
 */
const DEFAULT_LAYER_BUDGET = 1.6e4;

/** Resolve each layer's `BudgetConfig` to a concrete token budget for recall. */
export function resolveLayerBudgets(layers: ReadonlyArray<MemoryLayer>): Map<string, number> {
  const budgets = new Map<string, number>();
  for (const layer of layers) {
    const cfg = layer.budget;
    if (typeof cfg === 'number') {
      budgets.set(layer.id, cfg);
      continue;
    }
    if (typeof cfg === 'object') {
      budgets.set(layer.id, cfg.max);
      continue;
    }
    // 'auto' or undefined → use the default ceiling.
    budgets.set(layer.id, DEFAULT_LAYER_BUDGET);
  }
  return budgets;
}

//#endregion

//#region Helper Functions

export function createLayerStateStore(
  diagnostic?: (layerId: string, hook: string, error: unknown) => void,
): LayerStateStore {
  const states = new Map<string, Map<string, unknown>>();
  return {
    get<T>(executionId: string, layerId: string): T | undefined {
      return frameworkCast<T | undefined>(states.get(executionId)?.get(layerId));
    },
    set<T>(executionId: string, layerId: string, state: T): void {
      let execMap = states.get(executionId);
      if (!execMap) {
        execMap = new Map();
        states.set(executionId, execMap);
      }
      execMap.set(layerId, state);
    },
    cleanup(executionId: string): void {
      states.delete(executionId);
    },
    diagnostic: diagnostic ?? (() => {}),
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    }),
  ]);
}

export function mostRestrictive(decisions: SteeringDecision[]): SteeringDecision {
  let result: SteeringDecision = {
    action: SteeringAction.Allow,
  };
  const guidances: string[] = [];

  for (const d of decisions) {
    if (d.action === SteeringAction.Deny) {
      return d;
    }
    if (d.action === SteeringAction.Guide) {
      result = d;
      if (d.guidance) {
        guidances.push(d.guidance);
      }
    }
  }

  if (result.action === SteeringAction.Guide && guidances.length > 1) {
    return {
      action: SteeringAction.Guide,
      guidance: guidances.join('\n'),
    };
  }

  return result;
}

//#endregion

//#region Public API

export async function initLayers({ layers, ctx, storage, store }: InitLayersParams): Promise<void> {
  // Sequential, array order
  for (const layer of layers) {
    if (!layer.hooks.init) {
      continue;
    }
    const scopeKey = resolveScopeKey(layer.scope, ctx);
    const scopedStorage = createScopedStorage(storage, layer.id, scopeKey);
    try {
      const timeout = layer.timeouts?.init ?? 1e4;
      const result = await withTimeout(
        layer.hooks.init({
          storage: scopedStorage,
          scopeKey,
          ctx,
        }),
        timeout,
      );
      store.set(ctx.executionId, layer.id, result.state);
    } catch (e) {
      store.diagnostic(layer.id, 'init', e);
    }
  }
}

export async function recallLayers({
  layers,
  query,
  ctx,
  log,
  budgets,
  store,
}: RecallLayersParams): Promise<
  {
    layerId: string;
    items: Item[];
    tokenCount: number;
  }[]
> {
  const sorted = [
    ...layers,
  ].sort((a, b) => a.slot - b.slot);
  const results: {
    layerId: string;
    items: Item[];
    tokenCount: number;
  }[] = [];

  for (const layer of sorted) {
    if (!layer.hooks.recall) {
      continue;
    }
    const state = store.get(ctx.executionId, layer.id);
    if (state === undefined && layer.hooks.init) {
      continue; // was disabled
    }

    const budget = budgets.get(layer.id) ?? 0;
    try {
      const timeout = layer.timeouts?.recall ?? 5e3;
      const result = await withTimeout(
        layer.hooks.recall({
          log,
          query,
          ctx,
          state,
          budget,
        }),
        timeout,
      );
      if (!result) {
        continue;
      }
      if (typeof result === 'string') {
        results.push({
          layerId: layer.id,
          items: [
            createMessage(result, 'developer'),
          ],
          tokenCount: estimateTokens(result),
        });
        continue;
      }
      results.push({
        layerId: layer.id,
        items: result.items,
        tokenCount: result.tokenCount,
      });
      if (result.state !== undefined) {
        store.set(ctx.executionId, layer.id, result.state);
      }
    } catch (e) {
      store.diagnostic(layer.id, 'recall', e);
    }
  }

  return results;
}

export async function storeLayers({
  layers,
  response,
  ctx,
  log,
  store,
}: StoreLayersParams): Promise<void> {
  // Concurrent via Promise.allSettled — each layer gets its own state snapshot
  const snapshots: {
    layer: MemoryLayer;
    state: unknown;
    storeFn: NonNullable<MemoryLayer['hooks']['store']>;
  }[] = [];
  for (const layer of layers) {
    if (!layer.hooks.store) {
      continue;
    }
    const state = store.get(ctx.executionId, layer.id);
    if (state === undefined && layer.hooks.init) {
      continue;
    }
    snapshots.push({
      layer,
      state,
      storeFn: layer.hooks.store,
    });
  }

  await Promise.allSettled(
    snapshots.map(async ({ layer, state, storeFn }) => {
      const timeout = layer.timeouts?.store ?? 3e4;
      try {
        const result = await withTimeout(
          storeFn({
            newItems: response.items,
            log,
            response,
            ctx,
            state,
          }),
          timeout,
        );
        if (result?.state !== undefined) {
          store.set(ctx.executionId, layer.id, result.state);
        }
      } catch (e) {
        store.diagnostic(layer.id, 'store', e);
      }
    }),
  );
}

export async function disposeLayers({ layers, ctx, store }: DisposeLayersParams): Promise<void> {
  // Sequential, REVERSE array order
  const reversed = [
    ...layers,
  ].reverse();
  for (const layer of reversed) {
    if (!layer.hooks.dispose) {
      continue;
    }
    const state = store.get(ctx.executionId, layer.id);
    try {
      const timeout = layer.timeouts?.dispose ?? 5e3;
      await withTimeout(
        layer.hooks.dispose({
          state,
        }),
        timeout,
      );
    } catch (e) {
      store.diagnostic(layer.id, 'dispose', e);
    }
  }
  store.cleanup(ctx.executionId);
}

export async function spawnLayers({
  layers,
  parentCtx,
  childCtx,
  store,
}: SpawnLayersParams): Promise<
  {
    layerId: string;
    childState: unknown;
    items: Item[];
  }[]
> {
  const results: {
    layerId: string;
    childState: unknown;
    items: Item[];
  }[] = [];
  const sorted = [
    ...layers,
  ].sort((a, b) => a.slot - b.slot);
  for (const layer of sorted) {
    if (!layer.hooks.onSpawn) {
      continue;
    }
    const parentState = store.get(parentCtx.executionId, layer.id);
    if (parentState === undefined) {
      continue;
    }
    try {
      const timeout = layer.timeouts?.onSpawn ?? 1e4;
      const result = await withTimeout(
        layer.hooks.onSpawn({
          parentState,
          childCtx,
        }),
        timeout,
      );
      if (result && result.childState !== null) {
        store.set(childCtx.executionId, layer.id, result.childState);
        results.push({
          layerId: layer.id,
          childState: result.childState,
          items: result.items ?? [],
        });
      }
    } catch (e) {
      store.diagnostic(layer.id, 'onSpawn', e);
    }
  }
  return results;
}

export async function returnLayers<T>({
  layers,
  parentCtx,
  childCtx,
  childLog,
  result,
  store,
}: ReturnLayersParams<T>): Promise<T> {
  const sorted = [
    ...layers,
  ].sort((a, b) => a.slot - b.slot);
  let currentResult: unknown = result;

  for (const layer of sorted) {
    if (!layer.hooks.onReturn) {
      continue;
    }
    const childState = store.get(childCtx.executionId, layer.id);
    const parentState = store.get(parentCtx.executionId, layer.id);
    if (childState === undefined || parentState === undefined) {
      continue;
    }
    try {
      const timeout = layer.timeouts?.onReturn ?? 1e4;
      const returnResult = await withTimeout(
        layer.hooks.onReturn({
          childState,
          childLog,
          parentState,
          result: currentResult,
        }),
        timeout,
      );
      if (returnResult?.parentState !== undefined) {
        store.set(parentCtx.executionId, layer.id, returnResult.parentState);
      }
      if (returnResult?.result !== undefined) {
        currentResult = returnResult.result;
      }
    } catch (e) {
      store.diagnostic(layer.id, 'onReturn', e);
    }
  }

  return frameworkCast<T>(currentResult);
}

export async function completeLayers({
  layers,
  ctx,
  log,
  outcome,
  store,
}: CompleteLayersParams): Promise<void> {
  for (const layer of layers) {
    if (!layer.hooks.onComplete) {
      continue;
    }
    const state = store.get(ctx.executionId, layer.id);
    try {
      const timeout = layer.timeouts?.onComplete ?? 3e4;
      const result = await withTimeout(
        layer.hooks.onComplete({
          log,
          ctx,
          state,
          outcome,
        }),
        timeout,
      );
      if (result && 'state' in result) {
        store.set(ctx.executionId, layer.id, result.state);
      }
    } catch (e) {
      store.diagnostic(layer.id, 'onComplete', e);
    }
  }
}

export async function beforeToolCallLayers({
  layers,
  toolName,
  toolArgs,
  ctx,
  store,
}: BeforeToolCallLayersParams): Promise<SteeringDecision> {
  const sorted = [
    ...layers,
  ].sort((a, b) => a.slot - b.slot);
  const decisions: SteeringDecision[] = [];

  for (const layer of sorted) {
    if (!layer.hooks.beforeToolCall) {
      continue;
    }
    const state = store.get(ctx.executionId, layer.id);
    if (state === undefined && layer.hooks.init) {
      continue;
    }
    try {
      const timeout = layer.timeouts?.beforeToolCall ?? 5e3;
      const result = await withTimeout(
        layer.hooks.beforeToolCall({
          toolName,
          toolArgs,
          ctx,
          state,
        }),
        timeout,
      );
      if (result.state !== undefined) {
        store.set(ctx.executionId, layer.id, result.state);
      }
      if (result.decision.action === SteeringAction.Deny) {
        return result.decision;
      }
      decisions.push(result.decision);
    } catch (e) {
      if (e instanceof NoeticConfigError) {
        throw e;
      }
      store.diagnostic(layer.id, 'beforeToolCall', e);
    }
  }

  return mostRestrictive(decisions);
}

export async function afterModelCallLayers({
  layers,
  response,
  ctx,
  store,
}: AfterModelCallLayersParams): Promise<SteeringDecision> {
  const sorted = [
    ...layers,
  ].sort((a, b) => a.slot - b.slot);
  const decisions: SteeringDecision[] = [];

  for (const layer of sorted) {
    if (!layer.hooks.afterModelCall) {
      continue;
    }
    const state = store.get(ctx.executionId, layer.id);
    if (state === undefined && layer.hooks.init) {
      continue;
    }
    try {
      const timeout = layer.timeouts?.afterModelCall ?? 1e4;
      const result = await withTimeout(
        layer.hooks.afterModelCall({
          response,
          ctx,
          state,
        }),
        timeout,
      );
      if (result.state !== undefined) {
        store.set(ctx.executionId, layer.id, result.state);
      }
      if (result.decision.action === SteeringAction.Deny) {
        return result.decision;
      }
      decisions.push(result.decision);
    } catch (e) {
      if (e instanceof NoeticConfigError) {
        throw e;
      }
      store.diagnostic(layer.id, 'afterModelCall', e);
    }
  }

  return mostRestrictive(decisions);
}

const DEFAULT_ON_ITEM_APPEND_TIMEOUT = 5e3;

/**
 * Run items through the onItemAppend pipeline.
 * Each layer can filter, transform, or inject items.
 * Returns final items to append and any re-render requests.
 */
export async function runAppendPipeline({
  layers,
  items,
  ctx,
  log,
  store,
}: RunAppendPipelineParams): Promise<AppendPipelineResult> {
  const requests: RerenderRequest[] = [];
  let currentItems = items;

  // Run pipeline in slot order
  const sorted = [
    ...layers,
  ].sort((a, b) => a.slot - b.slot);

  for (const layer of sorted) {
    if (!layer.hooks.onItemAppend) {
      continue;
    }

    // Skip if no items left (all filtered by previous layer)
    if (currentItems.length === 0) {
      break;
    }

    const state = store.get(ctx.executionId, layer.id);
    // Skip if layer was disabled (has init but no state)
    if (state === undefined && layer.hooks.init) {
      continue;
    }

    try {
      const timeout = layer.timeouts?.onItemAppend ?? DEFAULT_ON_ITEM_APPEND_TIMEOUT;
      const result = await withTimeout(
        layer.hooks.onItemAppend({
          items: currentItems,
          log,
          ctx,
          state,
        }),
        timeout,
      );

      // Update items for next layer in pipeline
      currentItems = result.items;

      // Update state if provided
      if (result.state !== undefined) {
        store.set(ctx.executionId, layer.id, result.state);
      }

      // Collect re-render request if present
      if (result.rerender) {
        requests.push({
          layerId: layer.id,
          slot: layer.slot,
          timing: result.timing ?? layer.rerenderTiming ?? 'batched',
          scope: result.scope ?? 'slot-after',
        });
      }
    } catch (e) {
      store.diagnostic(layer.id, 'onItemAppend', e);
      // On error, pass through items unchanged for this layer
    }
  }

  return {
    items: currentItems,
    rerenderRequests: requests,
  };
}

/**
 * Execute re-render based on collected requests.
 * Determines which layers need re-recall based on scope and runs them.
 * Returns new recall results to merge into view.
 */
export async function executeRerender({
  requests,
  layers,
  ctx,
  log,
  budgets,
  store,
  query = '',
  depth = 0,
}: ExecuteRerenderParams): Promise<
  {
    layerId: string;
    items: Item[];
    tokenCount: number;
  }[]
> {
  if (requests.length === 0) {
    return [];
  }

  // Prevent infinite re-render loops
  if (depth >= MAX_RERENDER_DEPTH) {
    // Log warning and return empty - don't throw to avoid breaking the flow
    console.warn(
      `[noetic] Re-render depth exceeded (${depth} >= ${MAX_RERENDER_DEPTH}). ` +
        'Possible infinite re-render loop detected. Stopping re-render cascade.',
    );
    return [];
  }

  // Determine which layers need re-recall based on scope
  const layersToRecall = new Set<string>();

  for (const req of requests) {
    switch (req.scope) {
      case 'self':
        layersToRecall.add(req.layerId);
        break;
      case 'slot-after':
        for (const layer of layers) {
          if (layer.slot >= req.slot) {
            layersToRecall.add(layer.id);
          }
        }
        break;
      case 'all':
        for (const layer of layers) {
          layersToRecall.add(layer.id);
        }
        break;
    }
  }

  // Re-run recall for affected layers
  const affectedLayers = layers
    .filter((l) => layersToRecall.has(l.id))
    .sort((a, b) => a.slot - b.slot);

  // Use existing recallLayers with filtered layers
  return recallLayers({
    layers: affectedLayers,
    query,
    ctx,
    log,
    budgets,
    store,
  });
}

//#endregion
