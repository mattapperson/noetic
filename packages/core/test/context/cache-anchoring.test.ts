import { describe, expect, it } from 'bun:test';
import type { ContextLayer } from '@noetic-tools/context';
import {
  churnFor,
  churnRate,
  createContextCacheStore,
  DEFAULT_CONTEXT_CACHE,
  dropLineage,
  lineageKey,
  noteCacheOutcome,
  openEpoch,
  pin,
  pinKey,
  reanchorReason,
  resolveCacheConfig,
  unpinLayers,
} from '@noetic-tools/context';
import type { LLMResponse } from '@noetic-tools/types';
import { makeCtx } from '../_helpers';

//#region Helpers

const CONFIG = DEFAULT_CONTEXT_CACHE;

function makeLayer(id: string, overrides?: Partial<ContextLayer>): ContextLayer {
  return {
    id,
    slot: 100,
    scope: 'thread',
    hooks: {},
    ...overrides,
  };
}

function makeResponse(rounds: LLMResponse['rounds']): LLMResponse {
  return {
    items: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
    },
    rounds,
  };
}

/** Opens an epoch and advances it past the bootstrap grace so misses are judged. */
function makeJudgedEpoch(layers: ContextLayer[] = []): ReturnType<typeof createContextCacheStore> {
  const store = createContextCacheStore();
  const ctx = makeCtx();
  const epoch = openEpoch({
    store,
    key: lineageKey(ctx),
    reason: 'cold-start',
    instructionsHash: 'h',
    layers,
    config: CONFIG,
  });
  epoch.assemblies = CONFIG.minEpochAssemblies;
  return store;
}

//#endregion

describe('lineageKey', () => {
  it('keys a top-level run on its thread so turns share a prefix', () => {
    const a = makeCtx({
      executionId: 'exec-1',
      threadId: 'thread-1',
      depth: 0,
    });
    const b = makeCtx({
      executionId: 'exec-2',
      threadId: 'thread-1',
      depth: 0,
    });

    expect(lineageKey(a)).toBe(lineageKey(b));
  });

  // A child inherits its parent's threadId but assembles a different view, so
  // sharing pins would replay a prefix that was never sent on its behalf.
  it('isolates a child execution from its parent thread', () => {
    const parent = makeCtx({
      threadId: 'thread-1',
      depth: 0,
    });
    const child = makeCtx({
      executionId: 'child-1',
      threadId: 'thread-1',
      depth: 1,
    });

    expect(lineageKey(child)).not.toBe(lineageKey(parent));
  });

  it('isolates two concurrent children of the same thread', () => {
    const left = makeCtx({
      executionId: 'child-a',
      threadId: 'thread-1',
      depth: 1,
    });
    const right = makeCtx({
      executionId: 'child-b',
      threadId: 'thread-1',
      depth: 1,
    });

    expect(lineageKey(left)).not.toBe(lineageKey(right));
  });
});

describe('pinKey', () => {
  it('separates layers', () => {
    expect(pinKey(makeLayer('a'))).not.toBe(pinKey(makeLayer('b')));
  });

  // The epoch is already scoped to one lineage. Folding a layer's `scope` in
  // would rotate the key every turn for an 'execution'-scoped layer, so each
  // turn would retract the "old" pin and add a "new" one for the same layer.
  it('holds steady whatever the layer scope', () => {
    const key = pinKey(
      makeLayer('a', {
        scope: 'thread',
      }),
    );

    for (const scope of [
      'execution',
      'resource',
      'global',
    ] as const) {
      expect(
        pinKey(
          makeLayer('a', {
            scope,
          }),
        ),
      ).toBe(key);
    }
  });
});

describe('resolveCacheConfig', () => {
  it('is on by default', () => {
    expect(resolveCacheConfig().enabled).toBe(true);
  });

  it('keeps unset fields at their defaults', () => {
    const config = resolveCacheConfig({
      minCachedTokens: 5,
    });

    expect(config.minCachedTokens).toBe(5);
    expect(config.maxEpochAssemblies).toBe(DEFAULT_CONTEXT_CACHE.maxEpochAssemblies);
  });
});

describe('reanchorReason', () => {
  it('re-anchors when no epoch exists yet', () => {
    const store = createContextCacheStore();

    expect(
      reanchorReason({
        epoch: undefined,
        key: 't:thread-1',
        instructionsHash: 'h',
        store,
        config: CONFIG,
      }),
    ).toBe('cold-start');
  });

  it('re-anchors when the instructions changed', () => {
    const store = createContextCacheStore();
    const ctx = makeCtx();
    const epoch = openEpoch({
      store,
      key: lineageKey(ctx),
      reason: 'cold-start',
      instructionsHash: 'old',
      layers: [],
      config: CONFIG,
    });

    expect(
      reanchorReason({
        epoch,
        key: lineageKey(ctx),
        instructionsHash: 'new',
        store,
        config: CONFIG,
      }),
    ).toBe('instructions-changed');
  });

  it('carries a healthy epoch onward', () => {
    const store = createContextCacheStore();
    const ctx = makeCtx();
    const epoch = openEpoch({
      store,
      key: lineageKey(ctx),
      reason: 'cold-start',
      instructionsHash: 'h',
      layers: [],
      config: CONFIG,
    });

    expect(
      reanchorReason({
        epoch,
        key: lineageKey(ctx),
        instructionsHash: 'h',
        store,
        config: CONFIG,
      }),
    ).toBeUndefined();
  });

  it('re-anchors once the epoch reaches its age ceiling', () => {
    const store = createContextCacheStore();
    const ctx = makeCtx();
    const epoch = openEpoch({
      store,
      key: lineageKey(ctx),
      reason: 'cold-start',
      instructionsHash: 'h',
      layers: [],
      config: CONFIG,
    });
    epoch.assemblies = CONFIG.maxEpochAssemblies;

    expect(
      reanchorReason({
        epoch,
        key: lineageKey(ctx),
        instructionsHash: 'h',
        store,
        config: CONFIG,
      }),
    ).toBe('max-age');
  });

  it('picks up a re-anchor recorded from a response', () => {
    const store = createContextCacheStore();
    const ctx = makeCtx();
    const epoch = openEpoch({
      store,
      key: lineageKey(ctx),
      reason: 'cold-start',
      instructionsHash: 'h',
      layers: [],
      config: CONFIG,
    });
    store.pendingReanchor.set(lineageKey(ctx), 'cache-miss');

    expect(
      reanchorReason({
        epoch,
        key: lineageKey(ctx),
        instructionsHash: 'h',
        store,
        config: CONFIG,
      }),
    ).toBe('cache-miss');
  });
});

describe('noteCacheOutcome', () => {
  const KEY = 't:thread-1';

  it('records a re-anchor when the prefix clearly missed', () => {
    const store = makeJudgedEpoch();

    noteCacheOutcome({
      store,
      key: KEY,
      response: makeResponse([
        {
          inputTokens: 10_000,
          outputTokens: 5,
          cachedTokens: 0,
        },
      ]),
      config: CONFIG,
      expectedTokens: 10_000,
    });

    expect(store.pendingReanchor.get(KEY)).toBe('cache-miss');
  });

  it('leaves a healthy epoch alone when the prefix was cached', () => {
    const store = makeJudgedEpoch();

    noteCacheOutcome({
      store,
      key: KEY,
      response: makeResponse([
        {
          inputTokens: 10_000,
          outputTokens: 5,
          cachedTokens: 9_000,
        },
      ]),
      config: CONFIG,
      expectedTokens: 10_000,
    });

    expect(store.pendingReanchor.has(KEY)).toBe(false);
  });

  // The regression that motivates reading round 0 only: later rounds replay the
  // same view and hit cache regardless, so summing them hides a total miss.
  it('judges the first round, not the sum across tool rounds', () => {
    const store = makeJudgedEpoch();

    noteCacheOutcome({
      store,
      key: KEY,
      response: makeResponse([
        {
          inputTokens: 10_000,
          outputTokens: 5,
          cachedTokens: 0,
        },
        {
          inputTokens: 10_500,
          outputTokens: 5,
          cachedTokens: 50_000,
        },
        {
          inputTokens: 11_000,
          outputTokens: 5,
          cachedTokens: 50_000,
        },
      ]),
      config: CONFIG,
      expectedTokens: 10_000,
    });

    expect(store.pendingReanchor.get(KEY)).toBe('cache-miss');
  });

  // The first assembly of an epoch writes the cache rather than reading it, so
  // judging it would re-anchor forever and nothing would ever stay pinned.
  it('spares an epoch that has not reached the grace threshold', () => {
    const store = createContextCacheStore();
    openEpoch({
      store,
      key: KEY,
      reason: 'cold-start',
      instructionsHash: 'h',
      layers: [],
      config: CONFIG,
    });

    noteCacheOutcome({
      store,
      key: KEY,
      response: makeResponse([
        {
          inputTokens: 10_000,
          outputTokens: 5,
          cachedTokens: 0,
        },
      ]),
      config: CONFIG,
      expectedTokens: 10_000,
    });

    expect(store.pendingReanchor.has(KEY)).toBe(false);
  });

  it('treats a reported cache write as a success, not a miss', () => {
    const store = makeJudgedEpoch();

    noteCacheOutcome({
      store,
      key: KEY,
      response: makeResponse([
        {
          inputTokens: 10_000,
          outputTokens: 5,
          cachedTokens: 0,
          cacheWriteTokens: 9_000,
        },
      ]),
      config: CONFIG,
      expectedTokens: 10_000,
    });

    expect(store.pendingReanchor.has(KEY)).toBe(false);
  });

  // A provider reporting nothing must not look like a permanent miss.
  it('goes blind rather than re-anchoring when the provider reports nothing', () => {
    const store = makeJudgedEpoch();

    noteCacheOutcome({
      store,
      key: KEY,
      response: makeResponse([
        {
          inputTokens: 10_000,
          outputTokens: 5,
        },
      ]),
      config: CONFIG,
      expectedTokens: 10_000,
    });

    expect(store.pendingReanchor.has(KEY)).toBe(false);
    expect(store.epochs.get(KEY)?.cacheBlind).toBe(true);
  });

  // A tiny prompt can never reach a fixed floor; holding it to one would
  // re-anchor on every turn for no gain.
  it('scales the floor to what there was to cache', () => {
    const store = makeJudgedEpoch();

    noteCacheOutcome({
      store,
      key: KEY,
      response: makeResponse([
        {
          inputTokens: 40,
          outputTokens: 5,
          cachedTokens: 30,
        },
      ]),
      config: CONFIG,
      expectedTokens: 40,
    });

    expect(store.pendingReanchor.has(KEY)).toBe(false);
  });

  it('stops consulting a provider that keeps missing', () => {
    const store = makeJudgedEpoch();
    const miss = makeResponse([
      {
        inputTokens: 10_000,
        outputTokens: 5,
        cachedTokens: 0,
      },
    ]);

    for (let i = 0; i < 5; i++) {
      const epoch = store.epochs.get(KEY);
      if (epoch) {
        epoch.assemblies = CONFIG.minEpochAssemblies;
      }
      noteCacheOutcome({
        store,
        key: KEY,
        response: miss,
        config: CONFIG,
        expectedTokens: 10_000,
      });
    }

    expect(store.epochs.get(KEY)?.cacheBlind).toBe(true);
  });

  it('ignores a lineage with no epoch', () => {
    const store = createContextCacheStore();

    noteCacheOutcome({
      store,
      key: 't:missing',
      response: makeResponse([
        {
          inputTokens: 10_000,
          outputTokens: 5,
          cachedTokens: 0,
        },
      ]),
      config: CONFIG,
      expectedTokens: 10_000,
    });

    expect(store.pendingReanchor.size).toBe(0);
  });
});

describe('openEpoch', () => {
  it('clears pins and bumps the generation', () => {
    const store = createContextCacheStore();
    const ctx = makeCtx();
    const key = lineageKey(ctx);
    const first = openEpoch({
      store,
      key,
      reason: 'cold-start',
      instructionsHash: 'h',
      layers: [],
      config: CONFIG,
    });
    pin(first, 'thread-1:a', {
      layerId: 'a',
      items: [],
      tokenCount: 10,
      contentHash: 'x',
      state: undefined,
      slot: 100,
    });

    const second = openEpoch({
      store,
      key,
      reason: 'max-age',
      instructionsHash: 'h',
      layers: [],
      config: CONFIG,
    });

    expect(second.pins.size).toBe(0);
    expect(second.anchorTokens).toBe(0);
    expect(second.id).not.toBe(first.id);
    expect(second.lastReanchorReason).toBe('max-age');
  });

  it('clears a pending re-anchor it has just acted on', () => {
    const store = createContextCacheStore();
    const ctx = makeCtx();
    const key = lineageKey(ctx);
    store.pendingReanchor.set(key, 'cache-miss');

    openEpoch({
      store,
      key,
      reason: 'cache-miss',
      instructionsHash: 'h',
      layers: [],
      config: CONFIG,
    });

    expect(store.pendingReanchor.has(key)).toBe(false);
  });

  it('anchors a layer it has not watched long enough to judge', () => {
    const store = createContextCacheStore();
    const ctx = makeCtx();
    const layer = makeLayer('fresh');
    const churn = churnFor(store, pinKey(layer));
    churn.observed = CONFIG.minChurnSamples - 1;
    churn.changed = CONFIG.minChurnSamples - 1;

    const epoch = openEpoch({
      store,
      key: lineageKey(ctx),
      reason: 'cold-start',
      instructionsHash: 'h',
      layers: [
        layer,
      ],
      config: CONFIG,
    });

    expect(epoch.autoBand.get(pinKey(layer))).toBe('anchor');
  });

  it('moves a layer that changes most turns into the live band', () => {
    const store = createContextCacheStore();
    const ctx = makeCtx();
    const layer = makeLayer('churny');
    const churn = churnFor(store, pinKey(layer));
    churn.observed = 10;
    churn.changed = 10;

    const epoch = openEpoch({
      store,
      key: lineageKey(ctx),
      reason: 'cold-start',
      instructionsHash: 'h',
      layers: [
        layer,
      ],
      config: CONFIG,
    });

    expect(epoch.autoBand.get(pinKey(layer))).toBe('live');
  });

  it('brings a settled layer back to the anchor band', () => {
    const store = createContextCacheStore();
    const ctx = makeCtx();
    const layer = makeLayer('settled');
    const churn = churnFor(store, pinKey(layer));
    churn.observed = 10;
    churn.changed = 0;

    const epoch = openEpoch({
      store,
      key: lineageKey(ctx),
      reason: 'cold-start',
      instructionsHash: 'h',
      layers: [
        layer,
      ],
      config: CONFIG,
    });

    expect(epoch.autoBand.get(pinKey(layer))).toBe('anchor');
  });

  // The gap between the promote and demote thresholds exists so a layer
  // hovering near the boundary does not flip band every epoch.
  it('holds a layer between the thresholds in the band it already had', () => {
    const store = createContextCacheStore();
    const ctx = makeCtx();
    const layer = makeLayer('borderline');
    const key = pinKey(layer);
    const churn = churnFor(store, key);
    churn.observed = 10;
    churn.changed = 10;

    // First boundary demotes it; churn then settles into the dead zone.
    openEpoch({
      store,
      key: lineageKey(ctx),
      reason: 'cold-start',
      instructionsHash: 'h',
      layers: [
        layer,
      ],
      config: CONFIG,
    });
    churn.observed = 10;
    churn.changed = 3.5;

    const second = openEpoch({
      store,
      key: lineageKey(ctx),
      reason: 'max-age',
      instructionsHash: 'h',
      layers: [
        layer,
      ],
      config: CONFIG,
    });

    expect(churnRate(churn)).toBeGreaterThan(CONFIG.autoPromoteChurn);
    expect(churnRate(churn)).toBeLessThan(CONFIG.autoDemoteChurn);
    expect(second.autoBand.get(key)).toBe('live');
  });

  it('decays churn across a re-anchor rather than dropping it', () => {
    const store = createContextCacheStore();
    const ctx = makeCtx();
    const layer = makeLayer('a');
    const churn = churnFor(store, pinKey(layer));
    churn.observed = 8;
    churn.changed = 4;
    churn.rebillTokens = 1_000;

    openEpoch({
      store,
      key: lineageKey(ctx),
      reason: 'cold-start',
      instructionsHash: 'h',
      layers: [
        layer,
      ],
      config: CONFIG,
    });

    expect(churn.observed).toBe(8 * CONFIG.churnDecay);
    expect(churn.changed).toBe(4 * CONFIG.churnDecay);
    expect(churn.rebillTokens).toBe(1_000 * CONFIG.churnDecay);
    // The rate survives, so the band decision is not relearnt from nothing.
    expect(churnRate(churn)).toBe(0.5);
  });

  it('carries a blind provider verdict into the next epoch', () => {
    const store = createContextCacheStore();
    const ctx = makeCtx();
    const key = lineageKey(ctx);
    const first = openEpoch({
      store,
      key,
      reason: 'cold-start',
      instructionsHash: 'h',
      layers: [],
      config: CONFIG,
    });
    first.cacheBlind = true;

    const second = openEpoch({
      store,
      key,
      reason: 'max-age',
      instructionsHash: 'h',
      layers: [],
      config: CONFIG,
    });

    expect(second.cacheBlind).toBe(true);
  });
});

describe('churn accounting', () => {
  it('starts a layer at zero', () => {
    const store = createContextCacheStore();
    const churn = churnFor(store, 'k');

    expect(churn.observed).toBe(0);
    expect(churnRate(churn)).toBe(0);
  });

  it('returns the same record on repeat reads', () => {
    const store = createContextCacheStore();
    churnFor(store, 'k').observed = 3;

    expect(churnFor(store, 'k').observed).toBe(3);
  });

  it('reports the share of assemblies that changed', () => {
    expect(
      churnRate({
        observed: 4,
        changed: 1,
        rebillTokens: 0,
      }),
    ).toBe(0.25);
  });
});

describe('dropLineage', () => {
  it('forgets a child execution once it ends', () => {
    const store = createContextCacheStore();
    const ctx = makeCtx({
      depth: 1,
      executionId: 'child-1',
    });
    const key = lineageKey(ctx);
    openEpoch({
      store,
      key,
      reason: 'cold-start',
      instructionsHash: 'h',
      layers: [],
      config: CONFIG,
    });
    store.pendingReanchor.set(key, 'cache-miss');

    dropLineage(store, key);

    expect(store.epochs.has(key)).toBe(false);
    expect(store.pendingReanchor.has(key)).toBe(false);
  });
});

describe('unpinLayers', () => {
  function pinned(id: string) {
    return {
      layerId: id,
      items: [],
      tokenCount: 0,
      contentHash: id,
      state: undefined,
      slot: 100,
    };
  }

  it('drops only the named layers from the lineage epoch', () => {
    const store = createContextCacheStore();
    const key = lineageKey(makeCtx());
    const keep = makeLayer('keep');
    const gone = makeLayer('gone');
    const epoch = openEpoch({
      store,
      key,
      reason: 'cold-start',
      instructionsHash: 'h',
      layers: [],
      config: CONFIG,
    });
    pin(epoch, pinKey(keep), pinned('keep'));
    pin(epoch, pinKey(gone), pinned('gone'));
    epoch.autoBand.set(pinKey(gone), 'anchor');

    unpinLayers(store, key, [
      gone,
    ]);

    expect([
      ...epoch.pins.keys(),
    ]).toEqual([
      'keep',
    ]);
    expect(epoch.autoBand.has('gone')).toBe(false);
  });

  it('is a no-op for a lineage with no epoch', () => {
    const store = createContextCacheStore();

    unpinLayers(store, 'missing', [
      makeLayer('gone'),
    ]);

    expect(store.epochs.size).toBe(0);
  });
});
