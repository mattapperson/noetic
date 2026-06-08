/**
 * ADVERSARIAL AUDIT — memory layer lifecycle orchestrator.
 *
 * Each test below encodes the EXPECTED-CORRECT behavior so it FAILS against the
 * current implementation (or, for dead-code findings, demonstrates the feature
 * is a no-op). Failing assertions are the deliverable — see the report.
 *
 * Run: bun test test/memory/_audit/lifecycle.test.ts
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { allocateBudgets } from '../../../src/memory/budget';
import {
  completeLayers,
  createLayerStateStore,
  disposeLayers,
  initLayers,
  recallLayers,
  resolveLayerBudgets,
  returnLayers,
  runAppendPipeline,
  spawnLayers,
  storeLayers,
} from '../../../src/memory/layer-lifecycle';
import { assembleView } from '../../../src/memory/projector';
import type { Item } from '../../../src/types/items';
import type { MemoryLayer } from '../../../src/types/memory';
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

//#endregion

//#region Finding 1 — DEAD BUDGET ALLOCATOR

describe('AUDIT-1 dead budget allocator', () => {
  it('1a: recall budget IGNORES `min` (two layers, same max, very different min → identical budget)', () => {
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
        slot: 0,
        scope: 'execution',
        budget: {
          min: 15999,
          max: 16000,
        },
        hooks: {},
      },
    ];
    const budgets = resolveLayerBudgets(layers);
    // CORRECT: a layer reserving a much larger floor should differ from one
    // reserving almost nothing. Current code returns `max` for both → equal.
    expect(budgets.get('low-min')).not.toBe(budgets.get('high-min'));
  });

  it('1b: N "auto" layers scale UNBOUNDED (no global cap)', () => {
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
    const budgets = resolveLayerBudgets(layers);
    const total = [
      ...budgets.values(),
    ].reduce((a, b) => a + b, 0);
    // CORRECT: total recall budget must be bounded by the context window.
    // Current code gives each layer a flat 16000 → 1.6M total.
    expect(total).toBeLessThanOrEqual(GLOBAL_CONTEXT_CAP);
  });

  it('1c: wired allocator (resolveLayerBudgets) DIVERGES from the sophisticated allocateBudgets', () => {
    const layers: MemoryLayer[] = [
      {
        id: 'a',
        slot: 0,
        scope: 'execution',
        budget: {
          min: 1000,
          max: 5000,
        },
        hooks: {},
      },
      {
        id: 'b',
        slot: 1,
        scope: 'execution',
        budget: {
          min: 1000,
          max: 5000,
        },
        hooks: {},
      },
    ];
    const wired = resolveLayerBudgets(layers);
    const { allocations } = allocateBudgets({
      layers,
      totalBudget: 8000,
      systemPromptTokens: 0,
      responseReserve: 0,
    });
    const sophisticated = new Map(
      allocations.map((x) => [
        x.layerId,
        x.allocated,
      ]),
    );
    // CORRECT: the recall path should use the budget-aware allocator. It does
    // not — the two implementations disagree, proving allocateBudgets is dead.
    expect(wired.get('a')).toBe(sophisticated.get('a'));
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
  it('3a: no policy → concatenates unbounded history with zero capping', () => {
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
    });
    // CORRECT: an assembled view must be capped to a sane window. Current code
    // returns every item verbatim.
    expect(view.length).toBeLessThan(1000);
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

describe('AUDIT-4 init-failure silent disable', () => {
  it('4: a transient init() throw silently disables recall AND store for the whole execution with no surfaced error', async () => {
    const diagnostics: string[] = [];
    const store = createLayerStateStore((id, hook) => diagnostics.push(`${id}:${hook}`));
    let recallCalled = false;
    let storeCalled = false;
    const layers: MemoryLayer[] = [
      {
        id: 'transient',
        slot: 100,
        scope: 'thread',
        hooks: {
          init: async () => {
            throw new Error('transient network blip');
          },
          recall: async () => {
            recallCalled = true;
            return {
              items: [],
              tokenCount: 0,
            };
          },
          store: async () => {
            storeCalled = true;
            return {
              state: {},
            };
          },
        },
      },
    ];
    const ctx = makeCtx({
      executionId: 'exec-transient',
    });
    // initLayers swallows the throw (no rejection surfaced to caller).
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
      budgets: resolveLayerBudgets(layers),
      store,
    });
    await storeLayers({
      layers,
      response: makeLLMResponse(''),
      ctx,
      log: makeItemLog(),
      store,
      storage: makeStorage(),
    });

    // CORRECT: a transient init failure should not silently nuke the layer's
    // entire participation. Current code skips both recall and store.
    expect(recallCalled).toBe(true);
    expect(storeCalled).toBe(true);
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

describe('AUDIT-6 withTimeout no cancellation', () => {
  it('6: a timed-out recall hook keeps running (no abort); lifecycle does NOT write its late state', async () => {
    const store = createLayerStateStore();
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
      budgets: resolveLayerBudgets(layers),
      store,
    });

    // Wait past the hook's real completion.
    await sleep(150);

    // PART B FIRST (refutes the "late store.set" half of the candidate): the
    // lifecycle did NOT persist the late state — it stayed 'initial'. This
    // PASSES, so the orchestrator does not write state after a timeout.
    expect(
      store.get<{
        v: string;
      }>('exec-timeout', 'slow'),
    ).toEqual({
      v: 'initial',
    });

    // PART A (no cancellation): the hook body ran to completion even though the
    // orchestrator already treated it as a failure. CORRECT: a cancelled hook
    // should not keep executing. This assertion FAILS → confirms no abort.
    expect(lateBodyRan).toBe(false);
  });
});

//#endregion

//#region Extra probes

describe('AUDIT-EXTRA', () => {
  it('E1: a layer CANNOT clear its state to undefined via store (write skipped on `!== undefined`)', async () => {
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
    // CORRECT: returning {state: undefined} should clear state. It does not —
    // the `result.state !== undefined` guard drops the write.
    expect(store.get('exec-clear', 'clearable')).toBeUndefined();
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
      budgets: resolveLayerBudgets([
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
      budgets: resolveLayerBudgets(layers),
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
