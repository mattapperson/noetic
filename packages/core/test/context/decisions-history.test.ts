import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextLayer, DecisionsHistoryState, InferContext } from '@noetic-tools/context';
import {
  createLayerStateStore,
  createRecallCache,
  createScopedStorage,
  decisionsHistoryLayer,
  initLayers,
  notifyDecision,
  recallLayers,
  recallLayersEventual,
} from '@noetic-tools/context';
import type { DecisionRecord, InitParams, RecallParams } from '@noetic-tools/types';
import { context } from '../../src/builders/context-builder';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { makeCtx, makeItemLog } from '../_helpers';

//#region Helpers

function record(stepId: string, at: number): DecisionRecord {
  return {
    stepId,
    at,
    modelId: 'typesafe/jev-1.14',
    source: 'native',
    answers: {
      destination: {
        type: 'choice',
        value: 'billing',
        confidence: 0.2,
        probabilities: {
          billing: 0.81,
          sales: 0.19,
        },
      },
      isUrgent: {
        type: 'boolean',
        value: true,
        probability: 0.92,
      },
      urgency: {
        type: 'score',
        value: 1.3,
        level: 'medium',
        confidence: 0.6,
        probabilities: {
          low: 0.1,
          medium: 0.5,
          high: 0.4,
        },
      },
      spam: {
        type: 'refusal',
      },
    },
  };
}

function counterLayer(): ContextLayer<{
  n: number;
}> {
  return {
    id: 'counter',
    slot: 100,
    scope: 'execution',
    recallMode: 'eventual',
    hooks: {
      async recall({ state }) {
        return {
          items: [],
          tokenCount: 0,
          state: {
            n: (state?.n ?? 0) + 1,
          },
        };
      },
    },
  };
}

function initParams(): InitParams {
  return {
    storage: createScopedStorage(createInMemoryStorage(), 'decisionsHistory', 'k'),
    scopeKey: 'k',
    ctx: makeCtx(),
  };
}

function recallParams(state: DecisionsHistoryState): RecallParams<DecisionsHistoryState> {
  return {
    state,
    query: '',
    log: makeItemLog(),
    ctx: makeCtx(),
    budget: 1e3,
  };
}

//#endregion

describe('recall peek', () => {
  it('renders but does not commit state a recall returns', async () => {
    const store = createLayerStateStore();
    const ctx = makeCtx();
    store.set(ctx.executionId, 'counter', {
      n: 0,
    });
    const common = {
      layers: [
        counterLayer(),
      ],
      query: '',
      ctx,
      log: makeItemLog(),
      budgets: new Map(),
      store,
    };
    await recallLayers({
      ...common,
      peek: true,
    });
    expect(store.get(ctx.executionId, 'counter')).toEqual({
      n: 0,
    });
    await recallLayers(common);
    expect(store.get(ctx.executionId, 'counter')).toEqual({
      n: 1,
    });
  });

  it('leaves the eventual cache cold, so the next real recall still renders', async () => {
    const store = createLayerStateStore();
    const cache = createRecallCache();
    const ctx = makeCtx();
    store.set(ctx.executionId, 'counter', {
      n: 0,
    });
    const common = {
      layers: [
        counterLayer(),
      ],
      query: '',
      ctx,
      log: makeItemLog(),
      budgets: new Map(),
      store,
      cache,
    };
    await recallLayersEventual({
      ...common,
      peek: true,
    });
    expect(cache.entries.size).toBe(0);
    await recallLayersEventual(common);
    expect(cache.entries.size).toBe(1);
    expect(store.get(ctx.executionId, 'counter')).toEqual({
      n: 1,
    });
  });
});

describe('notifyDecision', () => {
  it('runs onDecision in slot order and commits returned state', async () => {
    const order: string[] = [];
    const listener = (id: string, slot: number): ContextLayer<string[]> => ({
      id,
      slot,
      scope: 'execution',
      hooks: {
        async onDecision({ state, record: r }) {
          order.push(id);
          return {
            state: [
              ...(state ?? []),
              r.stepId,
            ],
          };
        },
      },
    });
    const store = createLayerStateStore();
    const ctx = makeCtx();
    await notifyDecision({
      layers: [
        listener('late', 200),
        listener('early', 100),
      ],
      record: record('triage', 1),
      ctx,
      store,
    });
    expect(order).toEqual([
      'early',
      'late',
    ]);
    expect(store.get(ctx.executionId, 'early')).toEqual([
      'triage',
    ]);
  });

  it('reports a throwing hook as a diagnostic and carries on', async () => {
    const diagnostics: string[] = [];
    const store = createLayerStateStore((layerId, hook) => {
      diagnostics.push(`${layerId}:${hook}`);
    });
    const ctx = makeCtx();
    await notifyDecision({
      layers: [
        {
          id: 'boom',
          slot: 100,
          scope: 'execution',
          hooks: {
            async onDecision() {
              throw new Error('boom');
            },
          },
        },
      ],
      record: record('triage', 1),
      ctx,
      store,
    });
    expect(diagnostics).toEqual([
      'boom:onDecision',
    ]);
  });
});

describe('decisionsHistoryLayer', () => {
  async function recordAll(
    layer: ReturnType<typeof decisionsHistoryLayer>,
    records: DecisionRecord[],
  ): Promise<DecisionsHistoryState> {
    const init = await layer.hooks.init(initParams());
    let state = init.state;
    for (const r of records) {
      const next = await layer.hooks.onDecision({
        state,
        record: r,
        ctx: makeCtx(),
      });
      state = next.state;
    }
    return state;
  }

  it('keeps records oldest first, dropping past maxRecords', async () => {
    const layer = decisionsHistoryLayer({
      maxRecords: 2,
    });
    const state = await recordAll(layer, [
      record('a', 1),
      record('b', 2),
      record('c', 3),
    ]);
    expect(state.records.map((r) => r.stepId)).toEqual([
      'b',
      'c',
    ]);
  });

  it('provides the newest record per step and every record', async () => {
    const layer = decisionsHistoryLayer();
    const state = await recordAll(layer, [
      record('triage', 1),
      record('triage', 2),
      record('other', 3),
    ]);
    expect(layer.provides.latest.read(state).triage?.at).toBe(2);
    expect(layer.provides.all.read(state)).toHaveLength(3);
  });

  it('recalls a one-line-per-step summary, newest record only', async () => {
    const layer = decisionsHistoryLayer();
    const state = await recordAll(layer, [
      record('triage', 1),
    ]);
    const text = await layer.hooks.recall(recallParams(state));
    expect(text).toBe(
      [
        'Decisions so far:',
        '- triage: destination=billing (0.81), isUrgent=yes (0.92), urgency=medium (1.3), spam=refused',
      ].join('\n'),
    );
  });

  it('recalls nothing when empty or when recall is off', async () => {
    const empty = decisionsHistoryLayer();
    expect(
      await empty.hooks.recall(recallParams((await empty.hooks.init(initParams())).state)),
    ).toBeNull();
    const quiet = decisionsHistoryLayer({
      recall: false,
    });
    const state = await recordAll(quiet, [
      record('triage', 1),
    ]);
    expect(await quiet.hooks.recall(recallParams(state))).toBeNull();
  });

  it('takes a custom id and defaults to execution scope', () => {
    const layer = decisionsHistoryLayer({
      id: 'routing',
    });
    expect(layer.id).toBe('routing');
    expect(layer.scope).toBe('execution');
    const asLayer: ContextLayer<DecisionsHistoryState> = layer;
    assert(asLayer.hooks.onDecision);
  });
});

describe('decisionsHistoryLayer across boundaries', () => {
  it('seeds a child with the parent records and merges back only what the child added', async () => {
    const layer = decisionsHistoryLayer();
    const parentState = {
      records: [
        record('triage', 1),
      ],
    };
    const spawned = await layer.hooks.onSpawn({
      parentState,
      childCtx: makeCtx(),
    });
    assert(spawned.childState);
    const childState = {
      records: [
        ...spawned.childState.records,
        record('child', 2),
      ],
    };
    const sibling = {
      records: [
        ...spawned.childState.records,
        record('sibling', 3),
      ],
    };
    const afterChild = await layer.hooks.onReturn({
      parentState,
      childState,
      childLog: makeItemLog(),
      result: undefined,
      childCtx: makeCtx(),
    });
    const afterBoth = await layer.hooks.onReturn({
      parentState: afterChild.parentState,
      childState: sibling,
      childLog: makeItemLog(),
      result: undefined,
      childCtx: makeCtx(),
    });
    expect(afterBoth.parentState.records.map((r) => r.stepId)).toEqual([
      'triage',
      'child',
      'sibling',
    ]);
  });

  it('reloads thread-scoped history from storage', async () => {
    const storage = createInMemoryStorage();
    const scoped = createScopedStorage(storage, 'decisionsHistory', 't1');
    const layer = decisionsHistoryLayer({
      scope: 'thread',
    });
    await scoped.set('state', {
      records: [
        record('triage', 1),
      ],
    });
    const init = await layer.hooks.init({
      storage: scoped,
      scopeKey: 't1',
      ctx: makeCtx(),
    });
    expect(init.state.records.map((r) => r.stepId)).toEqual([
      'triage',
    ]);
  });

  it('initLayers with keep leaves restored state in place', async () => {
    const store = createLayerStateStore();
    const ctx = makeCtx();
    const layer = decisionsHistoryLayer();
    store.set(ctx.executionId, layer.id, {
      records: [
        record('restored', 1),
      ],
    });
    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage: createInMemoryStorage(),
      store,
      keep: true,
    });
    expect(
      store.get<DecisionsHistoryState>(ctx.executionId, layer.id)?.records.map((r) => r.stepId),
    ).toEqual([
      'restored',
    ]);
    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage: createInMemoryStorage(),
      store,
    });
    expect(store.get<DecisionsHistoryState>(ctx.executionId, layer.id)?.records).toEqual([]);
  });

  it('keeps its literal id inside context([...]) for ctx.context typing', () => {
    const config = context([
      decisionsHistoryLayer(),
    ]);
    type Shape = InferContext<typeof config>;
    const keys: Array<keyof Shape> = [
      'decisionsHistory',
    ];
    const typo: Array<keyof Shape> = [
      // @ts-expect-error only the layer's own id is a key
      'decisionHistory',
    ];
    expect(keys).not.toEqual(typo);
  });
});
