import { describe, expect, it } from 'bun:test';
import {
  createLayerStateStore,
  initLayers,
  returnLayers,
  spawnLayers,
} from '../../src/memory/layer-lifecycle';
import type { MemoryLayer } from '../../src/types/memory';
import { makeCtx, makeItemLog, makeStorage } from '../_helpers';

describe('spawnLayers', () => {
  it('calls onSpawn and sets child state', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'test',
        name: 'Test',
        slot: 100,
        scope: 'execution',
        hooks: {
          init: async () => ({
            state: {
              data: 'parent',
            },
          }),
          onSpawn: async ({ parentState }) => ({
            childState: {
              ...(parentState as Record<string, unknown>),
              spawned: true,
            },
            items: [],
          }),
        },
      },
    ];
    const parentCtx = makeCtx({
      executionId: 'parent',
    });
    const childCtx = makeCtx({
      executionId: 'child',
      depth: 1,
    });

    await initLayers(layers, parentCtx, makeStorage(), store);
    const results = await spawnLayers(
      layers,
      parentCtx,
      childCtx,
      {
        contextIn: 'fresh',
        contextOut: 'full',
      },
      store,
    );

    expect(results).toHaveLength(1);
    expect((results[0].childState as Record<string, unknown>).spawned).toBe(true);
  });
});

describe('returnLayers', () => {
  it('merges child state back to parent', async () => {
    type CountState = {
      count: number;
    };
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'test',
        name: 'Test',
        slot: 100,
        scope: 'execution',
        hooks: {
          init: async () => ({
            state: {
              count: 0,
            } satisfies CountState,
          }),
          onSpawn: async ({ parentState }) => ({
            childState: structuredClone(parentState),
          }),
          onReturn: async ({ childState, parentState }) => ({
            parentState: {
              count: (parentState as CountState).count + (childState as CountState).count,
            } satisfies CountState,
          }),
        },
      },
    ];
    const parentCtx = makeCtx({
      executionId: 'parent2',
    });
    const childCtx = makeCtx({
      executionId: 'child2',
      depth: 1,
    });

    await initLayers(layers, parentCtx, makeStorage(), store);
    await spawnLayers(
      layers,
      parentCtx,
      childCtx,
      {
        contextIn: 'fresh',
        contextOut: 'full',
      },
      store,
    );

    // Simulate child modifying its state
    store.set('child2', 'test', {
      count: 5,
    });

    await returnLayers(layers, parentCtx, childCtx, makeItemLog(), 'done', store);

    const parentState = store.get<CountState>('parent2', 'test');
    expect(parentState?.count).toBe(5); // 0 + 5
  });

  it('missing onSpawn hook returns empty results', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'no-spawn',
        name: 'NoSpawn',
        slot: 100,
        scope: 'execution',
        hooks: {
          init: async () => ({
            state: {
              data: 'parent',
            },
          }),
        },
      },
    ];
    const parentCtx = makeCtx({
      executionId: 'parent3',
    });
    const childCtx = makeCtx({
      executionId: 'child3',
      depth: 1,
    });
    await initLayers(layers, parentCtx, makeStorage(), store);
    const results = await spawnLayers(
      layers,
      parentCtx,
      childCtx,
      {
        contextIn: 'fresh',
        contextOut: 'full',
      },
      store,
    );
    expect(results).toHaveLength(0);
  });

  it('onSpawn returning null excludes layer from child', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'null-spawn',
        name: 'NullSpawn',
        slot: 100,
        scope: 'execution',
        hooks: {
          init: async () => ({
            state: {
              data: 'parent',
            },
          }),
          onSpawn: async () => null,
        },
      },
    ];
    const parentCtx = makeCtx({
      executionId: 'parent4',
    });
    const childCtx = makeCtx({
      executionId: 'child4',
      depth: 1,
    });
    await initLayers(layers, parentCtx, makeStorage(), store);
    const results = await spawnLayers(
      layers,
      parentCtx,
      childCtx,
      {
        contextIn: 'fresh',
        contextOut: 'full',
      },
      store,
    );
    expect(results).toHaveLength(0);
  });
});
