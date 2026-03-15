import { describe, it, expect } from 'bun:test';
import { initLayers, recallLayers, storeLayers, disposeLayers, completeLayers, layerStates, setLayerDiagnostic, cleanupLayerState } from '../../src/memory/layer-lifecycle';
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

  it('diagnostic callback invoked on init error', async () => {
    const errors: { layerId: string; hook: string; error: unknown }[] = [];
    setLayerDiagnostic((layerId, hook, error) => {
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
    await initLayers(layers, ctx, makeStorage());
    expect(errors).toHaveLength(1);
    expect(errors[0].layerId).toBe('broken');
    expect(errors[0].hook).toBe('init');
    expect((errors[0].error as Error).message).toBe('init failed');

    // Reset diagnostic to no-op
    setLayerDiagnostic(() => {});
  });

  it('diagnostic callback invoked on recall error', async () => {
    const errors: { layerId: string; hook: string }[] = [];
    setLayerDiagnostic((layerId, hook) => {
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
    const results = await recallLayers(layers, 'q', ctx, makeItemLog(), new Map([['recall-fail', 1000]]));
    expect(results).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].hook).toBe('recall');

    setLayerDiagnostic(() => {});
  });

  it('withTimeout clears timer when promise resolves first', async () => {
    // If withTimeout leaked timers, this test would hang (timeout in bun:test)
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
    await initLayers(layers, ctx, makeStorage());
    // If we get here without hanging, the timer was properly cleaned up
    expect(layerStates.get('exec-timer')?.get('fast')).toEqual({ fast: true });
    await disposeLayers(layers, ctx);
  });

  it('cleanupLayerState is idempotent', async () => {
    const layers: MemoryLayer[] = [
      {
        id: 'a', name: 'A', slot: 100, scope: 'thread', hooks: {
          init: async () => ({ state: { x: 1 } }),
        },
      },
    ];
    const ctx = makeCtx('exec-cleanup-2');
    await initLayers(layers, ctx, makeStorage());
    expect(layerStates.has('exec-cleanup-2')).toBe(true);
    cleanupLayerState('exec-cleanup-2');
    expect(layerStates.has('exec-cleanup-2')).toBe(false);
    // Second call should not throw
    cleanupLayerState('exec-cleanup-2');
    expect(layerStates.has('exec-cleanup-2')).toBe(false);
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
