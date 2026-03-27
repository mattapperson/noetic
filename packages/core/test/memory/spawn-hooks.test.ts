import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import {
  createLayerStateStore,
  initLayers,
  returnLayers,
  spawnLayers,
} from '../../src/memory/layer-lifecycle';
import type { MemoryLayer } from '../../src/types/memory';
import { makeCtx, makeItemLog, makeStorage } from '../_helpers';

type DataState = {
  data: string;
  spawned?: boolean;
};

function isDataState(value: unknown): value is DataState {
  return typeof value === 'object' && value !== null && 'data' in value;
}

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
          onSpawn: async ({ parentState }) => {
            assert(isDataState(parentState));
            return {
              childState: {
                ...parentState,
                spawned: true,
              },
              items: [],
            };
          },
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

    await initLayers({
      layers,
      ctx: parentCtx,
      storage: makeStorage(),
      store,
    });
    const results = await spawnLayers({
      layers,
      parentCtx,
      childCtx,
      store,
    });

    expect(results).toHaveLength(1);
    const firstResult = results[0];
    assert(firstResult !== undefined);
    assert(isDataState(firstResult.childState));
    expect(firstResult.childState.spawned).toBe(true);
  });
});

type CountState = {
  count: number;
};

function isCountState(value: unknown): value is CountState {
  return typeof value === 'object' && value !== null && 'count' in value;
}

describe('returnLayers', () => {
  it('merges child state back to parent', async () => {
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
          onReturn: async ({ childState, parentState }) => {
            assert(isCountState(parentState));
            assert(isCountState(childState));
            return {
              parentState: {
                count: parentState.count + childState.count,
              } satisfies CountState,
            };
          },
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

    await initLayers({
      layers,
      ctx: parentCtx,
      storage: makeStorage(),
      store,
    });
    await spawnLayers({
      layers,
      parentCtx,
      childCtx,
      store,
    });

    // Simulate child modifying its state
    store.set('child2', 'test', {
      count: 5,
    });

    const returnResult = await returnLayers({
      layers,
      parentCtx,
      childCtx,
      childLog: makeItemLog(),
      result: 'done',
      store,
    });

    const parentState = store.get<CountState>('parent2', 'test');
    assert(parentState !== undefined);
    expect(parentState.count).toBe(5); // 0 + 5
    expect(returnResult).toBe('done');
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
    await initLayers({
      layers,
      ctx: parentCtx,
      storage: makeStorage(),
      store,
    });
    const results = await spawnLayers({
      layers,
      parentCtx,
      childCtx,
      store,
    });
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
    await initLayers({
      layers,
      ctx: parentCtx,
      storage: makeStorage(),
      store,
    });
    const results = await spawnLayers({
      layers,
      parentCtx,
      childCtx,
      store,
    });
    expect(results).toHaveLength(0);
  });

  it('onReturn transforms result through the pipeline', async () => {
    type TagState = {
      tag: string;
    };
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'layer-a',
        name: 'LayerA',
        slot: 100,
        scope: 'execution',
        hooks: {
          init: async () => ({
            state: {
              tag: 'a',
            } satisfies TagState,
          }),
          onSpawn: async ({ parentState }) => ({
            childState: structuredClone(parentState),
          }),
          onReturn: async ({ parentState, result }) => ({
            parentState,
            result: `${String(result)}+a`,
          }),
        },
      },
      {
        id: 'layer-b',
        name: 'LayerB',
        slot: 200,
        scope: 'execution',
        hooks: {
          init: async () => ({
            state: {
              tag: 'b',
            } satisfies TagState,
          }),
          onSpawn: async ({ parentState }) => ({
            childState: structuredClone(parentState),
          }),
          onReturn: async ({ parentState, result }) => ({
            parentState,
            result: `${String(result)}+b`,
          }),
        },
      },
    ];

    const parentCtx = makeCtx({
      executionId: 'parent-pipeline',
    });
    const childCtx = makeCtx({
      executionId: 'child-pipeline',
      depth: 1,
    });

    await initLayers({
      layers,
      ctx: parentCtx,
      storage: makeStorage(),
      store,
    });
    await spawnLayers({
      layers,
      parentCtx,
      childCtx,
      store,
    });

    const returnResult = await returnLayers({
      layers,
      parentCtx,
      childCtx,
      childLog: makeItemLog(),
      result: 'seed',
      store,
    });

    // Each layer appends its tag: seed -> seed+a -> seed+a+b
    expect(returnResult).toBe('seed+a+b');
  });
});
