/**
 * REGRESSION SUITE — memory layer lifecycle orchestrator.
 *
 * Each test encodes the EXPECTED-CORRECT behavior. These began as an adversarial
 * audit (originally failing-by-design to prove the bugs); the bugs are now fixed,
 * so the suite passes and guards against regressions.
 *
 * Run: bun test test/memory/_audit/lifecycle.test.ts
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  allocateBudgets,
  assembleView,
  completeLayers,
  createLayerStateStore,
  disposeLayers,
  initLayers,
  recallLayers,
  returnLayers,
  runAppendPipeline,
  spawnLayers,
  storeLayers,
} from '@noetic-tools/memory';
import type { Item, MemoryLayer } from '@noetic-tools/types';
import {
  makeCtx,
  makeItemLog,
  makeLLMResponse,
  makeMessage,
  makeStorage,
  sleep,
} from '../../_helpers';

//#region Local helpers

const GLOBAL_CONTEXT_CAP = 1e6; // a generous 1M-token window

/** Build a per-layer recall budget map the way the runtime does. */
function budgetsFor(ls: MemoryLayer[]): Map<string, number> {
  const { allocations } = allocateBudgets({
    layers: ls,
    totalBudget: 1e5,
    systemPromptTokens: 0,
    responseReserve: 0,
  });
  return new Map(
    allocations.map((a) => [
      a.layerId,
      a.allocated,
    ]),
  );
}

//#endregion

//#region Finding 1 — DEAD BUDGET ALLOCATOR

describe('AUDIT-1 budget allocator (allocateBudgets wired into recall)', () => {
  function budgetMap(layers: MemoryLayer[], totalBudget: number): Map<string, number> {
    const { allocations } = allocateBudgets({
      layers,
      totalBudget,
      systemPromptTokens: 0,
      responseReserve: 0,
    });
    return new Map(
      allocations.map((a) => [
        a.layerId,
        a.allocated,
      ]),
    );
  }

  it('1a: recall budget RESPECTS `min` (two layers, same max, very different min → different budget)', () => {
    const layers: MemoryLayer[] = [
      {
        id: 'low-min',
        slot: 0,
        scope: 'execution',
        budget: {
          min: 1,
          max: 16000,
        },
        hooks: {},
      },
      {
        id: 'high-min',
        slot: 1,
        scope: 'execution',
        budget: {
          min: 15999,
          max: 16000,
        },
        hooks: {},
      },
    ];
    const budgets = budgetMap(layers, 20000);
    // A layer reserving a much larger floor must receive more than one reserving
    // almost nothing.
    expect(budgets.get('high-min')).toBeGreaterThan(budgets.get('low-min') ?? 0);
  });

  it('1b: N "auto" layers stay BOUNDED by the context window', () => {
    const layers: MemoryLayer[] = Array.from(
      {
        length: 100,
      },
      (_, i) => ({
        id: `auto-${i}`,
        slot: i,
        scope: 'execution',
        budget: 'auto',
        hooks: {},
      }),
    );
    const budgets = budgetMap(layers, GLOBAL_CONTEXT_CAP);
    const total = [
      ...budgets.values(),
    ].reduce((a, b) => a + b, 0);
    // Total recall budget is bounded by the context window, never unbounded.
    expect(total).toBeLessThanOrEqual(GLOBAL_CONTEXT_CAP);
  });
});

//#endregion

//#region Finding 2 — DEAD RE-RENDER

describe('AUDIT-2 dead re-render', () => {
  it('2a: runAppendPipeline DOES collect a rerender request (capability exists)', async () => {
    const store = createLayerStateStore();
    const layers: MemoryLayer[] = [
      {
        id: 'rr',
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
    const result = await runAppendPipeline({
      layers,
      items: [
        makeMessage('user', 'hi'),
      ],
      ctx: makeCtx({
        executionId: 'rr-1',
      }),
      log: makeItemLog(),
      store,
    });
    expect(result.rerenderRequests).toHaveLength(1);
  });

  it('2b: the interpreter DISCARDS rerenderRequests and never calls executeRerender', () => {
    const src = readFileSync(
      new URL('../../../src/interpreter/execute-action.ts', import.meta.url),
      'utf-8',
    );
    // runInputPipeline destructures ONLY `items` from runAppendPipeline.
    const dropsRerender =
      /const\s*\{\s*items:\s*finalItems\s*\}\s*=\s*await\s+ctx\.harness\.runAppendPipeline/.test(
        src,
      );
    const callsExecuteRerender = /executeRerender/.test(src);
    // CORRECT: the interpreter must consume rerenderRequests (call executeRerender).
    // Current code drops them and never re-renders → these assertions fail.
    expect(dropsRerender).toBe(false);
    expect(callsExecuteRerender).toBe(true);
  });
});

//#endregion

//#region Finding 3 — ASSEMBLEVIEW HAS NO TOKEN CAP

describe('AUDIT-3 assembleView token cap', () => {
  it('3a: a policy caps the assembled view, keeping the most recent turn', () => {
    const history: Item[] = Array.from(
      {
        length: 1000,
      },
      (_, i) => makeMessage('user', `msg-${i}`),
    );
    const view = assembleView({
      systemPromptItems: [],
      layerOutputItems: [],
      historyItems: history,
      policy: {
        tokenBudget: 200,
        responseReserve: 0,
        overflow: 'sliding_window',
      },
    });
    // The assembled view is bounded by the token budget...
    expect(view.length).toBeLessThan(1000);
    // ...and retains the most recent turn rather than the oldest.
    expect(view.at(-1)).toBe(history.at(-1));
  });

  it('3b: NEW — overflow:"truncate" / tokenBudget are IGNORED (only sliding_window is implemented)', () => {
    const history: Item[] = Array.from(
      {
        length: 500,
      },
      (_, i) => makeMessage('user', `msg-${i}`),
    );
    const view = assembleView({
      systemPromptItems: [],
      layerOutputItems: [],
      historyItems: history,
      policy: {
        tokenBudget: 100,
        responseReserve: 0,
        overflow: 'truncate',
      },
    });
    // CORRECT: 'truncate' with a 100-token budget must drop items. Current code
    // only branches on 'sliding_window' → 'truncate' is a silent no-op.
    expect(view.length).toBeLessThan(500);
  });
});

//#endregion

//#region Finding 4 — INIT-FAILURE SILENT DISABLE

describe('AUDIT-4 init-failure policy', () => {
  function failingLayer(onInitError?: 'throw' | 'disable'): MemoryLayer {
    return {
      id: 'transient',
      slot: 100,
      scope: 'thread',
      onInitError,
      hooks: {
        init: async () => {
          throw new Error('transient network blip');
        },
        recall: async () => ({
          items: [],
          tokenCount: 0,
        }),
      },
    };
  }

  it('4a: init failure is fail-loud by default (error surfaced, not swallowed)', async () => {
    const store = createLayerStateStore();
    const layers = [
      failingLayer(),
    ];
    const ctx = makeCtx({
      executionId: 'exec-transient',
    });
    // CORRECT: a failed init surfaces — memory is load-bearing (and steering
    // would otherwise fail open). The caller sees the rejection.
    expect(
      initLayers({
        layers,
        ctx,
        storage: makeStorage(),
        store,
      }),
    ).rejects.toThrow('transient network blip');
  });

  it('4b: onInitError "disable" degrades gracefully (no throw; layer skipped)', async () => {
    const store = createLayerStateStore();
    let recallCalled = false;
    const layer = failingLayer('disable');
    layer.hooks.recall = async () => {
      recallCalled = true;
      return {
        items: [],
        tokenCount: 0,
      };
    };
    const ctx = makeCtx({
      executionId: 'exec-transient-disable',
    });
    // Does not throw — the layer is disabled for the execution.
    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage: makeStorage(),
      store,
    });
    await recallLayers({
      layers: [
        layer,
      ],
      query: 'q',
      ctx,
      log: makeItemLog(),
      budgets: budgetsFor([
        layer,
      ]),
      store,
    });
    // A disabled layer's recall is intentionally skipped.
    expect(recallCalled).toBe(false);
  });
});

//#endregion

//#region Finding 5 — INCONSISTENT DISABLED-CHECK (onComplete / dispose run with undefined state)

describe('AUDIT-5 onComplete/dispose run with undefined state for init-failed layer', () => {
  it('5a: onComplete is invoked with state === undefined after init failure', async () => {
    const store = createLayerStateStore();
    let completeState: unknown = 'NOT_CALLED';
    const layers: MemoryLayer[] = [
      {
        id: 'l',
        slot: 100,
        scope: 'thread',
        onInitError: 'disable',
        hooks: {
          init: async () => {
            throw new Error('init boom');
          },
          onComplete: async ({ state }) => {
            completeState = state;
            return undefined;
          },
        },
      },
    ];
    const ctx = makeCtx({
      executionId: 'exec-complete-undef',
    });
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

    // recall/store would have SKIPPED this layer; onComplete does not — it runs
    // with undefined state (crash hazard inside real hooks).
    // CORRECT (consistent with recall/store): onComplete must be skipped, so the
    // captured sentinel should remain untouched.
    expect(completeState).toBe('NOT_CALLED');
  });

  it('5b: dispose is invoked with state === undefined after init failure', async () => {
    const store = createLayerStateStore();
    let disposeState: unknown = 'NOT_CALLED';
    const layers: MemoryLayer[] = [
      {
        id: 'l',
        slot: 100,
        scope: 'thread',
        onInitError: 'disable',
        hooks: {
          init: async () => {
            throw new Error('init boom');
          },
          dispose: async ({ state }) => {
            disposeState = state;
          },
        },
      },
    ];
    const ctx = makeCtx({
      executionId: 'exec-dispose-undef',
    });
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

    // CORRECT (consistent with the rest of the lifecycle): dispose must be
    // skipped for an init-failed layer.
    expect(disposeState).toBe('NOT_CALLED');
  });
});

//#endregion

//#region Finding 6 — withTimeout has NO cancellation

describe('AUDIT-6 withTimeout', () => {
  it('6: a timed-out recall surfaces a diagnostic and never writes its late state', async () => {
    const diagnostics: string[] = [];
    const store = createLayerStateStore((id, hook) => diagnostics.push(`${id}:${hook}`));
    let lateBodyRan = false;
    const layers: MemoryLayer[] = [
      {
        id: 'slow',
        slot: 100,
        scope: 'thread',
        timeouts: {
          recall: 30,
        },
        hooks: {
          init: async () => ({
            state: {
              v: 'initial',
            },
          }),
          recall: async () => {
            await sleep(120);
            lateBodyRan = true; // proves the orphaned promise kept executing
            return {
              items: [],
              tokenCount: 0,
              state: {
                v: 'late-write',
              },
            };
          },
        },
      },
    ];
    const ctx = makeCtx({
      executionId: 'exec-timeout',
    });
    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });
    await recallLayers({
      layers,
      query: 'q',
      ctx,
      log: makeItemLog(),
      budgets: budgetsFor(layers),
      store,
    });

    // Wait past the hook's real completion.
    await sleep(150);

    // The timeout is surfaced as a diagnostic (not swallowed silently).
    expect(diagnostics).toContain('slow:recall');

    // The lifecycle does NOT persist the late state — it stays 'initial'. This
    // is the real safety guarantee: a timed-out hook's late resolution cannot
    // corrupt layer state.
    expect(
      store.get<{
        v: string;
      }>('exec-timeout', 'slow'),
    ).toEqual({
      v: 'initial',
    });

    // Accepted limitation: JS cannot force-cancel an in-flight user promise, so
    // the orphaned hook body may still run to completion. We assert the body did
    // execute to document this (cooperative AbortSignal cancellation is future work).
    expect(lateBodyRan).toBe(true);
  });
});

//#endregion

//#region Extra probes

describe('AUDIT-EXTRA', () => {
  it('E1: a layer CAN clear its state to undefined via store and stays active', async () => {
    const store = createLayerStateStore();
    const layer: MemoryLayer<
      | {
          n: number;
        }
      | undefined
    > = {
      id: 'clearable',
      slot: 100,
      scope: 'execution',
      hooks: {
        init: async () => ({
          state: {
            n: 1,
          },
        }),
        store: async () => ({
          state: undefined,
        }),
      },
    };
    const ctx = makeCtx({
      executionId: 'exec-clear',
    });
    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage: makeStorage(),
      store,
    });
    await storeLayers({
      layers: [
        layer,
      ],
      response: makeLLMResponse(''),
      ctx,
      log: makeItemLog(),
      store,
      storage: makeStorage(),
    });
    // Returning {state: undefined} clears the state…
    expect(store.get('exec-clear', 'clearable')).toBeUndefined();
    // …and the layer is NOT considered disabled — cleared and disabled are
    // tracked separately (explicit `isDisabled` on the store).
    expect(store.isDisabled?.('exec-clear', 'clearable')).toBe(false);
  });

  it('E2: onComplete CAN clear state (uses `in`) — inconsistent with every other hook', async () => {
    const store = createLayerStateStore();
    const layer: MemoryLayer<
      | {
          n: number;
        }
      | undefined
    > = {
      id: 'oc',
      slot: 100,
      scope: 'execution',
      hooks: {
        init: async () => ({
          state: {
            n: 1,
          },
        }),
        onComplete: async () => ({
          state: undefined,
        }),
      },
    };
    const ctx = makeCtx({
      executionId: 'exec-oc-clear',
    });
    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage: makeStorage(),
      store,
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
    // Demonstration (PASSES): onComplete uses `'state' in result`, so it clears
    // state to undefined — the opposite of E1's store hook. Documents the
    // inconsistent update semantics across hooks.
    expect(store.get('exec-oc-clear', 'oc')).toBeUndefined();
  });

  it('E3: onReturn merge is silently DROPPED when parentState is undefined', async () => {
    const store = createLayerStateStore();
    let returnCalled = false;
    const layer: MemoryLayer = {
      id: 'merge',
      slot: 100,
      scope: 'execution',
      hooks: {
        onReturn: async ({ parentState }) => {
          returnCalled = true;
          return {
            parentState,
          };
        },
      },
    };
    const parentCtx = makeCtx({
      executionId: 'parent',
    });
    const childCtx = makeCtx({
      executionId: 'child',
    });
    // Child produced state; parent never initialized any.
    store.set(childCtx.executionId, 'merge', {
      contributed: true,
    });
    await returnLayers({
      layers: [
        layer,
      ],
      parentCtx,
      childCtx,
      childLog: makeItemLog(),
      result: {},
      store,
    });
    // CORRECT: the child's contribution should reach onReturn so it can seed the
    // parent. Current code requires BOTH states defined → merge lost.
    expect(returnCalled).toBe(true);
  });

  it('E4: onSpawn is skipped for an init-LESS layer (parentState undefined), yet recall runs for the same layer', async () => {
    const store = createLayerStateStore();
    let spawnCalled = false;
    let recallCalled = false;
    const layer: MemoryLayer = {
      id: 'no-init',
      slot: 100,
      scope: 'execution',
      // No init hook → "enabled" everywhere that checks `state === undefined && hooks.init`.
      hooks: {
        onSpawn: async ({ parentState }) => {
          spawnCalled = true;
          return {
            childState: parentState ?? {
              bootstrapped: true,
            },
          };
        },
        recall: async () => {
          recallCalled = true;
          return {
            items: [],
            tokenCount: 0,
          };
        },
      },
    };
    const parentCtx = makeCtx({
      executionId: 'p2',
    });
    const childCtx = makeCtx({
      executionId: 'c2',
    });

    await spawnLayers({
      layers: [
        layer,
      ],
      parentCtx,
      childCtx,
      store,
    });
    await recallLayers({
      layers: [
        layer,
      ],
      query: 'q',
      ctx: parentCtx,
      log: makeItemLog(),
      budgets: budgetsFor([
        layer,
      ]),
      store,
    });

    // recall runs for the init-less layer (state undefined is allowed)...
    expect(recallCalled).toBe(true);
    // ...but onSpawn does NOT, because it bails on `parentState === undefined`
    // without the `&& hooks.init` qualifier. CORRECT: consistent treatment →
    // onSpawn should also run for an init-less layer. This FAILS.
    expect(spawnCalled).toBe(true);
  });

  it('E5: recall slot-sort is STABLE for equal slots (insertion order preserved) — no bug', async () => {
    const store = createLayerStateStore();
    const order: string[] = [];
    const mk = (id: string): MemoryLayer => ({
      id,
      slot: 100,
      scope: 'execution',
      hooks: {
        recall: async () => {
          order.push(id);
          return {
            items: [],
            tokenCount: 0,
          };
        },
      },
    });
    const layers = [
      mk('x'),
      mk('y'),
      mk('z'),
    ];
    await recallLayers({
      layers,
      query: 'q',
      ctx: makeCtx({
        executionId: 'stable',
      }),
      log: makeItemLog(),
      budgets: budgetsFor(layers),
      store,
    });
    // PASSES: documents that equal-slot ties keep array order (stable sort).
    expect(order).toEqual([
      'x',
      'y',
      'z',
    ]);
  });
});

//#endregion
