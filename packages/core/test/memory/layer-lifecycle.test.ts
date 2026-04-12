import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import {
  completeLayers,
  createLayerStateStore,
  disposeLayers,
  executeRerender,
  initLayers,
  recallLayers,
  runAppendPipeline,
  storeLayers,
} from '../../src/memory/layer-lifecycle';
import type { LLMResponse } from '../../src/types/common';
import type { Item } from '../../src/types/items';
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

describe('runAppendPipeline', () => {
  function makeUserMessage(text: string): Item {
    return {
      id: crypto.randomUUID(),
      type: 'message',
      role: 'user',
      status: 'completed',
      content: [{ type: 'input_text', text }],
    };
  }

  it('passes items through when no layers have onItemAppend', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'no-hook',
        name: 'NoHook',
        slot: 100,
        scope: 'execution',
        hooks: {},
      },
    ];
    const ctx = makeCtx({ executionId: 'exec-no-hook' });
    const items = [makeUserMessage('hello')];

    const result = await runAppendPipeline({
      layers,
      items,
      ctx,
      log: makeItemLog(),
      store,
    });

    expect(result.items).toHaveLength(1);
    expect(result.rerenderRequests).toHaveLength(0);
  });

  it('runs pipeline in slot order', async () => {
    const store = createLayerStateStore();
    const order: string[] = [];

    const layers: MemoryLayer[] = [
      {
        id: 'high',
        name: 'High',
        slot: 300,
        scope: 'execution',
        hooks: {
          onItemAppend: async ({ items }) => {
            order.push('high');
            return { items };
          },
        },
      },
      {
        id: 'low',
        name: 'Low',
        slot: 100,
        scope: 'execution',
        hooks: {
          onItemAppend: async ({ items }) => {
            order.push('low');
            return { items };
          },
        },
      },
    ];

    const ctx = makeCtx({ executionId: 'exec-order' });
    const items = [makeUserMessage('hello')];

    await runAppendPipeline({
      layers,
      items,
      ctx,
      log: makeItemLog(),
      store,
    });

    expect(order).toEqual(['low', 'high']);
  });

  it('filters items when layer returns empty array', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'filter',
        name: 'Filter',
        slot: 100,
        scope: 'execution',
        hooks: {
          onItemAppend: async () => ({ items: [] }),
        },
      },
    ];

    const ctx = makeCtx({ executionId: 'exec-filter' });
    const items = [makeUserMessage('hello')];

    const result = await runAppendPipeline({
      layers,
      items,
      ctx,
      log: makeItemLog(),
      store,
    });

    expect(result.items).toHaveLength(0);
  });

  it('transforms items through pipeline', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'transform',
        name: 'Transform',
        slot: 100,
        scope: 'execution',
        hooks: {
          onItemAppend: async ({ items }) => {
            const transformed = items.map((item) => ({
              ...item,
              id: `transformed-${item.id}`,
            }));
            return { items: transformed };
          },
        },
      },
    ];

    const ctx = makeCtx({ executionId: 'exec-transform' });
    const items = [makeUserMessage('hello')];

    const result = await runAppendPipeline({
      layers,
      items,
      ctx,
      log: makeItemLog(),
      store,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toMatch(/^transformed-/);
  });

  it('injects additional items', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'inject',
        name: 'Inject',
        slot: 100,
        scope: 'execution',
        hooks: {
          onItemAppend: async ({ items }) => {
            const extra = makeUserMessage('injected');
            return { items: [...items, extra] };
          },
        },
      },
    ];

    const ctx = makeCtx({ executionId: 'exec-inject' });
    const items = [makeUserMessage('original')];

    const result = await runAppendPipeline({
      layers,
      items,
      ctx,
      log: makeItemLog(),
      store,
    });

    expect(result.items).toHaveLength(2);
  });

  it('updates layer state', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer<{ count: number }>[] = [
      {
        id: 'stateful',
        name: 'Stateful',
        slot: 100,
        scope: 'execution',
        hooks: {
          init: async () => ({ state: { count: 0 } }),
          onItemAppend: async ({ items, state }) => ({
            items,
            state: { count: state.count + items.length },
          }),
        },
      },
    ];

    const ctx = makeCtx({ executionId: 'exec-stateful' });
    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });

    const items = [makeUserMessage('hello')];
    await runAppendPipeline({
      layers,
      items,
      ctx,
      log: makeItemLog(),
      store,
    });

    const state = store.get<{ count: number }>('exec-stateful', 'stateful');
    expect(state?.count).toBe(1);
  });

  it('collects re-render requests', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'rerender',
        name: 'Rerender',
        slot: 100,
        scope: 'execution',
        hooks: {
          onItemAppend: async ({ items }) => ({
            items,
            rerender: true,
            scope: 'self',
          }),
        },
      },
    ];

    const ctx = makeCtx({ executionId: 'exec-rerender' });
    const items = [makeUserMessage('hello')];

    const result = await runAppendPipeline({
      layers,
      items,
      ctx,
      log: makeItemLog(),
      store,
    });

    expect(result.rerenderRequests).toHaveLength(1);
    expect(result.rerenderRequests[0].layerId).toBe('rerender');
    expect(result.rerenderRequests[0].scope).toBe('self');
  });

  it('uses layer rerenderTiming as default', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'immediate-layer',
        name: 'ImmediateLayer',
        slot: 100,
        scope: 'execution',
        rerenderTiming: 'immediate',
        hooks: {
          onItemAppend: async ({ items }) => ({
            items,
            rerender: true,
          }),
        },
      },
    ];

    const ctx = makeCtx({ executionId: 'exec-timing' });
    const items = [makeUserMessage('hello')];

    const result = await runAppendPipeline({
      layers,
      items,
      ctx,
      log: makeItemLog(),
      store,
    });

    expect(result.rerenderRequests[0].timing).toBe('immediate');
  });

  it('stops pipeline when all items filtered', async () => {
    const store = createLayerStateStore();
    let secondCalled = false;

    const layers: MemoryLayer[] = [
      {
        id: 'filter-all',
        name: 'FilterAll',
        slot: 100,
        scope: 'execution',
        hooks: {
          onItemAppend: async () => ({ items: [] }),
        },
      },
      {
        id: 'second',
        name: 'Second',
        slot: 200,
        scope: 'execution',
        hooks: {
          onItemAppend: async ({ items }) => {
            secondCalled = true;
            return { items };
          },
        },
      },
    ];

    const ctx = makeCtx({ executionId: 'exec-stop' });
    const items = [makeUserMessage('hello')];

    await runAppendPipeline({
      layers,
      items,
      ctx,
      log: makeItemLog(),
      store,
    });

    expect(secondCalled).toBe(false);
  });

  it('handles errors gracefully and passes items through', async () => {
    const errors: { layerId: string; hook: string }[] = [];
    const store = createLayerStateStore((layerId, hook) => {
      errors.push({ layerId, hook });
    });

    const layers: MemoryLayer[] = [
      {
        id: 'error-layer',
        name: 'ErrorLayer',
        slot: 100,
        scope: 'execution',
        hooks: {
          onItemAppend: async () => {
            throw new Error('boom');
          },
        },
      },
    ];

    const ctx = makeCtx({ executionId: 'exec-error' });
    const items = [makeUserMessage('hello')];

    const result = await runAppendPipeline({
      layers,
      items,
      ctx,
      log: makeItemLog(),
      store,
    });

    // Items should pass through on error
    expect(result.items).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].hook).toBe('onItemAppend');
  });

  it('skips disabled layers (init failed)', async () => {
    const store = createLayerStateStore();
    let hookCalled = false;

    const layers: MemoryLayer[] = [
      {
        id: 'disabled',
        name: 'Disabled',
        slot: 100,
        scope: 'execution',
        hooks: {
          init: async () => {
            throw new Error('init failed');
          },
          onItemAppend: async ({ items }) => {
            hookCalled = true;
            return { items };
          },
        },
      },
    ];

    const ctx = makeCtx({ executionId: 'exec-disabled' });
    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });

    const items = [makeUserMessage('hello')];
    await runAppendPipeline({
      layers,
      items,
      ctx,
      log: makeItemLog(),
      store,
    });

    expect(hookCalled).toBe(false);
  });

  it('times out slow onItemAppend hooks', async () => {
    const errors: { layerId: string; hook: string }[] = [];
    const store = createLayerStateStore((layerId, hook) => {
      errors.push({ layerId, hook });
    });

    const layers: MemoryLayer[] = [
      {
        id: 'slow',
        name: 'Slow',
        slot: 100,
        scope: 'execution',
        timeouts: {
          onItemAppend: 50, // 50ms timeout
        },
        hooks: {
          onItemAppend: async ({ items }) => {
            // This will take longer than the timeout
            await new Promise((r) => setTimeout(r, 200));
            return { items };
          },
        },
      },
    ];

    const ctx = makeCtx({ executionId: 'exec-timeout' });
    const items = [makeUserMessage('hello')];

    const result = await runAppendPipeline({
      layers,
      items,
      ctx,
      log: makeItemLog(),
      store,
    });

    // Items should pass through when timeout occurs
    expect(result.items).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].layerId).toBe('slow');
    expect(errors[0].hook).toBe('onItemAppend');
  });
});

describe('executeRerender', () => {
  it('returns empty array when no requests', async () => {
    const store = createLayerStateStore();
    const ctx = makeCtx({ executionId: 'exec-empty' });

    const result = await executeRerender({
      requests: [],
      layers: [],
      ctx,
      log: makeItemLog(),
      budgets: new Map(),
      store,
    });

    expect(result).toHaveLength(0);
  });

  it('re-recalls self scope only', async () => {
    const store = createLayerStateStore();
    const recallOrder: string[] = [];

    const layers: MemoryLayer[] = [
      {
        id: 'target',
        name: 'Target',
        slot: 100,
        scope: 'execution',
        hooks: {
          init: async () => ({ state: {} }),
          recall: async () => {
            recallOrder.push('target');
            return { items: [], tokenCount: 0 };
          },
        },
      },
      {
        id: 'other',
        name: 'Other',
        slot: 200,
        scope: 'execution',
        hooks: {
          init: async () => ({ state: {} }),
          recall: async () => {
            recallOrder.push('other');
            return { items: [], tokenCount: 0 };
          },
        },
      },
    ];

    const ctx = makeCtx({ executionId: 'exec-self' });
    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });

    await executeRerender({
      requests: [
        { layerId: 'target', slot: 100, timing: 'immediate', scope: 'self' },
      ],
      layers,
      ctx,
      log: makeItemLog(),
      budgets: new Map([['target', 1e3], ['other', 1e3]]),
      store,
    });

    expect(recallOrder).toEqual(['target']);
  });

  it('re-recalls slot-after scope', async () => {
    const store = createLayerStateStore();
    const recallOrder: string[] = [];

    const layers: MemoryLayer[] = [
      {
        id: 'before',
        name: 'Before',
        slot: 50,
        scope: 'execution',
        hooks: {
          init: async () => ({ state: {} }),
          recall: async () => {
            recallOrder.push('before');
            return { items: [], tokenCount: 0 };
          },
        },
      },
      {
        id: 'target',
        name: 'Target',
        slot: 100,
        scope: 'execution',
        hooks: {
          init: async () => ({ state: {} }),
          recall: async () => {
            recallOrder.push('target');
            return { items: [], tokenCount: 0 };
          },
        },
      },
      {
        id: 'after',
        name: 'After',
        slot: 200,
        scope: 'execution',
        hooks: {
          init: async () => ({ state: {} }),
          recall: async () => {
            recallOrder.push('after');
            return { items: [], tokenCount: 0 };
          },
        },
      },
    ];

    const ctx = makeCtx({ executionId: 'exec-slot-after' });
    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });

    await executeRerender({
      requests: [
        { layerId: 'target', slot: 100, timing: 'immediate', scope: 'slot-after' },
      ],
      layers,
      ctx,
      log: makeItemLog(),
      budgets: new Map([['before', 1e3], ['target', 1e3], ['after', 1e3]]),
      store,
    });

    // Should include target and after, not before
    expect(recallOrder).toEqual(['target', 'after']);
  });

  it('re-recalls all scope', async () => {
    const store = createLayerStateStore();
    const recallOrder: string[] = [];

    const layers: MemoryLayer[] = [
      {
        id: 'first',
        name: 'First',
        slot: 50,
        scope: 'execution',
        hooks: {
          init: async () => ({ state: {} }),
          recall: async () => {
            recallOrder.push('first');
            return { items: [], tokenCount: 0 };
          },
        },
      },
      {
        id: 'second',
        name: 'Second',
        slot: 150,
        scope: 'execution',
        hooks: {
          init: async () => ({ state: {} }),
          recall: async () => {
            recallOrder.push('second');
            return { items: [], tokenCount: 0 };
          },
        },
      },
    ];

    const ctx = makeCtx({ executionId: 'exec-all' });
    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });

    await executeRerender({
      requests: [
        { layerId: 'second', slot: 150, timing: 'immediate', scope: 'all' },
      ],
      layers,
      ctx,
      log: makeItemLog(),
      budgets: new Map([['first', 1e3], ['second', 1e3]]),
      store,
    });

    // Should recall all in slot order
    expect(recallOrder).toEqual(['first', 'second']);
  });
});
