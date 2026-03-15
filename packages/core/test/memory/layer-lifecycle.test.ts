import { describe, it, expect } from 'bun:test';
import { initLayers, recallLayers, storeLayers, disposeLayers, completeLayers, createLayerStateStore } from '../../src/memory/layer-lifecycle';
import type { LayerStateStore } from '../../src/memory/layer-lifecycle';
import type { MemoryLayer, ExecutionContext, StorageAdapter } from '../../src/types/memory';
import type { ItemLog } from '../../src/types/context';
import type { Item } from '../../src/types/items';
import type { LLMResponse } from '../../src/types/common';
import { Slot } from '../../src/types/memory';

function makeStorage(): StorageAdapter {
  const store = new Map<string, unknown>();
  return {
    async get(key) { return (store.get(key) as any) ?? null; },
    async set(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list(prefix) { return [...store.keys()].filter(k => k.startsWith(prefix)); },
  };
}

function makeCtx(executionId = 'exec-1'): ExecutionContext {
  return { executionId, threadId: 'thread-1', resourceId: 'user-1', depth: 0 };
}

function makeItemLog(): ItemLog {
  const items: Item[] = [];
  return { get items() { return items; }, append(item: Item) { items.push(item); } };
}

describe('layer-lifecycle', () => {
  it('init sequential, sets state', async () => {
    const store = createLayerStateStore();
    const order: string[] = [];
    const layers: MemoryLayer[] = [
      {
        id: 'a', name: 'A', slot: 100, scope: 'thread', hooks: {
          init: async () => { order.push('a'); return { state: { a: true } }; },
        },
      },
      {
        id: 'b', name: 'B', slot: 200, scope: 'thread', hooks: {
          init: async () => { order.push('b'); return { state: { b: true } }; },
        },
      },
    ];
    const ctx = makeCtx();
    await initLayers(layers, ctx, makeStorage(), store);
    expect(order).toEqual(['a', 'b']);
  });

  it('recall in slot order', async () => {
    const store = createLayerStateStore();
    const order: string[] = [];
    const layers: MemoryLayer[] = [
      {
        id: 'high', name: 'High', slot: 300, scope: 'thread', hooks: {
          init: async () => ({ state: {} }),
          recall: async () => { order.push('high'); return { items: [], tokenCount: 0 }; },
        },
      },
      {
        id: 'low', name: 'Low', slot: 100, scope: 'thread', hooks: {
          init: async () => ({ state: {} }),
          recall: async () => { order.push('low'); return { items: [], tokenCount: 0 }; },
        },
      },
    ];
    const ctx = makeCtx();
    await initLayers(layers, ctx, makeStorage(), store);
    await recallLayers(layers, 'query', ctx, makeItemLog(), new Map([['high', 1000], ['low', 1000]]), store);
    expect(order).toEqual(['low', 'high']); // slot order ascending
  });

  it('store sequential', async () => {
    const store = createLayerStateStore();
    const order: string[] = [];
    const layers: MemoryLayer[] = [
      {
        id: 'a', name: 'A', slot: 100, scope: 'thread', hooks: {
          init: async () => ({ state: {} }),
          store: async () => { order.push('a'); return { state: {} }; },
        },
      },
      {
        id: 'b', name: 'B', slot: 200, scope: 'thread', hooks: {
          init: async () => ({ state: {} }),
          store: async () => { order.push('b'); return { state: {} }; },
        },
      },
    ];
    const ctx = makeCtx();
    await initLayers(layers, ctx, makeStorage(), store);
    const response: LLMResponse = { items: [], usage: { inputTokens: 0, outputTokens: 0 } };
    await storeLayers(layers, response, ctx, makeItemLog(), store);
    expect(order).toEqual(['a', 'b']); // sequential order
  });

  it('dispose in reverse order', async () => {
    const store = createLayerStateStore();
    const order: string[] = [];
    const layers: MemoryLayer[] = [
      {
        id: 'a', name: 'A', slot: 100, scope: 'thread', hooks: {
          init: async () => ({ state: {} }),
          dispose: async () => { order.push('a'); },
        },
      },
      {
        id: 'b', name: 'B', slot: 200, scope: 'thread', hooks: {
          init: async () => ({ state: {} }),
          dispose: async () => { order.push('b'); },
        },
      },
    ];
    const ctx = makeCtx();
    await initLayers(layers, ctx, makeStorage(), store);
    await disposeLayers(layers, ctx, store);
    expect(order).toEqual(['b', 'a']); // reverse
  });

  it('onComplete always runs', async () => {
    const store = createLayerStateStore();
    let completed = false;
    const layers: MemoryLayer[] = [
      {
        id: 'a', name: 'A', slot: 100, scope: 'thread', hooks: {
          init: async () => ({ state: {} }),
          onComplete: async () => { completed = true; },
        },
      },
    ];
    const ctx = makeCtx();
    await initLayers(layers, ctx, makeStorage(), store);
    await completeLayers(layers, ctx, makeItemLog(), 'success', store);
    expect(completed).toBe(true);
  });

  it('init error disables layer', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'broken', name: 'Broken', slot: 100, scope: 'thread', hooks: {
          init: async () => { throw new Error('init failed'); },
          recall: async () => ({ items: [], tokenCount: 0 }),
        },
      },
    ];
    const ctx = makeCtx();
    await initLayers(layers, ctx, makeStorage(), store);
    const results = await recallLayers(layers, 'q', ctx, makeItemLog(), new Map([['broken', 1000]]), store);
    expect(results).toHaveLength(0); // skipped because init failed
  });

  it('recall timeout skips layer', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'slow', name: 'Slow', slot: 100, scope: 'thread',
        timeouts: { recall: 50 },
        hooks: {
          init: async () => ({ state: {} }),
          recall: async () => {
            await new Promise(r => setTimeout(r, 200));
            return { items: [], tokenCount: 0 };
          },
        },
      },
    ];
    const ctx = makeCtx();
    await initLayers(layers, ctx, makeStorage(), store);
    const results = await recallLayers(layers, 'q', ctx, makeItemLog(), new Map([['slow', 1000]]), store);
    expect(results).toHaveLength(0);
  });

  it('diagnostic callback invoked on init error', async () => {
    const errors: { layerId: string; hook: string; error: unknown }[] = [];
    const store = createLayerStateStore((layerId, hook, error) => {
      errors.push({ layerId, hook, error });
    });

    const layers: MemoryLayer[] = [
      {
        id: 'broken', name: 'Broken', slot: 100, scope: 'thread', hooks: {
          init: async () => { throw new Error('init failed'); },
        },
      },
    ];
    const ctx = makeCtx('exec-diag');
    await initLayers(layers, ctx, makeStorage(), store);
    expect(errors).toHaveLength(1);
    expect(errors[0].layerId).toBe('broken');
    expect(errors[0].hook).toBe('init');
    expect((errors[0].error as Error).message).toBe('init failed');
  });

  it('diagnostic callback invoked on recall error', async () => {
    const errors: { layerId: string; hook: string }[] = [];
    const store = createLayerStateStore((layerId, hook) => {
      errors.push({ layerId, hook });
    });

    const layers: MemoryLayer[] = [
      {
        id: 'recall-fail', name: 'RecallFail', slot: 100, scope: 'thread', hooks: {
          recall: async () => { throw new Error('recall boom'); return { items: [], tokenCount: 0 }; },
        },
      },
    ];
    const ctx = makeCtx('exec-diag-recall');
    const results = await recallLayers(layers, 'q', ctx, makeItemLog(), new Map([['recall-fail', 1000]]), store);
    expect(results).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].hook).toBe('recall');
  });

  it('withTimeout clears timer when promise resolves first', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'fast', name: 'Fast', slot: 100, scope: 'thread',
        timeouts: { init: 5000 },
        hooks: {
          init: async () => ({ state: { fast: true } }),
        },
      },
    ];
    const ctx = makeCtx('exec-timer');
    await initLayers(layers, ctx, makeStorage(), store);
    // If we get here without hanging, the timer was properly cleaned up
    expect(store.get<{ fast: boolean }>('exec-timer', 'fast')).toEqual({ fast: true });
    await disposeLayers(layers, ctx, store);
  });

  it('cleanup is idempotent', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'a', name: 'A', slot: 100, scope: 'thread', hooks: {
          init: async () => ({ state: { x: 1 } }),
        },
      },
    ];
    const ctx = makeCtx('exec-cleanup-2');
    await initLayers(layers, ctx, makeStorage(), store);
    expect(store.get<{ x: number }>('exec-cleanup-2', 'a')).toEqual({ x: 1 });
    store.cleanup('exec-cleanup-2');
    expect(store.get('exec-cleanup-2', 'a')).toBeUndefined();
    // Second call should not throw
    store.cleanup('exec-cleanup-2');
    expect(store.get('exec-cleanup-2', 'a')).toBeUndefined();
  });

  it('dispose cleans up state', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'a', name: 'A', slot: 100, scope: 'thread', hooks: {
          init: async () => ({ state: { x: 1 } }),
        },
      },
    ];
    const ctx = makeCtx('exec-cleanup');
    await initLayers(layers, ctx, makeStorage(), store);
    expect(store.get<{ x: number }>('exec-cleanup', 'a')).toEqual({ x: 1 });
    await disposeLayers(layers, ctx, store);
    expect(store.get('exec-cleanup', 'a')).toBeUndefined();
  });
});
