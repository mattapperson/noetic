import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextLayer } from '@noetic-tools/context';
import {
  createLayerStateStore,
  initLayers,
  returnLayers,
  spawnLayers,
} from '@noetic-tools/context';
import { isNoeticError } from '@noetic-tools/types';
import { NoeticEvent } from '../../src/observability/genai-attributes';
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
    const layers: ContextLayer[] = [
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
    const layers: ContextLayer[] = [
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
      stepId: 'spawn',
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
    const layers: ContextLayer[] = [
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
    const layers: ContextLayer[] = [
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
    const layers: ContextLayer[] = [
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
      stepId: 'spawn',
      parentCtx,
      childCtx,
      childLog: makeItemLog(),
      result: 'seed',
      store,
    });

    // Each layer appends its tag: seed -> seed+a -> seed+a+b
    expect(returnResult).toBe('seed+a+b');
  });

  it('a failing onReturn passes the result through and records a span event on the child', async () => {
    const errors: unknown[] = [];
    const store = createLayerStateStore((_layerId, _hook, error) => {
      errors.push(error);
    });
    const events: Array<{
      name: string;
      attributes?: Record<string, string | number | boolean>;
    }> = [];
    const layers: ContextLayer[] = [
      {
        id: 'summarizer',
        name: 'Summarizer',
        slot: 100,
        scope: 'execution',
        hooks: {
          onReturn: async () => {
            throw new Error('summary timed out');
          },
        },
      },
    ];
    const parentCtx = makeCtx({
      executionId: 'parent-summary',
    });
    const childCtx = makeCtx({
      executionId: 'child-summary',
      depth: 1,
      trace: {
        setAttribute() {},
        addEvent(name, attributes) {
          events.push({
            name,
            attributes,
          });
        },
      },
    });
    store.set('child-summary', 'summarizer', {
      notes: 'child work',
    });

    const returnResult = await returnLayers({
      layers,
      stepId: 'research',
      parentCtx,
      childCtx,
      childLog: makeItemLog(),
      result: 'raw',
      store,
    });

    expect(returnResult).toBe('raw');
    expect(events.map((e) => e.name)).toEqual([
      NoeticEvent.LAYER_HOOK,
      NoeticEvent.SPAWN_SUMMARY_FAILED,
    ]);
    expect(events.filter((e) => e.name === NoeticEvent.SPAWN_SUMMARY_FAILED)).toEqual([
      {
        name: NoeticEvent.SPAWN_SUMMARY_FAILED,
        attributes: {
          stepId: 'research',
          layerId: 'summarizer',
          message: 'summary timed out',
        },
      },
    ]);
    const [error] = errors;
    assert(isNoeticError(error));
    expect(error.noeticError.kind).toBe('spawn_summary_failed');
  });

  it('names the child execution in the diagnostic when no stepId is given', async () => {
    const errors: unknown[] = [];
    const store = createLayerStateStore((_layerId, _hook, error) => {
      errors.push(error);
    });
    const layers: ContextLayer[] = [
      {
        id: 'summarizer',
        name: 'Summarizer',
        slot: 100,
        scope: 'execution',
        hooks: {
          onReturn: async () => {
            throw new Error('summary timed out');
          },
        },
      },
    ];
    store.set('child-default', 'summarizer', {
      notes: 'child work',
    });

    const returnResult = await returnLayers({
      layers,
      parentCtx: makeCtx({
        executionId: 'parent-default',
      }),
      childCtx: makeCtx({
        executionId: 'child-default',
        depth: 1,
      }),
      childLog: makeItemLog(),
      result: 'raw',
      store,
    });

    expect(returnResult).toBe('raw');
    const [error] = errors;
    assert(isNoeticError(error));
    assert(error.noeticError.kind === 'spawn_summary_failed');
    expect(error.noeticError.stepId).toBe('child-default');
  });
});
