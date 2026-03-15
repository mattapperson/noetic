import type { LLMResponse } from '../types/common';
import type { ItemLog } from '../types/context';
import type { Item } from '../types/items';
import type { ExecutionContext, MemoryLayer, StorageAdapter } from '../types/memory';
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

interface ReturnLayersParams {
  layers: MemoryLayer[];
  parentCtx: ExecutionContext;
  childCtx: ExecutionContext;
  childLog: ItemLog;
  result: unknown;
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

//#endregion

//#region Helper Functions

export function createLayerStateStore(
  diagnostic?: (layerId: string, hook: string, error: unknown) => void,
): LayerStateStore {
  const states = new Map<string, Map<string, unknown>>();
  return {
    get<T>(executionId: string, layerId: string): T | undefined {
      // SAFETY: values are stored via set(key, layerId, state: T); the caller is
      // responsible for reading back with the same type T they stored.
      return states.get(executionId)?.get(layerId) as T | undefined;
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
      if (result) {
        results.push({
          layerId: layer.id,
          items: result.items,
          tokenCount: result.tokenCount,
        });
        if (result.state !== undefined) {
          store.set(ctx.executionId, layer.id, result.state);
        }
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

export async function returnLayers({
  layers,
  parentCtx,
  childCtx,
  childLog,
  result,
  store,
}: ReturnLayersParams): Promise<unknown> {
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

  return currentResult;
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

//#endregion
