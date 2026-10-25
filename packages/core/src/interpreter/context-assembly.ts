import type {
  AnchorPin,
  ContextCacheConfig,
  ContextCacheStore,
  ContextEpoch,
  ContextLayer,
  EpochUsage,
  ExecutionContext,
  Item,
  ProjectionPolicy,
  ReanchorReason,
  RecallLayerOutput,
} from '@noetic-tools/types';
import { createMessage, estimateTokens, hashItems, hashString } from '@noetic-tools/types';
import { NoeticAttr } from '../observability/genai-attributes';
import type { LayerServeInfo } from './action-deps';
import {
  churnFor,
  churnRate,
  lineageKey,
  openEpoch,
  pin,
  pinKey,
  reanchorReason,
  resolveCacheConfig,
} from './action-deps';

/**
 * Supersedes below this are never treated as delta pressure, whatever share of
 * the anchor band they are. Keeps a small context from re-anchoring on the fixed
 * cost of the `<context_updates>` wrapper alone.
 */
const MIN_PRESSURE_TOKENS = 256;

//#region Types

/** What the layer bands contributed to one assembly, and how the epoch fared. */
export interface BandedView {
  /** Layer output rendered before history — pinned bytes where a pin exists. */
  anchorItems: Item[];
  /** Layer output rendered after history. */
  liveItems: Item[];
  /** At most one developer message superseding stale anchors. */
  deltaItems: Item[];
  /** Per-layer output as actually served, for the usage breakdown. */
  servedPerLayer: RecallLayerOutput[];
  serveInfo: Map<string, LayerServeInfo>;
  epoch: EpochUsage | undefined;
}

interface PrepareBandedViewParams {
  /** Recall output, already slot-sorted and merged with any re-render. */
  recallResults: ReadonlyArray<RecallLayerOutput>;
  layers: ReadonlyArray<ContextLayer>;
  execCtx: ExecutionContext;
  store: ContextCacheStore;
  config?: ContextCacheConfig;
  /** Resolved instructions — a change to them invalidates the prefix anyway. */
  instructions: string | undefined;
  policy: ProjectionPolicy;
  systemPromptItems: ReadonlyArray<Item>;
  /** Budget per layer id, used to size a `renderDelta`. */
  budgets: ReadonlyMap<string, number>;
  /**
   * When true, read pins without writing: no new pins, no churn, no epoch
   * ageing. For preview paths that must not disturb a live conversation.
   */
  readOnly?: boolean;
}

/** One anchored layer whose pinned output no longer matches what it just rendered. */
interface StaleAnchor {
  layer: ContextLayer;
  action: 'replace' | 'retract' | 'add';
  /** The items still pinned in the view. Empty for an addition. */
  prev: Item[];
  /** Freshly recalled items. Empty for a retraction. */
  next: Item[];
  prevState: unknown;
  budget: number;
}

//#endregion

//#region Public API

/**
 * Split recall output into the anchor and live bands, replay pinned anchors, and
 * gather everything that changed into a single supersede message.
 *
 * Runs once per LLM step, before the steering retry loop — a retry replays the
 * same view, so re-pinning or re-counting churn there would distort both.
 */
export async function prepareBandedView(params: PrepareBandedViewParams): Promise<BandedView> {
  const config = resolveCacheConfig(params.config);
  if (!config.enabled) {
    return legacyView(params.recallResults);
  }

  const key = lineageKey(params.execCtx);
  const instructionsHash = hashString(params.instructions ?? '');
  const epoch = resolveEpoch({
    ...params,
    config,
    key,
    instructionsHash,
  });

  const banded = bandAndPin({
    ...params,
    config,
    epoch,
  });
  const anchorTokens = totalTokens(banded.anchorItems);
  const rendered = await buildDeltaItems(banded.stale, epoch.id, params.execCtx);

  // A change we cannot put into words must not be published as silence: the
  // pinned block is already in the view and the model would read it as current.
  // Re-anchor so the fresh render reaches it directly instead.
  const undescribed = rendered.undescribed;

  // Two ways the supersedes stop being worth their tokens: they outgrow the
  // band they patch, or they no longer fit the window at all. Either way the
  // answer is the same — re-anchor to fresh output and publish nothing. That
  // costs one cache miss and never risks shipping content known to be stale.
  //
  // The ratio alone is not enough: the wrapper around a supersede costs a fixed
  // few dozen tokens, which would always look enormous beside a small anchor
  // band and re-anchor every turn. Pressure needs the supersedes to be both
  // absolutely and proportionally large.
  const deltaTokens = totalTokens(rendered.items);
  const overPressure =
    deltaTokens > Math.max(MIN_PRESSURE_TOKENS, config.deltaBudgetFraction * anchorTokens);

  if (!params.readOnly && (undescribed || overPressure)) {
    return rebuildOnFreshEpoch({
      ...params,
      config,
      key,
      instructionsHash,
      reason: overPressure ? 'delta-pressure' : 'delta-overflow',
    });
  }

  if (!params.readOnly) {
    epoch.anchorTokens = anchorTokens;
    epoch.assemblies += 1;
    epoch.deltaTokens = deltaTokens;
  }
  const deltaItems = rendered.items;

  return {
    anchorItems: banded.anchorItems,
    liveItems: banded.liveItems,
    deltaItems,
    servedPerLayer: banded.servedPerLayer,
    serveInfo: banded.serveInfo,
    epoch: summarize(epoch, banded.liveTokens, deltaTokens),
  };
}

/**
 * How the view was banded, as span attributes for the step's first `llm.call`
 * span, so a slow or expensive run can be traced back to the layer that keeps
 * invalidating the prefix. `undefined` when anchoring is off.
 */
export function anchoringAttributes(
  view: BandedView,
): Record<string, string | number | boolean> | undefined {
  if (!view.epoch) {
    return undefined;
  }
  const { epoch } = view;
  const attributes: Record<string, string | number | boolean> = {
    [NoeticAttr.CONTEXT_EPOCH_ID]: epoch.id,
    [NoeticAttr.CONTEXT_EPOCH_AGE]: epoch.age,
    [NoeticAttr.CONTEXT_ANCHOR_TOKENS]: epoch.anchorTokens,
    [NoeticAttr.CONTEXT_LIVE_TOKENS]: epoch.liveTokens,
    [NoeticAttr.CONTEXT_DELTA_TOKENS]: epoch.deltaTokens,
  };
  if (epoch.reanchorReason) {
    attributes[NoeticAttr.CONTEXT_REANCHOR_REASON] = epoch.reanchorReason;
  }
  if (view.serveInfo.size === 0) {
    return attributes;
  }

  const placements: unknown[] = [];
  const churn: unknown[] = [];
  for (const [id, info] of view.serveInfo) {
    placements.push({
      id,
      placement: info.placement,
      served: info.served,
      changed: info.changed,
    });
    churn.push({
      id,
      rate: Number(info.churnRate.toFixed(3)),
      rebillTokens: Math.round(info.rebillTokens),
    });
  }
  // Span attributes hold only scalars, so structured values travel as JSON.
  attributes[NoeticAttr.CONTEXT_LAYER_PLACEMENTS] = JSON.stringify(placements);
  attributes[NoeticAttr.CONTEXT_LAYER_CHURN] = JSON.stringify(churn);
  return attributes;
}

/** Tokens the prompt prefix was expected to have cached — what `noteCacheOutcome` judges against. */
export function expectedCachedTokens(
  systemPromptItems: ReadonlyArray<Item>,
  view: BandedView,
): number {
  return totalTokens(systemPromptItems) + (view.epoch?.anchorTokens ?? 0);
}

//#endregion

//#region Epoch resolution

function resolveEpoch(
  params: PrepareBandedViewParams & {
    config: Required<ContextCacheConfig>;
    key: string;
    instructionsHash: string;
  },
): ContextEpoch {
  const { store, key, instructionsHash, config } = params;
  const current = store.epochs.get(key);
  const reason = reanchorReason({
    epoch: current,
    key,
    instructionsHash,
    store,
    config,
  });

  // A read-only pass never opens or rebuilds an epoch — looking at a
  // conversation must not change what its next turn sends. It reuses whatever
  // exists, or works against a throwaway when the lineage is still cold.
  if (params.readOnly) {
    return current ?? emptyEpoch(key, instructionsHash);
  }
  if (!reason) {
    // No reason fires while `current` is absent — that case is 'cold-start'.
    return current ?? emptyEpoch(key, instructionsHash);
  }
  return openEpoch({
    store,
    key,
    reason,
    instructionsHash,
    layers: params.layers,
    config,
  });
}

/** Re-anchor and band again, publishing no supersedes against the fresh pins. */
async function rebuildOnFreshEpoch(
  params: PrepareBandedViewParams & {
    config: Required<ContextCacheConfig>;
    key: string;
    instructionsHash: string;
    reason: ReanchorReason;
  },
): Promise<BandedView> {
  const epoch = openEpoch({
    store: params.store,
    key: params.key,
    reason: params.reason,
    instructionsHash: params.instructionsHash,
    layers: params.layers,
    config: params.config,
  });
  const banded = bandAndPin({
    ...params,
    epoch,
  });
  epoch.anchorTokens = totalTokens(banded.anchorItems);
  epoch.assemblies += 1;
  epoch.deltaTokens = 0;

  return {
    anchorItems: banded.anchorItems,
    liveItems: banded.liveItems,
    deltaItems: [],
    servedPerLayer: banded.servedPerLayer,
    serveInfo: banded.serveInfo,
    epoch: summarize(epoch, banded.liveTokens, 0),
  };
}

//#endregion

//#region Banding

interface BandResult {
  anchorItems: Item[];
  liveItems: Item[];
  liveTokens: number;
  servedPerLayer: RecallLayerOutput[];
  serveInfo: Map<string, LayerServeInfo>;
  stale: StaleAnchor[];
}

/**
 * Place each layer's output in a band, then build the anchor band from the pins
 * themselves rather than from this turn's recall.
 *
 * Serving the pin map — in pin insertion order, which is the slot order of the
 * assembly that anchored it — is what makes the prefix byte-stable by
 * construction. Nothing a later turn does (a layer falling silent, a new layer
 * appearing, a layer turning non-idempotent) can reorder or shorten it; those
 * all become supersedes at the tail instead.
 */
function bandAndPin(
  params: PrepareBandedViewParams & {
    config: Required<ContextCacheConfig>;
    epoch: ContextEpoch;
  },
): BandResult {
  const { epoch, store, layers, budgets, readOnly } = params;
  const byId = new Map(
    layers.map((l) => [
      l.id,
      l,
    ]),
  );

  const out: BandResult = {
    anchorItems: [],
    liveItems: [],
    liveTokens: 0,
    servedPerLayer: [],
    serveInfo: new Map(),
    stale: [],
  };
  const anchored = new Map<string, RecallLayerOutput>();

  for (const result of params.recallResults) {
    const layer = byId.get(result.layerId);
    // Output from a layer that is not in this step's set can never be pinned
    // against it; render it live rather than guessing.
    if (!layer || bandFor(layer, result, epoch) === 'live') {
      out.liveItems.push(...result.items);
      out.liveTokens += result.tokenCount;
      out.servedPerLayer.push(result);
      if (layer) {
        out.serveInfo.set(layer.id, {
          placement: 'live',
          served: 'fresh',
          changed: false,
          churnRate: churnRate(churnFor(store, pinKey(layer))),
          rebillTokens: 0,
        });
      }
      continue;
    }
    anchored.set(pinKey(layer), result);
  }

  // A fresh epoch anchors whatever it is given, in slot order. A read-only pass
  // does the same but keeps the result to itself, so a preview still shows the
  // view the next real turn would send without deciding it in advance.
  const pins =
    epoch.pins.size > 0 || epoch.assemblies > 0 ? epoch.pins : new Map<string, AnchorPin>();
  if (pins !== epoch.pins) {
    for (const [key, result] of anchored) {
      const layer = byId.get(result.layerId);
      if (!layer) {
        continue;
      }
      const entry: AnchorPin = {
        layerId: layer.id,
        items: result.items,
        tokenCount: result.tokenCount,
        contentHash: hashItems(result.items),
        state: undefined,
        slot: layer.slot,
      };
      pins.set(key, entry);
      if (!readOnly) {
        pin(epoch, key, entry);
      }
    }
  }

  servePins({
    out,
    epoch,
    pins,
    anchored,
    byId,
    store,
    budgets,
    readOnly: readOnly === true,
  });
  collectAdditions({
    out,
    pins,
    anchored,
    byId,
    store,
    budgets,
    readOnly: readOnly === true,
  });
  return out;
}

/**
 * An explicit placement always wins. A layer whose `recall` changed state is
 * forced live regardless: replaying an older render would discard the very
 * thing that call committed.
 */
function bandFor(
  layer: ContextLayer,
  result: RecallLayerOutput,
  epoch: ContextEpoch,
): 'anchor' | 'live' {
  if (result.mutatedState) {
    return 'live';
  }
  if (layer.placement === 'anchor' || layer.placement === 'live') {
    return layer.placement;
  }
  return epoch.autoBand.get(pinKey(layer)) ?? 'anchor';
}

/**
 * Serve every pin, in pinned order, and note which have gone stale.
 *
 * A pin is served even when its layer produced nothing this turn, or has since
 * moved to the live band: dropping it would shorten the prefix and cost the
 * cache far more than the tokens it saves. The model is told to disregard it
 * instead, every turn, until the next re-anchor clears it.
 */
function servePins(args: {
  out: BandResult;
  epoch: ContextEpoch;
  pins: ReadonlyMap<string, AnchorPin>;
  anchored: ReadonlyMap<string, RecallLayerOutput>;
  byId: ReadonlyMap<string, ContextLayer>;
  store: ContextCacheStore;
  budgets: ReadonlyMap<string, number>;
  readOnly: boolean;
}): void {
  const { out, epoch, pins, anchored, byId, store, budgets, readOnly } = args;

  for (const [key, held] of pins) {
    out.anchorItems.push(...held.items);
    const layer = byId.get(held.layerId);
    const fresh = anchored.get(key);
    const churn = churnFor(store, key);

    // The pin is what the model sees, changed or not — that is the whole point.
    out.servedPerLayer.push({
      layerId: held.layerId,
      items: held.items,
      tokenCount: held.tokenCount,
    });

    if (!fresh || !layer) {
      // Gone quiet, or moved to the live band. Either way the pinned block no
      // longer reflects reality and must carry a standing retraction.
      if (layer) {
        out.stale.push({
          layer,
          action: 'retract',
          prev: held.items,
          next: [],
          prevState: held.state,
          budget: budgets.get(layer.id) ?? 0,
        });
        out.serveInfo.set(layer.id, {
          placement: 'anchor',
          served: 'pinned',
          changed: true,
          churnRate: churnRate(churn),
          rebillTokens: churn.rebillTokens,
        });
      }
      continue;
    }

    const changed = held.contentHash !== hashItems(fresh.items);
    if (!readOnly) {
      churn.observed += 1;
      if (changed) {
        churn.changed += 1;
        churn.rebillTokens += epoch.anchorTokens;
      }
    }
    if (changed) {
      out.stale.push({
        layer,
        action: 'replace',
        prev: held.items,
        next: fresh.items,
        prevState: held.state,
        budget: budgets.get(layer.id) ?? 0,
      });
    }
    out.serveInfo.set(layer.id, {
      placement: 'anchor',
      served: 'pinned',
      changed,
      churnRate: churnRate(churn),
      rebillTokens: churn.rebillTokens,
    });
  }
}

/**
 * Publish anchored output that has no pin — a layer first seen mid-epoch. It
 * cannot be spliced into a frozen prefix, so it rides in the supersede message
 * until the next re-anchor folds it into the band. Its tokens count toward
 * delta pressure, so a run of additions re-anchors on its own.
 */
function collectAdditions(args: {
  out: BandResult;
  pins: ReadonlyMap<string, AnchorPin>;
  anchored: ReadonlyMap<string, RecallLayerOutput>;
  byId: ReadonlyMap<string, ContextLayer>;
  store: ContextCacheStore;
  budgets: ReadonlyMap<string, number>;
  readOnly: boolean;
}): void {
  const { out, pins, anchored, byId, store, budgets, readOnly } = args;

  for (const [key, result] of anchored) {
    if (pins.has(key)) {
      continue;
    }
    const layer = byId.get(result.layerId);
    if (!layer) {
      continue;
    }
    const churn = churnFor(store, key);
    if (!readOnly) {
      churn.observed += 1;
      churn.changed += 1;
    }
    out.stale.push({
      layer,
      action: 'add',
      prev: [],
      next: result.items,
      prevState: undefined,
      budget: budgets.get(layer.id) ?? 0,
    });
    out.servedPerLayer.push(result);
    out.serveInfo.set(layer.id, {
      placement: 'anchor',
      served: 'fresh',
      changed: true,
      churnRate: churnRate(churn),
      rebillTokens: churn.rebillTokens,
    });
  }
}

//#endregion

//#region Supersedes

/**
 * Render every stale anchor into ONE developer message.
 *
 * A layer may describe its own change compactly via `renderDelta`; otherwise the
 * full new content is republished, which costs more tokens but is always right.
 * A hook that throws or hangs falls back to the default — a supersede is a
 * correctness obligation, so it is never skipped because a hook misbehaved.
 */
async function buildDeltaItems(
  stale: ReadonlyArray<StaleAnchor>,
  epochId: string,
  ctx: ExecutionContext,
): Promise<{
  items: Item[];
  undescribed: boolean;
}> {
  if (stale.length === 0) {
    return {
      items: [],
      undescribed: false,
    };
  }

  const blocks: string[] = [];
  let undescribed = false;
  for (const entry of stale) {
    const body = await renderBody(entry, ctx);
    if (body === null) {
      // Nothing renderable — a layer emitting non-text items, say. The pinned
      // block is already in the view, so staying silent would present it as
      // current. Report it and let the caller re-anchor.
      undescribed = true;
      continue;
    }
    blocks.push(`<update layer="${entry.layer.id}" action="${entry.action}">\n${body}\n</update>`);
  }
  if (blocks.length === 0) {
    return {
      items: [],
      undescribed,
    };
  }

  const text = [
    `<context_updates epoch="${epochId}">`,
    'These supersede the blocks with the same layer id earlier in this context.',
    'Where they disagree, these are correct.',
    ...blocks,
    '</context_updates>',
  ].join('\n');

  return {
    items: [
      createMessage(text, 'developer'),
    ],
    undescribed,
  };
}

async function renderBody(entry: StaleAnchor, ctx: ExecutionContext): Promise<string | null> {
  if (entry.action === 'retract') {
    return 'This block no longer applies. Disregard it.';
  }
  const custom = await tryRenderDelta(entry, ctx);
  if (custom !== null) {
    return custom;
  }
  const full = itemsToText(entry.next);
  if (full.length > 0) {
    return full;
  }
  // A layer that rendered nothing this turn is saying its block is gone, which
  // is a retraction however it was classified.
  return entry.next.length === 0 ? 'This block no longer applies. Disregard it.' : null;
}

async function tryRenderDelta(entry: StaleAnchor, ctx: ExecutionContext): Promise<string | null> {
  const hook = entry.layer.hooks.renderDelta;
  if (!hook) {
    return null;
  }
  try {
    const timeout = entry.layer.timeouts?.recall ?? 5e3;
    const rendered = await withTimeout(
      hook({
        prev: entry.prev,
        next: entry.next,
        prevState: entry.prevState,
        state: ctx.readLayerState(entry.layer.id),
        ctx,
        budget: entry.budget,
      }),
      timeout,
    );
    return rendered && rendered.length > 0 ? rendered : null;
  } catch {
    // Fall back to republishing in full — see `buildDeltaItems`.
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('renderDelta timed out')), ms)),
  ]);
}

//#endregion

//#region Helpers

/** Everything before history, as it was assembled before bands existed. */
function legacyView(recallResults: ReadonlyArray<RecallLayerOutput>): BandedView {
  return {
    anchorItems: recallResults.flatMap((r) => r.items),
    liveItems: [],
    deltaItems: [],
    servedPerLayer: [
      ...recallResults,
    ],
    serveInfo: new Map(),
    epoch: undefined,
  };
}

/** A throwaway epoch for a read-only pass on a lineage that has none yet. */
function emptyEpoch(key: string, instructionsHash: string): ContextEpoch {
  return {
    id: `${key}#preview`,
    pins: new Map(),
    autoBand: new Map(),
    instructionsHash,
    assemblies: 0,
    anchorTokens: 0,
    deltaTokens: 0,
    cacheBlind: false,
    misses: 0,
    lastReanchorReason: 'cold-start',
  };
}

function summarize(epoch: ContextEpoch, liveTokens: number, deltaTokens: number): EpochUsage {
  return {
    id: epoch.id,
    age: epoch.assemblies,
    anchorTokens: epoch.anchorTokens,
    liveTokens,
    deltaTokens,
    reanchorReason: epoch.assemblies <= 1 ? epoch.lastReanchorReason : undefined,
  };
}

function itemsToText(items: ReadonlyArray<Item>): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.type !== 'message' || !('content' in item)) {
      continue;
    }
    for (const part of item.content ?? []) {
      if ('text' in part && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
  }
  return parts.join('\n');
}

function totalTokens(items: ReadonlyArray<Item>): number {
  let total = 0;
  for (const item of items) {
    total += estimateTokens(JSON.stringify(item));
  }
  return total;
}

//#endregion
