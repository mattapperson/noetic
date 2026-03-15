import type { MemoryLayer, ExecutionContext, StorageAdapter } from '../types/memory';
import type { ItemLog } from '../types/context';
import type { Item } from '../types/items';
import type { LLMResponse } from '../types/common';
import { resolveScopeKey, createScopedStorage } from './scope';

export interface LayerStateStore {
  get<T>(executionId: string, layerId: string): T | undefined;
  set<T>(executionId: string, layerId: string, state: T): void;
  cleanup(executionId: string): void;
  diagnostic: (layerId: string, hook: string, error: unknown) => void;
}

export function createLayerStateStore(
  diagnostic?: (layerId: string, hook: string, error: unknown) => void,
): LayerStateStore {
  const states = new Map<string, Map<string, unknown>>();
  return {
    get<T>(executionId: string, layerId: string): T | undefined {
      return states.get(executionId)?.get(layerId) as T | undefined;
    },
    set<T>(executionId: string, layerId: string, state: T): void {
      if (!states.has(executionId)) states.set(executionId, new Map());
      states.get(executionId)!.set(layerId, state);
    },
    cleanup(executionId: string): void {
      states.delete(executionId);
    },
    diagnostic: diagnostic ?? (() => {}),
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return promise;
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    }),
  ]);
}

export async function initLayers(
  layers: MemoryLayer[],
  ctx: ExecutionContext,
  storage: StorageAdapter,
  store: LayerStateStore,
): Promise<void> {
  // Sequential, array order
  for (const layer of layers) {
    if (!layer.hooks.init) continue;
    const scopeKey = resolveScopeKey(layer.scope, ctx);
    const scopedStorage = createScopedStorage(storage, layer.id, scopeKey);
    try {
      const timeout = layer.timeouts?.init ?? 10_000;
      const result = await withTimeout(
        layer.hooks.init({ storage: scopedStorage, scopeKey, ctx }),
        timeout,
      );
      store.set(ctx.executionId, layer.id, result.state);
    } catch (e) {
      store.diagnostic(layer.id, 'init', e);
    }
  }
}

export async function recallLayers(
  layers: MemoryLayer[],
  query: string,
  ctx: ExecutionContext,
  log: ItemLog,
  budgets: Map<string, number>,
  store: LayerStateStore,
): Promise<{ layerId: string; items: Item[]; tokenCount: number }[]> {
  const sorted = [...layers].sort((a, b) => a.slot - b.slot);
  const results: { layerId: string; items: Item[]; tokenCount: number }[] = [];

  for (const layer of sorted) {
    if (!layer.hooks.recall) continue;
    const state = store.get(ctx.executionId, layer.id);
    if (state === undefined && layer.hooks.init) continue; // was disabled

    const budget = budgets.get(layer.id) ?? 0;
    try {
      const timeout = layer.timeouts?.recall ?? 5_000;
      const result = await withTimeout(
        layer.hooks.recall({ log, query, ctx, state, budget }),
        timeout,
      );
      if (result) {
        results.push({ layerId: layer.id, items: result.items, tokenCount: result.tokenCount });
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

export async function storeLayers(
  layers: MemoryLayer[],
  response: LLMResponse,
  ctx: ExecutionContext,
  log: ItemLog,
  store: LayerStateStore,
): Promise<void> {
  // Sequential, matching init/recall pattern
  for (const layer of layers) {
    if (!layer.hooks.store) continue;
    const state = store.get(ctx.executionId, layer.id);
    if (state === undefined && layer.hooks.init) continue;

    try {
      const timeout = layer.timeouts?.store ?? 30_000;
      const result = await withTimeout(
        layer.hooks.store({ newItems: response.items, log, response, ctx, state }),
        timeout,
      );
      if (result?.state !== undefined) {
        store.set(ctx.executionId, layer.id, result.state);
      }
    } catch (e) {
      store.diagnostic(layer.id, 'store', e);
    }
  }
}

export async function disposeLayers(
  layers: MemoryLayer[],
  ctx: ExecutionContext,
  store: LayerStateStore,
): Promise<void> {
  // Sequential, REVERSE array order
  const reversed = [...layers].reverse();
  for (const layer of reversed) {
    if (!layer.hooks.dispose) continue;
    const state = store.get(ctx.executionId, layer.id);
    try {
      const timeout = layer.timeouts?.dispose ?? 5_000;
      await withTimeout(layer.hooks.dispose({ state }), timeout);
    } catch (e) {
      store.diagnostic(layer.id, 'dispose', e);
    }
  }
  store.cleanup(ctx.executionId);
}

export async function spawnLayers(
  layers: MemoryLayer[],
  parentCtx: ExecutionContext,
  childCtx: ExecutionContext,
  spawnOpts: { contextIn: string; contextOut: string },
  store: LayerStateStore,
): Promise<{ layerId: string; childState: unknown; items: Item[] }[]> {
  const results: { layerId: string; childState: unknown; items: Item[] }[] = [];
  for (const layer of layers) {
    if (!layer.hooks.onSpawn) continue;
    const parentState = store.get(parentCtx.executionId, layer.id);
    if (parentState === undefined) continue;
    try {
      const timeout = layer.timeouts?.onSpawn ?? 10_000;
      const result = await withTimeout(
        layer.hooks.onSpawn({ parentState, childCtx, spawnOpts }),
        timeout,
      );
      if (result && result.childState !== null) {
        store.set(childCtx.executionId, layer.id, result.childState);
        results.push({ layerId: layer.id, childState: result.childState, items: result.items ?? [] });
      }
    } catch (e) {
      store.diagnostic(layer.id, 'onSpawn', e);
    }
  }
  return results;
}

export async function returnLayers(
  layers: MemoryLayer[],
  parentCtx: ExecutionContext,
  childCtx: ExecutionContext,
  childLog: ItemLog,
  result: unknown,
  store: LayerStateStore,
): Promise<void> {
  for (const layer of layers) {
    if (!layer.hooks.onReturn) continue;
    const childState = store.get(childCtx.executionId, layer.id);
    const parentState = store.get(parentCtx.executionId, layer.id);
    if (childState === undefined || parentState === undefined) continue;
    try {
      const timeout = layer.timeouts?.onReturn ?? 10_000;
      const returnResult = await withTimeout(
        layer.hooks.onReturn({ childState, childLog, parentState, result }),
        timeout,
      );
      if (returnResult?.parentState !== undefined) {
        store.set(parentCtx.executionId, layer.id, returnResult.parentState);
      }
    } catch (e) {
      store.diagnostic(layer.id, 'onReturn', e);
    }
  }
}

export async function completeLayers(
  layers: MemoryLayer[],
  ctx: ExecutionContext,
  log: ItemLog,
  outcome: 'success' | 'failure' | 'aborted',
  store: LayerStateStore,
): Promise<void> {
  for (const layer of layers) {
    if (!layer.hooks.onComplete) continue;
    const state = store.get(ctx.executionId, layer.id);
    try {
      const timeout = layer.timeouts?.onComplete ?? 30_000;
      await withTimeout(layer.hooks.onComplete({ log, ctx, state, outcome }), timeout);
    } catch (e) {
      store.diagnostic(layer.id, 'onComplete', e);
    }
  }
}
