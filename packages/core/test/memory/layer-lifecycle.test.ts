import { describe, it, expect } from 'bun:test';
import { initLayers, recallLayers, storeLayers, disposeLayers, completeLayers, layerStates } from '../../src/memory/layer-lifecycle';
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
    await initLayers(layers, ctx, makeStorage());
    expect(order).toEqual(['a', 'b']);
  });

  it('recall in slot order', async () => {
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
    await initLayers(layers, ctx, makeStorage());
    await recallLayers(layers, 'query', ctx, makeItemLog(), new Map([['high', 1000], ['low', 1000]]));
    expect(order).toEqual(['low', 'high']); // slot order ascending
  });

  it('store concurrent via allSettled', async () => {
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
    await initLayers(layers, ctx, makeStorage());
    const response: LLMResponse = { items: [], usage: { inputTokens: 0, outputTokens: 0 } };
    await storeLayers(layers, response, ctx, makeItemLog());
    expect(order).toHaveLength(2);
  });

  it('dispose in reverse order', async () => {
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
    await initLayers(layers, ctx, makeStorage());
    await disposeLayers(layers, ctx);
    expect(order).toEqual(['b', 'a']); // reverse
  });

  it('onComplete always runs', async () => {
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
    await initLayers(layers, ctx, makeStorage());
    await completeLayers(layers, ctx, makeItemLog(), 'success');
    expect(completed).toBe(true);
  });

  it('init error disables layer', async () => {
    const layers: MemoryLayer[] = [
      {
        id: 'broken', name: 'Broken', slot: 100, scope: 'thread', hooks: {
          init: async () => { throw new Error('init failed'); },
          recall: async () => ({ items: [], tokenCount: 0 }),
        },
      },
    ];
    const ctx = makeCtx();
    await initLayers(layers, ctx, makeStorage());
    const results = await recallLayers(layers, 'q', ctx, makeItemLog(), new Map([['broken', 1000]]));
    expect(results).toHaveLength(0); // skipped because init failed
  });

  it('recall timeout skips layer', async () => {
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
    await initLayers(layers, ctx, makeStorage());
    const results = await recallLayers(layers, 'q', ctx, makeItemLog(), new Map([['slow', 1000]]));
    expect(results).toHaveLength(0);
  });

  it('dispose cleans up layerStates', async () => {
    const layers: MemoryLayer[] = [
      {
        id: 'a', name: 'A', slot: 100, scope: 'thread', hooks: {
          init: async () => ({ state: { x: 1 } }),
        },
      },
    ];
    const ctx = makeCtx('exec-cleanup');
    await initLayers(layers, ctx, makeStorage());
    expect(layerStates.has('exec-cleanup')).toBe(true);
    await disposeLayers(layers, ctx);
    expect(layerStates.has('exec-cleanup')).toBe(false);
  });
});
