import { describe, expect, it } from 'bun:test';
import {
  completeLayers,
  createLayerStateStore,
  disposeLayers,
  initLayers,
  recallLayers,
  storeLayers,
} from '../../src/memory/layer-lifecycle';
import type { LLMResponse } from '../../src/types/common';
import type { MemoryLayer } from '../../src/types/memory';
import { makeCtx, makeItemLog, makeStorage } from '../_helpers';

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
    expect((errors[0].error as Error).message).toBe('init failed');
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
});
