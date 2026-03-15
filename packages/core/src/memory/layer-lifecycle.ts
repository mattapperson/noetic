import type { MemoryLayer, ExecutionContext, StorageAdapter } from '../types/memory';
import type { ItemLog } from '../types/context';
import type { Item } from '../types/items';
import type { LLMResponse } from '../types/common';
import { resolveScopeKey, createScopedStorage } from './scope';

// State management for active layers
export const layerStates = new Map<string, Map<string, unknown>>();

// Diagnostic callback for layer errors — default is no-op
let diagnosticFn: (layerId: string, hook: string, error: unknown) => void = () => {};

export function setLayerDiagnostic(fn: (layerId: string, hook: string, error: unknown) => void): void {
  diagnosticFn = fn;
}

function getLayerState<T>(executionId: string, layerId: string): T | undefined {
  return layerStates.get(executionId)?.get(layerId) as T | undefined;
}

function setLayerState<T>(executionId: string, layerId: string, state: T): void {
  if (!layerStates.has(executionId)) layerStates.set(executionId, new Map());
  layerStates.get(executionId)!.set(layerId, state);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return promise;
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.then(v => { clearTimeout(timer); return v; }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    }),
  ]);
}

export function cleanupLayerState(executionId: string): void {
  layerStates.delete(executionId);
}

export async function initLayers(
  layers: MemoryLayer[],
  ctx: ExecutionContext,
  storage: StorageAdapter,
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
      setLayerState(ctx.executionId, layer.id, result.state);
    } catch (e) {
      diagnosticFn(layer.id, 'init', e);
      // Init error -> layer disabled (skip in future hooks)
      // State remains undefined, which signals disabled
    }
  }
}

export async function recallLayers(
  layers: MemoryLayer[],
  query: string,
  ctx: ExecutionContext,
  log: ItemLog,
  budgets: Map<string, number>,
): Promise<{ layerId: string; items: Item[]; tokenCount: number }[]> {
  // Sequential, SLOT ORDER (ascending), ties by array index
  const sorted = [...layers].sort((a, b) => a.slot - b.slot);
  const results: { layerId: string; items: Item[]; tokenCount: number }[] = [];

  for (const layer of sorted) {
    if (!layer.hooks.recall) continue;
    const state = getLayerState(ctx.executionId, layer.id);
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
          setLayerState(ctx.executionId, layer.id, result.state);
        }
      }
    } catch (e) {
      diagnosticFn(layer.id, 'recall', e);
      // Recall error -> skip layer
    }
  }

  return results;
}

export async function storeLayers(
  layers: MemoryLayer[],
  response: LLMResponse,
  ctx: ExecutionContext,
  log: ItemLog,
): Promise<void> {
  // CONCURRENT via Promise.allSettled
  const promises = layers.map(async (layer) => {
    if (!layer.hooks.store) return;
    const state = getLayerState(ctx.executionId, layer.id);
    if (state === undefined && layer.hooks.init) return;

    try {
      const timeout = layer.timeouts?.store ?? 30_000;
      const result = await withTimeout(
        layer.hooks.store({ newItems: response.items, log, response, ctx, state }),
        timeout,
      );
      if (result?.state !== undefined) {
        setLayerState(ctx.executionId, layer.id, result.state);
      }
    } catch (e) {
      diagnosticFn(layer.id, 'store', e);
      // Store error -> skip
    }
  });

  await Promise.allSettled(promises);
}

export async function disposeLayers(
  layers: MemoryLayer[],
  ctx: ExecutionContext,
): Promise<void> {
  // Sequential, REVERSE array order
  const reversed = [...layers].reverse();
  for (const layer of reversed) {
    if (!layer.hooks.dispose) continue;
    const state = getLayerState(ctx.executionId, layer.id);
    try {
      const timeout = layer.timeouts?.dispose ?? 5_000;
      await withTimeout(layer.hooks.dispose({ state }), timeout);
    } catch (e) {
      diagnosticFn(layer.id, 'dispose', e);
      // Dispose error -> continue
    }
  }
  // Cleanup
  cleanupLayerState(ctx.executionId);
}

export async function spawnLayers(
  layers: MemoryLayer[],
  parentCtx: ExecutionContext,
  childCtx: ExecutionContext,
  spawnOpts: { contextIn: string; contextOut: string },
): Promise<{ layerId: string; childState: unknown; items: Item[] }[]> {
  // Sequential, array order
  const results: { layerId: string; childState: unknown; items: Item[] }[] = [];
  for (const layer of layers) {
    if (!layer.hooks.onSpawn) continue;
    const parentState = getLayerState(parentCtx.executionId, layer.id);
    if (parentState === undefined) continue; // layer not initialized
    try {
      const timeout = layer.timeouts?.onSpawn ?? 10_000;
      const result = await withTimeout(
        layer.hooks.onSpawn({ parentState, childCtx, spawnOpts }),
        timeout,
      );
      if (result && result.childState !== null) {
        setLayerState(childCtx.executionId, layer.id, result.childState);
        results.push({ layerId: layer.id, childState: result.childState, items: result.items ?? [] });
      }
    } catch (e) {
      diagnosticFn(layer.id, 'onSpawn', e);
      // onSpawn error -> skip layer
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
): Promise<void> {
  // Sequential, array order
  for (const layer of layers) {
    if (!layer.hooks.onReturn) continue;
    const childState = getLayerState(childCtx.executionId, layer.id);
    const parentState = getLayerState(parentCtx.executionId, layer.id);
    if (childState === undefined || parentState === undefined) continue;
    try {
      const timeout = layer.timeouts?.onReturn ?? 10_000;
      const returnResult = await withTimeout(
        layer.hooks.onReturn({ childState, childLog, parentState, result }),
        timeout,
      );
      if (returnResult?.parentState !== undefined) {
        setLayerState(parentCtx.executionId, layer.id, returnResult.parentState);
      }
    } catch (e) {
      diagnosticFn(layer.id, 'onReturn', e);
      // onReturn error -> continue
    }
  }
}

export async function completeLayers(
  layers: MemoryLayer[],
  ctx: ExecutionContext,
  log: ItemLog,
  outcome: 'success' | 'failure' | 'aborted',
): Promise<void> {
  // Sequential, array order, always runs
  for (const layer of layers) {
    if (!layer.hooks.onComplete) continue;
    const state = getLayerState(ctx.executionId, layer.id);
    try {
      const timeout = layer.timeouts?.onComplete ?? 30_000;
      await withTimeout(layer.hooks.onComplete({ log, ctx, state, outcome }), timeout);
    } catch (e) {
      diagnosticFn(layer.id, 'onComplete', e);
      // onComplete error -> continue
    }
  }
}
