/**
 * M10 — Explicit disabled-layer tracking.
 *
 * `{ state: undefined }` no longer permanently disables init-bearing layers:
 * disabled is an explicit flag set only when `init` fails with
 * `onInitError: 'disable'`. Cleared layers keep running with undefined state.
 */
import { describe, expect, it } from 'bun:test';
import type { LayerStateStore, MemoryLayer } from '@noetic-tools/memory';
import {
  afterModelCallLayers,
  beforeToolCallLayers,
  completeLayers,
  createLayerStateStore,
  disposeLayers,
  initLayers,
  projectHistoryLayers,
  recallLayers,
  returnLayers,
  runAppendPipeline,
  spawnLayers,
  storeLayers,
} from '@noetic-tools/memory';
import { SteeringAction } from '@noetic-tools/types';
import { makeCtx, makeItemLog, makeLLMResponse, makeMessage, makeStorage } from '../_helpers';

type State =
  | {
      n: number;
    }
  | undefined;

interface HookCalls {
  recall: number;
  store: number;
  dispose: number;
  onSpawn: number;
  onComplete: number;
  beforeToolCall: number;
  afterModelCall: number;
  projectHistory: number;
  onItemAppend: number;
}

function makeTrackedLayer(opts: { failInit?: boolean; clearOnStore?: boolean }): {
  layer: MemoryLayer<State>;
  calls: HookCalls;
} {
  const calls: HookCalls = {
    recall: 0,
    store: 0,
    dispose: 0,
    onSpawn: 0,
    onComplete: 0,
    beforeToolCall: 0,
    afterModelCall: 0,
    projectHistory: 0,
    onItemAppend: 0,
  };
  const layer: MemoryLayer<State> = {
    id: 'tracked',
    slot: 100,
    scope: 'execution',
    onInitError: 'disable',
    hooks: {
      init: async () => {
        if (opts.failInit) {
          throw new Error('init boom');
        }
        return {
          state: {
            n: 1,
          },
        };
      },
      recall: async () => {
        calls.recall++;
        return 'recalled';
      },
      store: async () => {
        calls.store++;
        if (opts.clearOnStore) {
          return {
            state: undefined,
          };
        }
        return undefined;
      },
      dispose: async () => {
        calls.dispose++;
      },
      onSpawn: async () => {
        calls.onSpawn++;
        return {
          childState: {
            n: 0,
          },
        };
      },
      onComplete: async () => {
        calls.onComplete++;
        return undefined;
      },
      beforeToolCall: async () => {
        calls.beforeToolCall++;
        return {
          decision: {
            action: SteeringAction.Allow,
          },
        };
      },
      afterModelCall: async () => {
        calls.afterModelCall++;
        return {
          decision: {
            action: SteeringAction.Allow,
          },
        };
      },
      projectHistory: async ({ items }) => {
        calls.projectHistory++;
        return {
          items,
        };
      },
      onItemAppend: async ({ items }) => {
        calls.onItemAppend++;
        return {
          items,
        };
      },
    },
  };
  return {
    layer,
    calls,
  };
}

interface RunAllHooksParams {
  layer: MemoryLayer<State>;
  store: LayerStateStore;
  executionId: string;
}

/** Drive every post-init lifecycle gate once. */
async function runAllHooks({ layer, store, executionId }: RunAllHooksParams): Promise<void> {
  const ctx = makeCtx({
    executionId,
  });
  const childCtx = makeCtx({
    executionId: `${executionId}-child`,
  });
  const layers = [
    layer,
  ];
  const log = makeItemLog();
  await recallLayers({
    layers,
    query: '',
    ctx,
    log,
    budgets: new Map(),
    store,
  });
  await storeLayers({
    layers,
    response: makeLLMResponse(''),
    ctx,
    log,
    store,
  });
  await beforeToolCallLayers({
    layers,
    toolName: 't',
    toolArgs: {},
    ctx,
    store,
  });
  await afterModelCallLayers({
    layers,
    response: makeLLMResponse(''),
    ctx,
    store,
  });
  await projectHistoryLayers({
    layers,
    items: [],
    ctx,
    store,
  });
  await runAppendPipeline({
    layers,
    items: [
      makeMessage('user', 'hi'),
    ],
    ctx,
    log,
    store,
  });
  await spawnLayers({
    layers,
    parentCtx: ctx,
    childCtx,
    store,
  });
  await completeLayers({
    layers,
    ctx,
    log,
    outcome: 'success',
    store,
  });
  await disposeLayers({
    layers,
    ctx,
    store,
  });
}

describe('M10: explicit disabled-layer tracking', () => {
  it('onInitError-disabled layer is skipped by every hook gate', async () => {
    const { layer, calls } = makeTrackedLayer({
      failInit: true,
    });
    const store = createLayerStateStore();
    const ctx = makeCtx({
      executionId: 'exec-disabled',
    });
    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage: makeStorage(),
      store,
    });
    expect(store.isDisabled?.('exec-disabled', 'tracked')).toBe(true);

    await runAllHooks({
      layer,
      store,
      executionId: 'exec-disabled',
    });
    expect(calls).toEqual({
      recall: 0,
      store: 0,
      dispose: 0,
      onSpawn: 0,
      onComplete: 0,
      beforeToolCall: 0,
      afterModelCall: 0,
      projectHistory: 0,
      onItemAppend: 0,
    });
  });

  it('cleared init-bearing layer keeps running (recall + dispose still fire)', async () => {
    const { layer, calls } = makeTrackedLayer({
      clearOnStore: true,
    });
    const store = createLayerStateStore();
    const ctx = makeCtx({
      executionId: 'exec-cleared',
    });
    const layers = [
      layer,
    ];
    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });
    // Turn 1: store() clears the state.
    await storeLayers({
      layers,
      response: makeLLMResponse(''),
      ctx,
      log: makeItemLog(),
      store,
    });
    expect(store.get('exec-cleared', 'tracked')).toBeUndefined();
    expect(store.isDisabled?.('exec-cleared', 'tracked')).toBe(false);

    // Turn 2: recall still runs with undefined state.
    const results = await recallLayers({
      layers,
      query: '',
      ctx,
      log: makeItemLog(),
      budgets: new Map(),
      store,
    });
    expect(calls.recall).toBe(1);
    expect(results.length).toBe(1);

    // Dispose runs exactly once.
    await disposeLayers({
      layers,
      ctx,
      store,
    });
    expect(calls.dispose).toBe(1);
  });

  it('clear → re-init in a fresh execution gets the default state', async () => {
    const storage = makeStorage();
    const layer: MemoryLayer<State> = {
      id: 'cleared-thread',
      slot: 100,
      scope: 'thread',
      hooks: {
        async init({ storage: s }) {
          const saved = await s.get<{
            n: number;
          }>('state');
          return {
            state: saved ?? {
              n: 0,
            },
          };
        },
        async store() {
          return {
            state: undefined,
          };
        },
      },
    };
    const storeA = createLayerStateStore();
    const ctxA = makeCtx({
      executionId: 'exec-ci-a',
      threadId: 'thread-ci',
    });
    await initLayers({
      layers: [
        layer,
      ],
      ctx: ctxA,
      storage,
      store: storeA,
    });
    storeA.set(ctxA.executionId, layer.id, {
      n: 9,
    });
    await storeA.flush?.(ctxA.executionId);
    // Clear — deletes the durable key.
    await storeLayers({
      layers: [
        layer,
      ],
      response: makeLLMResponse(''),
      ctx: ctxA,
      log: makeItemLog(),
      store: storeA,
    });

    const storeB = createLayerStateStore();
    const ctxB = makeCtx({
      executionId: 'exec-ci-b',
      threadId: 'thread-ci',
    });
    await initLayers({
      layers: [
        layer,
      ],
      ctx: ctxB,
      storage,
      store: storeB,
    });
    expect(
      storeB.get<{
        n: number;
      }>(ctxB.executionId, layer.id),
    ).toEqual({
      n: 0,
    });
  });

  it('legacy stores without isDisabled fall back to the old sentinel', async () => {
    const base = createLayerStateStore();
    // A custom store missing the optional disabled-tracking members.
    const legacy: LayerStateStore = {
      get: (e, l) => base.get(e, l),
      set: (e, l, s) => base.set(e, l, s),
      cleanup: (e) => base.cleanup(e),
      diagnostic: () => {},
    };
    const { layer, calls } = makeTrackedLayer({});
    const ctx = makeCtx({
      executionId: 'exec-legacy',
    });
    // No init run → init-bearing layer with no state → legacy sentinel skips.
    const results = await recallLayers({
      layers: [
        layer,
      ],
      query: '',
      ctx,
      log: makeItemLog(),
      budgets: new Map(),
      store: legacy,
    });
    expect(results.length).toBe(0);
    expect(calls.recall).toBe(0);
  });

  it('returnLayers still skips only when the child produced no state', async () => {
    const store = createLayerStateStore();
    let onReturnRan = 0;
    const layer: MemoryLayer<State> = {
      id: 'merger',
      slot: 100,
      scope: 'execution',
      hooks: {
        onReturn: async ({ childState }) => {
          onReturnRan++;
          return {
            parentState: childState,
          };
        },
      },
    };
    const parentCtx = makeCtx({
      executionId: 'exec-parent',
    });
    const childCtx = makeCtx({
      executionId: 'exec-child',
    });
    await returnLayers({
      layers: [
        layer,
      ],
      parentCtx,
      childCtx,
      childLog: makeItemLog(),
      result: 'r',
      store,
    });
    expect(onReturnRan).toBe(0); // no child state → skipped

    store.set(childCtx.executionId, layer.id, {
      n: 3,
    });
    await returnLayers({
      layers: [
        layer,
      ],
      parentCtx,
      childCtx,
      childLog: makeItemLog(),
      result: 'r',
      store,
    });
    expect(onReturnRan).toBe(1);
    expect(
      store.get<{
        n: number;
      }>(parentCtx.executionId, layer.id),
    ).toEqual({
      n: 3,
    });
  });
});
