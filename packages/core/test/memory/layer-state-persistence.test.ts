/**
 * M1 — Centralized durable write-through (`createLayerStateStore.set()`).
 *
 * Every state write to a non-execution-scope layer is durably mirrored,
 * regardless of which path produced it (provides functions, onComplete,
 * the append pipeline, …) — `store()` is not special.
 */
import { describe, expect, it } from 'bun:test';
import type { LayerStateStore, MemoryLayer } from '@noetic-tools/memory';
import {
  completeLayers,
  createLayerStateStore,
  disposeLayers,
  initLayers,
  recallLayers,
  runAppendPipeline,
  storeLayers,
} from '@noetic-tools/memory';
import type { StorageAdapter } from '@noetic-tools/types';
import { makeCtx, makeItemLog, makeLLMResponse, makeMessage, makeStorage } from '../_helpers';

interface CounterState {
  n: number;
}

function counterLayer(
  scope: 'thread' | 'execution' = 'thread',
): MemoryLayer<CounterState | undefined> {
  return {
    id: 'counter',
    slot: 100,
    scope,
    hooks: {
      async init({ storage }) {
        const saved = await storage.get<CounterState>('state');
        return {
          state: saved ?? {
            n: 0,
          },
        };
      },
    },
  };
}

interface InitOnParams {
  layer: MemoryLayer<CounterState | undefined>;
  storage: StorageAdapter;
  executionId: string;
  store: LayerStateStore;
}

async function initOn({ layer, storage, executionId, store }: InitOnParams) {
  const ctx = makeCtx({
    executionId,
    threadId: 'shared-thread',
  });
  await initLayers({
    layers: [
      layer,
    ],
    ctx,
    storage,
    store,
  });
  return ctx;
}

describe('M1: durable write-through via LayerStateStore.set()', () => {
  it('state set outside store() (provides-fn path) rehydrates in the next execution', async () => {
    const storage = makeStorage();
    const layer = counterLayer();

    // Execution A: init, then a write that does NOT come from a store() hook —
    // the same path executeLayerFn / harness.setLayerState uses.
    const storeA = createLayerStateStore();
    const ctxA = await initOn({
      layer: layer,
      storage: storage,
      executionId: 'exec-A',
      store: storeA,
    });
    storeA.set<CounterState>(ctxA.executionId, layer.id, {
      n: 42,
    });
    // storeLayers runs after every turn and flushes pending mirror writes,
    // even though this layer has no store() hook.
    await storeLayers({
      layers: [
        layer,
      ],
      response: makeLLMResponse(''),
      ctx: ctxA,
      log: makeItemLog(),
      store: storeA,
    });

    // Execution B (same thread, fresh store): init rehydrates the write.
    const storeB = createLayerStateStore();
    const ctxB = await initOn({
      layer: layer,
      storage: storage,
      executionId: 'exec-B',
      store: storeB,
    });
    expect(storeB.get<CounterState>(ctxB.executionId, layer.id)).toEqual({
      n: 42,
    });
  });

  it('onComplete-returned state is durably persisted', async () => {
    const storage = makeStorage();
    const layer: MemoryLayer<CounterState | undefined> = {
      ...counterLayer(),
      hooks: {
        ...counterLayer().hooks,
        async onComplete({ state }) {
          return {
            state: {
              n: (state?.n ?? 0) + 7,
            },
          };
        },
      },
    };
    const store = createLayerStateStore();
    const ctx = await initOn({
      layer: layer,
      storage: storage,
      executionId: 'exec-complete',
      store: store,
    });
    await completeLayers({
      layers: [
        layer,
      ],
      ctx,
      log: makeItemLog(),
      outcome: 'success',
      store,
    });

    const storeB = createLayerStateStore();
    const ctxB = await initOn({
      layer: layer,
      storage: storage,
      executionId: 'exec-after-complete',
      store: storeB,
    });
    expect(storeB.get<CounterState>(ctxB.executionId, layer.id)).toEqual({
      n: 7,
    });
  });

  it('runAppendPipeline state updates are durably persisted', async () => {
    const storage = makeStorage();
    const layer: MemoryLayer<CounterState | undefined> = {
      ...counterLayer(),
      hooks: {
        ...counterLayer().hooks,
        async onItemAppend({ items, state }) {
          return {
            items,
            state: {
              n: (state?.n ?? 0) + 1,
            },
          };
        },
      },
    };
    const store = createLayerStateStore();
    const ctx = await initOn({
      layer: layer,
      storage: storage,
      executionId: 'exec-append',
      store: store,
    });
    await runAppendPipeline({
      layers: [
        layer,
      ],
      items: [
        makeMessage('user', 'hi'),
      ],
      ctx,
      log: makeItemLog(),
      store,
    });
    // The append pipeline starts the mirror write; flush settles it.
    await store.flush?.(ctx.executionId);

    const storeB = createLayerStateStore();
    const ctxB = await initOn({
      layer: layer,
      storage: storage,
      executionId: 'exec-after-append',
      store: storeB,
    });
    expect(storeB.get<CounterState>(ctxB.executionId, layer.id)).toEqual({
      n: 1,
    });
  });

  it("'execution' scope is NOT durably persisted", async () => {
    const storage = makeStorage();
    const layer = counterLayer('execution');
    const store = createLayerStateStore();
    const ctx = await initOn({
      layer: layer,
      storage: storage,
      executionId: 'exec-scoped',
      store: store,
    });
    store.set<CounterState>(ctx.executionId, layer.id, {
      n: 99,
    });
    await store.flush?.(ctx.executionId);

    const keys = await storage.list('layers/');
    expect(keys).toEqual([]);
  });

  it('coalesces rapid writes — latest value wins durably', async () => {
    const storage = makeStorage();
    const layer = counterLayer();
    const store = createLayerStateStore();
    const ctx = await initOn({
      layer: layer,
      storage: storage,
      executionId: 'exec-coalesce',
      store: store,
    });
    for (let i = 1; i <= 50; i++) {
      store.set<CounterState>(ctx.executionId, layer.id, {
        n: i,
      });
    }
    await store.flush?.(ctx.executionId);

    const storeB = createLayerStateStore();
    const ctxB = await initOn({
      layer: layer,
      storage: storage,
      executionId: 'exec-after-coalesce',
      store: storeB,
    });
    expect(storeB.get<CounterState>(ctxB.executionId, layer.id)).toEqual({
      n: 50,
    });
  });

  it('failing storage reports a persist diagnostic and never throws', async () => {
    const diagnostics: string[] = [];
    const failing: StorageAdapter = {
      ...makeStorage(),
      set: async () => {
        throw new Error('disk full');
      },
    };
    const store = createLayerStateStore((layerId, hook) => {
      diagnostics.push(`${layerId}:${hook}`);
    });
    const layer = counterLayer();
    const ctx = await initOn({
      layer: layer,
      storage: failing,
      executionId: 'exec-failing',
      store: store,
    });

    expect(() =>
      store.set<CounterState>(ctx.executionId, layer.id, {
        n: 1,
      }),
    ).not.toThrow();
    await store.flush?.(ctx.executionId);
    expect(diagnostics).toContain('counter:persist');
    // In-memory state is intact despite the durable failure.
    expect(store.get<CounterState>(ctx.executionId, layer.id)).toEqual({
      n: 1,
    });
  });

  it('clearing state (set undefined) deletes the durable key — next init gets default', async () => {
    const storage = makeStorage();
    // TState widened to include undefined: clearing via `{ state: undefined }`
    // is only type-legal when the layer opts into an undefined-able state.
    const base = counterLayer();
    const layer: MemoryLayer<CounterState | undefined> = {
      ...base,
      hooks: {
        ...base.hooks,
        async store() {
          return {
            state: undefined,
          };
        },
      },
    };

    // Execution A: persist a value, then clear it via the store() hook.
    const storeA = createLayerStateStore();
    const ctxA = await initOn({
      layer: layer,
      storage: storage,
      executionId: 'exec-clear-a',
      store: storeA,
    });
    storeA.set<CounterState>(ctxA.executionId, layer.id, {
      n: 5,
    });
    await storeA.flush?.(ctxA.executionId);
    expect((await storage.list('layers/')).length).toBe(1);

    await storeLayers({
      layers: [
        layer,
      ],
      response: makeLLMResponse(''),
      ctx: ctxA,
      log: makeItemLog(),
      store: storeA,
    });
    expect(await storage.list('layers/')).toEqual([]);

    // Execution B: init falls back to the default.
    const storeB = createLayerStateStore();
    const ctxB = await initOn({
      layer: layer,
      storage: storage,
      executionId: 'exec-clear-b',
      store: storeB,
    });
    expect(storeB.get<CounterState>(ctxB.executionId, layer.id)).toEqual({
      n: 0,
    });
  });

  it('disposeLayers flushes pending mirror writes before cleanup', async () => {
    const storage = makeStorage();
    const layer = counterLayer();
    const store = createLayerStateStore();
    const ctx = await initOn({
      layer: layer,
      storage: storage,
      executionId: 'exec-dispose',
      store: store,
    });
    store.set<CounterState>(ctx.executionId, layer.id, {
      n: 13,
    });
    await disposeLayers({
      layers: [
        layer,
      ],
      ctx,
      store,
    });

    const storeB = createLayerStateStore();
    const ctxB = await initOn({
      layer: layer,
      storage: storage,
      executionId: 'exec-after-dispose',
      store: storeB,
    });
    expect(storeB.get<CounterState>(ctxB.executionId, layer.id)).toEqual({
      n: 13,
    });
  });

  it('rehydrated init state is not rewritten to storage (registration follows init)', async () => {
    const storage = makeStorage();
    let writes = 0;
    const counting: StorageAdapter = {
      ...storage,
      set: async (key, value) => {
        writes++;
        return storage.set(key, value);
      },
    };
    const layer = counterLayer();

    const storeA = createLayerStateStore();
    const ctxA = await initOn({
      layer: layer,
      storage: counting,
      executionId: 'exec-w1',
      store: storeA,
    });
    storeA.set<CounterState>(ctxA.executionId, layer.id, {
      n: 1,
    });
    await storeA.flush?.(ctxA.executionId);
    expect(writes).toBe(1);

    // Execution B only rehydrates — no new write may hit storage.
    const storeB = createLayerStateStore();
    const ctxB = await initOn({
      layer: layer,
      storage: counting,
      executionId: 'exec-w2',
      store: storeB,
    });
    await storeB.flush?.(ctxB.executionId);
    expect(writes).toBe(1);
    expect(storeB.get<CounterState>(ctxB.executionId, layer.id)).toEqual({
      n: 1,
    });
  });

  it('layers without recall/store hooks still mirror writes (recallLayers unaffected)', async () => {
    const storage = makeStorage();
    const layer = counterLayer();
    const store = createLayerStateStore();
    const ctx = await initOn({
      layer: layer,
      storage: storage,
      executionId: 'exec-norecall',
      store: store,
    });
    const results = await recallLayers({
      layers: [
        layer,
      ],
      query: '',
      ctx,
      log: makeItemLog(),
      budgets: new Map(),
      store,
    });
    expect(results).toEqual([]);
  });
});
