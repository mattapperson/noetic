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
  /** When provided, layers whose store produces new state are marked stale for eventual recall refresh. */
  recallCache?: RecallCache;
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

export interface RecallCache {
  entries: Map<string, RecallCacheEntry>;
  stale: Set<string>;
}

interface RecallCacheEntry {
  layerId: string;
  items: Item[];
  tokenCount: number;
}

export function createRecallCache(): RecallCache {
  return {
    entries: new Map(),
    stale: new Set(),
  };
}

function _recallCacheKey(executionId: string, layerId: string): string {
  return `${executionId}:${layerId}`;
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

interface RecallLayersWithCacheParams extends RecallLayersParams {
  cache: RecallCache;
}

export async function recallLayersAtomic(params: RecallLayersParams): Promise<
  {
    layerId: string;
    items: Item[];
    tokenCount: number;
  }[]
> {
  const atomicLayers = params.layers.filter((l) => l.recallMode !== 'eventual');
  return recallLayers({
    ...params,
    layers: atomicLayers,
  });
}

export async function recallLayersEventual({
  cache,
  ...params
}: RecallLayersWithCacheParams): Promise<
  {
    layerId: string;
    items: Item[];
    tokenCount: number;
  }[]
> {
  const eventualLayers = params.layers.filter((l) => l.recallMode === 'eventual');
  if (eventualLayers.length === 0) {
    return [];
  }

  const results: {
    layerId: string;
    items: Item[];
    tokenCount: number;
  }[] = [];

  for (const layer of eventualLayers) {
    const key = _recallCacheKey(params.ctx.executionId, layer.id);
    const cached = cache.entries.get(key);
    const isStale = cache.stale.has(key);

    // First call (no cache) or stale: recall and await
    if (!cached || isStale) {
      const recalled = await recallLayers({
        ...params,
        layers: [
          layer,
        ],
      });
      for (const entry of recalled) {
        cache.entries.set(key, entry);
        results.push(entry);
      }
      cache.stale.delete(key);
      continue;
    }

    // Cached and fresh: return cached
    results.push(cached);
  }

  return results;
}

export async function storeLayers({
  layers,
  response,
  ctx,
  log,
  store,
  recallCache,
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
          if (recallCache && layer.recallMode === 'eventual') {
            recallCache.stale.add(_recallCacheKey(ctx.executionId, layer.id));
          }
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

//#endregion
