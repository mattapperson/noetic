import { describe, it, expect } from 'bun:test';
import { initLayers, spawnLayers, returnLayers, createLayerStateStore } from '../../src/memory/layer-lifecycle';
import type { MemoryLayer, ExecutionContext, StorageAdapter } from '../../src/types/memory';

function makeStorage(): StorageAdapter {
  const store = new Map<string, unknown>();
  return {
    async get(key) { return store.get(key) as any ?? null; },
    async set(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list(prefix) { return [...store.keys()].filter(k => k.startsWith(prefix)); },
  };
}

describe('spawnLayers', () => {
  it('calls onSpawn and sets child state', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [{
      id: 'test', name: 'Test', slot: 100, scope: 'execution', hooks: {
        init: async () => ({ state: { data: 'parent' } }),
        onSpawn: async ({ parentState }) => ({ childState: { ...parentState as any, spawned: true }, items: [] }),
      },
    }];
    const parentCtx: ExecutionContext = { executionId: 'parent', threadId: 't1', depth: 0 };
    const childCtx: ExecutionContext = { executionId: 'child', threadId: 't1', depth: 1 };

    await initLayers(layers, parentCtx, makeStorage(), store);
    const results = await spawnLayers(layers, parentCtx, childCtx, { contextIn: 'fresh', contextOut: 'full' }, store);

    expect(results).toHaveLength(1);
    expect((results[0].childState as any).spawned).toBe(true);
  });
});

describe('returnLayers', () => {
  it('merges child state back to parent', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [{
      id: 'test', name: 'Test', slot: 100, scope: 'execution', hooks: {
        init: async () => ({ state: { count: 0 } }),
        onSpawn: async ({ parentState }) => ({ childState: structuredClone(parentState) }),
        onReturn: async ({ childState, parentState }) => ({
          parentState: { count: (parentState as any).count + (childState as any).count },
        }),
      },
    }];
    const parentCtx: ExecutionContext = { executionId: 'parent2', threadId: 't1', depth: 0 };
    const childCtx: ExecutionContext = { executionId: 'child2', threadId: 't1', depth: 1 };

    await initLayers(layers, parentCtx, makeStorage(), store);
    await spawnLayers(layers, parentCtx, childCtx, { contextIn: 'fresh', contextOut: 'full' }, store);

    // Simulate child modifying its state
    store.set('child2', 'test', { count: 5 });

    await returnLayers(layers, parentCtx, childCtx, { items: [], append: () => {} } as any, 'done', store);

    const parentState = store.get<any>('parent2', 'test');
    expect(parentState.count).toBe(5); // 0 + 5
  });
});
