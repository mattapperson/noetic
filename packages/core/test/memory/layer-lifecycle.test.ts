import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import {
  completeLayers,
  createLayerStateStore,
  createRecallCache,
  disposeLayers,
  initLayers,
  recallLayers,
  recallLayersAtomic,
  recallLayersEventual,
  storeLayers,
} from '../../src/memory/layer-lifecycle';
import type { LLMResponse } from '../../src/types/common';
import type { MemoryLayer } from '../../src/types/memory';
import { makeCtx, makeItemLog, makeStorage } from '../_helpers';

describe('recallLayersAtomic', () => {
  it('filters to atomic layers only', async () => {
    const store = createLayerStateStore();
    const ctx = makeCtx();
    const layers: MemoryLayer[] = [
      {
        id: 'atomic-layer',
        slot: 100,
        scope: 'thread',
        hooks: {
          async recall() {
            return 'atomic-data';
          },
        },
      },
      {
        id: 'eventual-layer',
        slot: 200,
        scope: 'thread',
        recallMode: 'eventual',
        hooks: {
          async recall() {
            return 'eventual-data';
          },
        },
      },
    ];

    const results = await recallLayersAtomic({
      layers,
      query: 'test',
      ctx,
      log: makeItemLog(),
      budgets: new Map(),
      store,
    });

    expect(results).toHaveLength(1);
    expect(results[0].layerId).toBe('atomic-layer');
  });

  it('includes layers with no explicit recallMode (default atomic)', async () => {
    const store = createLayerStateStore();
    const ctx = makeCtx();
    const layers: MemoryLayer[] = [
      {
        id: 'default-layer',
        slot: 100,
        scope: 'thread',
        hooks: {
          async recall() {
            return 'data';
          },
        },
      },
    ];

    const results = await recallLayersAtomic({
      layers,
      query: 'test',
      ctx,
      log: makeItemLog(),
      budgets: new Map(),
      store,
    });

    expect(results).toHaveLength(1);
    expect(results[0].layerId).toBe('default-layer');
  });
});

describe('recallLayersEventual', () => {
  it('filters to eventual layers only', async () => {
    const store = createLayerStateStore();
    const ctx = makeCtx();
    const cache = createRecallCache();
    const layers: MemoryLayer[] = [
      {
        id: 'atomic-layer',
        slot: 100,
        scope: 'thread',
        hooks: {
          async recall() {
            return 'atomic-data';
          },
        },
      },
      {
        id: 'eventual-layer',
        slot: 200,
        scope: 'thread',
        recallMode: 'eventual',
        hooks: {
          async recall() {
            return 'eventual-data';
          },
        },
      },
    ];

    const results = await recallLayersEventual({
      layers,
      query: 'test',
      ctx,
      log: makeItemLog(),
      budgets: new Map(),
      store,
      cache,
    });

    expect(results).toHaveLength(1);
    expect(results[0].layerId).toBe('eventual-layer');
  });

  it('returns cached results on second call without stale mark', async () => {
    const store = createLayerStateStore();
    const ctx = makeCtx();
    const cache = createRecallCache();
    let callCount = 0;
    const layers: MemoryLayer[] = [
      {
        id: 'obs',
        slot: 200,
        scope: 'thread',
        recallMode: 'eventual',
        hooks: {
          async recall() {
            callCount++;
            return `call-${callCount}`;
          },
        },
      },
    ];

    const params = {
      layers,
      query: 'test',
      ctx,
      log: makeItemLog(),
      budgets: new Map<string, number>(),
      store,
      cache,
    };

    const first = await recallLayersEventual(params);
    expect(first).toHaveLength(1);
    expect(callCount).toBe(1);

    const second = await recallLayersEventual(params);
    expect(second).toHaveLength(1);
    // Should NOT have re-called recall — used cache
    expect(callCount).toBe(1);
  });

  it('re-recalls when cache is marked stale', async () => {
    const store = createLayerStateStore();
    const ctx = makeCtx();
    const cache = createRecallCache();
    let callCount = 0;
    const layers: MemoryLayer[] = [
      {
        id: 'obs',
        slot: 200,
        scope: 'thread',
        recallMode: 'eventual',
        hooks: {
          async recall() {
            callCount++;
            return `call-${callCount}`;
          },
        },
      },
    ];

    const params = {
      layers,
      query: 'test',
      ctx,
      log: makeItemLog(),
      budgets: new Map<string, number>(),
      store,
      cache,
    };

    await recallLayersEventual(params);
    expect(callCount).toBe(1);

    // Mark stale
    cache.stale.add(`${ctx.executionId}:obs`);

    await recallLayersEventual(params);
    expect(callCount).toBe(2);
  });
});

describe('layer-lifecycle', () => {
  it('init sequential, sets state', async () => {
    const store = createLayerStateStore();
    const order: string[] = [];
    const layers: MemoryLayer[] = [
      {
        id: 'a',
        name: 'A',
        slot: 100,
        scope: 'thread',
        hooks: {
          init: async () => {
            order.push('a');
            return {
              state: {
                a: true,
              },
            };
          },
        },
      },
      {
        id: 'b',
        name: 'B',
        slot: 200,
        scope: 'thread',
        hooks: {
          init: async () => {
            order.push('b');
            return {
              state: {
                b: true,
              },
            };
          },
        },
      },
    ];
    const ctx = makeCtx();
    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });
    expect(order).toEqual([
      'a',
      'b',
    ]);
  });

  it('recall in slot order', async () => {
    const store = createLayerStateStore();
    const order: string[] = [];
    const layers: MemoryLayer[] = [
      {
        id: 'high',
        name: 'High',
        slot: 300,
        scope: 'thread',
        hooks: {
          init: async () => ({
            state: {},
          }),
          recall: async () => {
            order.push('high');
            return {
              items: [],
              tokenCount: 0,
            };
          },
        },
      },
      {
        id: 'low',
        name: 'Low',
        slot: 100,
        scope: 'thread',
        hooks: {
          init: async () => ({
            state: {},
          }),
          recall: async () => {
            order.push('low');
            return {
              items: [],
              tokenCount: 0,
            };
          },
        },
      },
    ];
    const ctx = makeCtx();
    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });
    await recallLayers({
      layers,
      query: 'query',
      ctx,
      log: makeItemLog(),
      budgets: new Map([
        [
          'high',
          1e3,
        ],
        [
          'low',
          1e3,
        ],
      ]),
      store,
    });
    expect(order).toEqual([
      'low',
      'high',
    ]); // slot order ascending
  });

  it('store concurrent', async () => {
    const store = createLayerStateStore();
    const order: string[] = [];
    const layers: MemoryLayer[] = [
      {
        id: 'a',
        name: 'A',
        slot: 100,
        scope: 'thread',
        hooks: {
          init: async () => ({
            state: {},
          }),
          store: async () => {
            order.push('a');
            return {
              state: {},
            };
          },
        },
      },
      {
        id: 'b',
        name: 'B',
        slot: 200,
        scope: 'thread',
        hooks: {
          init: async () => ({
            state: {},
          }),
          store: async () => {
            order.push('b');
            return {
              state: {},
            };
          },
        },
      },
    ];
    const ctx = makeCtx();
    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });
    const response: LLMResponse = {
      items: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
      },
    };
    await storeLayers({
      layers,
      response,
      ctx,
      log: makeItemLog(),
      store,
    });
    // Both should have run (order may vary since concurrent)
    expect(order).toHaveLength(2);
    expect(order).toContain('a');
    expect(order).toContain('b');
  });

  it('dispose in reverse order', async () => {
    const store = createLayerStateStore();
    const order: string[] = [];
    const layers: MemoryLayer[] = [
      {
        id: 'a',
        name: 'A',
        slot: 100,
        scope: 'thread',
        hooks: {
          init: async () => ({
            state: {},
          }),
          dispose: async () => {
            order.push('a');
          },
        },
      },
      {
        id: 'b',
        name: 'B',
        slot: 200,
        scope: 'thread',
        hooks: {
          init: async () => ({
            state: {},
          }),
          dispose: async () => {
            order.push('b');
          },
        },
      },
    ];
    const ctx = makeCtx();
    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });
    await disposeLayers({
      layers,
      ctx,
      store,
    });
    expect(order).toEqual([
      'b',
      'a',
    ]); // reverse
  });

  it('onComplete always runs', async () => {
    const store = createLayerStateStore();
    let completed = false;
    const layers: MemoryLayer[] = [
      {
        id: 'a',
        name: 'A',
        slot: 100,
        scope: 'thread',
        hooks: {
          init: async () => ({
            state: {},
          }),
          onComplete: async () => {
            completed = true;
            return undefined;
          },
        },
      },
    ];
    const ctx = makeCtx();
    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });
    await completeLayers({
      layers,
      ctx,
      log: makeItemLog(),
      outcome: 'success',
      store,
    });
    expect(completed).toBe(true);
  });

  it('init error disables layer', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'broken',
        name: 'Broken',
        slot: 100,
        scope: 'thread',
        hooks: {
          init: async () => {
            throw new Error('init failed');
          },
          recall: async () => ({
            items: [],
            tokenCount: 0,
          }),
        },
      },
    ];
    const ctx = makeCtx();
    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });
    const results = await recallLayers({
      layers,
      query: 'q',
      ctx,
      log: makeItemLog(),
      budgets: new Map([
        [
          'broken',
          1e3,
        ],
      ]),
      store,
    });
    expect(results).toHaveLength(0); // skipped because init failed
  });

  it('recall timeout skips layer', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'slow',
        name: 'Slow',
        slot: 100,
        scope: 'thread',
        timeouts: {
          recall: 50,
        },
        hooks: {
          init: async () => ({
            state: {},
          }),
          recall: async () => {
            await new Promise((r) => setTimeout(r, 200));
            return {
              items: [],
              tokenCount: 0,
            };
          },
        },
      },
    ];
    const ctx = makeCtx();
    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });
    const results = await recallLayers({
      layers,
      query: 'q',
      ctx,
      log: makeItemLog(),
      budgets: new Map([
        [
          'slow',
          1e3,
        ],
      ]),
      store,
    });
    expect(results).toHaveLength(0);
  });

  it('diagnostic callback invoked on init error', async () => {
    const errors: {
      layerId: string;
      hook: string;
      error: unknown;
    }[] = [];
    const store = createLayerStateStore((layerId, hook, error) => {
      errors.push({
        layerId,
        hook,
        error,
      });
    });

    const layers: MemoryLayer[] = [
      {
        id: 'broken',
        name: 'Broken',
        slot: 100,
        scope: 'thread',
        hooks: {
          init: async () => {
            throw new Error('init failed');
          },
        },
      },
    ];
    const ctx = makeCtx({
      executionId: 'exec-diag',
    });
    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].layerId).toBe('broken');
    expect(errors[0].hook).toBe('init');
    assert(errors[0].error instanceof Error);
    expect(errors[0].error.message).toBe('init failed');
  });

  it('diagnostic callback invoked on recall error', async () => {
    const errors: {
      layerId: string;
      hook: string;
    }[] = [];
    const store = createLayerStateStore((layerId, hook) => {
      errors.push({
        layerId,
        hook,
      });
    });

    const layers: MemoryLayer[] = [
      {
        id: 'recall-fail',
        name: 'RecallFail',
        slot: 100,
        scope: 'thread',
        hooks: {
          recall: async () => {
            throw new Error('recall boom');
          },
        },
      },
    ];
    const ctx = makeCtx({
      executionId: 'exec-diag-recall',
    });
    const results = await recallLayers({
      layers,
      query: 'q',
      ctx,
      log: makeItemLog(),
      budgets: new Map([
        [
          'recall-fail',
          1e3,
        ],
      ]),
      store,
    });
    expect(results).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].hook).toBe('recall');
  });

  it('withTimeout clears timer when promise resolves first', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'fast',
        name: 'Fast',
        slot: 100,
        scope: 'thread',
        timeouts: {
          init: 5e3,
        },
        hooks: {
          init: async () => ({
            state: {
              fast: true,
            },
          }),
        },
      },
    ];
    const ctx = makeCtx({
      executionId: 'exec-timer',
    });
    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });
    // If we get here without hanging, the timer was properly cleaned up
    expect(
      store.get<{
        fast: boolean;
      }>('exec-timer', 'fast'),
    ).toEqual({
      fast: true,
    });
    await disposeLayers({
      layers,
      ctx,
      store,
    });
  });

  it('cleanup is idempotent', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'a',
        name: 'A',
        slot: 100,
        scope: 'thread',
        hooks: {
          init: async () => ({
            state: {
              x: 1,
            },
          }),
        },
      },
    ];
    const ctx = makeCtx({
      executionId: 'exec-cleanup-2',
    });
    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });
    expect(
      store.get<{
        x: number;
      }>('exec-cleanup-2', 'a'),
    ).toEqual({
      x: 1,
    });
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
        id: 'a',
        name: 'A',
        slot: 100,
        scope: 'thread',
        hooks: {
          init: async () => ({
            state: {
              x: 1,
            },
          }),
        },
      },
    ];
    const ctx = makeCtx({
      executionId: 'exec-cleanup',
    });
    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });
    expect(
      store.get<{
        x: number;
      }>('exec-cleanup', 'a'),
    ).toEqual({
      x: 1,
    });
    await disposeLayers({
      layers,
      ctx,
      store,
    });
    expect(store.get('exec-cleanup', 'a')).toBeUndefined();
  });

  it('recall string shorthand wraps in developer message', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'string-layer',
        name: 'String Layer',
        slot: 100,
        scope: 'thread',
        hooks: {
          init: async () => ({
            state: {},
          }),
          recall: async () => '<instructions>Hello</instructions>',
        },
      },
    ];
    const ctx = makeCtx({
      executionId: 'exec-string-recall',
    });
    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });
    const results = await recallLayers({
      layers,
      query: 'q',
      ctx,
      log: makeItemLog(),
      budgets: new Map([
        [
          'string-layer',
          1e3,
        ],
      ]),
      store,
    });
    expect(results).toHaveLength(1);
    expect(results[0].layerId).toBe('string-layer');
    expect(results[0].items).toHaveLength(1);
    expect(results[0].items[0].type).toBe('message');
    expect(results[0].tokenCount).toBeGreaterThan(0);
  });

  it('recall null string shorthand is skipped', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'null-layer',
        name: 'Null Layer',
        slot: 100,
        scope: 'thread',
        hooks: {
          init: async () => ({
            state: {},
          }),
          recall: async () => null,
        },
      },
    ];
    const ctx = makeCtx({
      executionId: 'exec-null-recall',
    });
    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });
    const results = await recallLayers({
      layers,
      query: 'q',
      ctx,
      log: makeItemLog(),
      budgets: new Map([
        [
          'null-layer',
          1e3,
        ],
      ]),
      store,
    });
    expect(results).toHaveLength(0);
  });
});
