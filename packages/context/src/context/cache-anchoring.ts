import type {
  AnchorPin,
  ContextCacheConfig,
  ContextCacheStore,
  ContextEpoch,
  ContextLayer,
  ExecutionContext,
  LayerChurn,
  LLMResponse,
  ReanchorReason,
  RoundUsage,
} from '@noetic-tools/types';

// These shapes live in @noetic-tools/types because the harness contract
// references them, but they reach layer authors through this package, next to
// the functions that operate on them.
export type {
  AnchorPin,
  ContextCacheConfig,
  ContextCacheStore,
  ContextEpoch,
  LayerChurn,
  ReanchorReason,
} from '@noetic-tools/types';

//#region Config

/** Defaults for prompt-cache anchoring. See `ContextCacheConfig` for what each one does. */
export const DEFAULT_CONTEXT_CACHE: Required<ContextCacheConfig> = {
  enabled: true,
  minCachedTokens: 100,
  minEpochAssemblies: 2,
  maxEpochAssemblies: 50,
  deltaBudgetFraction: 0.15,
  autoDemoteChurn: 0.5,
  autoPromoteChurn: 0.2,
  minChurnSamples: 3,
  churnDecay: 0.5,
};

/** Fills a partial config with the defaults. */
export function resolveCacheConfig(config?: ContextCacheConfig): Required<ContextCacheConfig> {
  return {
    ...DEFAULT_CONTEXT_CACHE,
    ...config,
  };
}

/**
 * Judged assemblies that may come back a miss before the runtime stops steering
 * on the provider's cache figures. A provider that never caches would otherwise
 * re-anchor on every turn forever, for no gain.
 */
const MAX_CONSECUTIVE_MISSES = 3;

/** Lineages retained per harness before the least recently used is dropped. */
const MAX_LINEAGES = 256;

//#endregion

//#region Keys

/**
 * The run of assemblies that share a cacheable prompt prefix.
 *
 * A thread at top level, because its turns build one growing conversation. A
 * child execution keys on itself instead: it inherits its parent's `threadId`
 * but assembles a different view, so sharing pins would replay a prefix that was
 * never sent on its behalf.
 */
export function lineageKey(ctx: ExecutionContext): string {
  return ctx.depth === 0 ? `t:${ctx.threadId}` : `x:${ctx.executionId}`;
}

/**
 * Where a layer's pin lives within its epoch.
 *
 * The layer id alone, deliberately — the epoch is already scoped to one cache
 * lineage, and layer ids are unique within a layer set. Folding the layer's
 * `scope` into the key (as the eventual-recall cache does, where one map spans
 * every thread) would rotate it every turn for an `'execution'`-scoped layer,
 * so each turn would retract the "old" pin and add a "new" one for the very
 * same layer — republishing its content in full, forever.
 */
export function pinKey(layer: ContextLayer): string {
  return layer.id;
}

//#endregion

//#region Store

export function createContextCacheStore(): ContextCacheStore {
  return {
    epochs: new Map(),
    churn: new Map(),
    pendingReanchor: new Map(),
  };
}

/** Drop a lineage's epoch — used when a child execution ends. */
export function dropLineage(store: ContextCacheStore, key: string): void {
  store.epochs.delete(key);
  store.pendingReanchor.delete(key);
}

/**
 * Drop the pins of layers that left a lineage's layer set — a closing
 * `withContext` boundary. A pin outlives its layer by design (dropping it
 * shortens the cached prefix), so a scoped layer must be unpinned explicitly or
 * its last render keeps replaying after its scope ends.
 */
export function unpinLayers(store: ContextCacheStore, key: string, layers: ContextLayer[]): void {
  const epoch = store.epochs.get(key);
  if (!epoch) {
    return;
  }
  for (const layer of layers) {
    epoch.pins.delete(pinKey(layer));
    epoch.autoBand.delete(pinKey(layer));
  }
}

/** Read a layer's churn record, creating an empty one on first sight. */
export function churnFor(store: ContextCacheStore, key: string): LayerChurn {
  const found = store.churn.get(key);
  if (found) {
    return found;
  }
  const fresh: LayerChurn = {
    observed: 0,
    changed: 0,
    rebillTokens: 0,
  };
  store.churn.set(key, fresh);
  return fresh;
}

/** Share of watched assemblies in which a layer's output changed, 0–1. */
export function churnRate(churn: LayerChurn): number {
  return churn.observed === 0 ? 0 : churn.changed / churn.observed;
}

//#endregion

//#region Epochs

interface OpenEpochParams {
  store: ContextCacheStore;
  key: string;
  reason: ReanchorReason;
  instructionsHash: string;
  layers: ReadonlyArray<ContextLayer>;
  config: Required<ContextCacheConfig>;
}

/**
 * Start a fresh epoch for a lineage, dropping every pin so the next assembly
 * re-anchors against current recall output.
 *
 * This is the only point at which `'auto'` layers change band: placement is held
 * still inside an epoch so the prefix cannot shift under the model mid-run.
 * Churn carries across, decayed, so a layer's band is not relearnt from nothing
 * each time.
 */
export function openEpoch({
  store,
  key,
  reason,
  instructionsHash,
  layers,
  config,
}: OpenEpochParams): ContextEpoch {
  const previous = store.epochs.get(key);
  const generation = previous ? Number(previous.id.split('#')[1] ?? 0) + 1 : 0;

  const autoBand = new Map<string, 'anchor' | 'live'>();
  for (const layer of layers) {
    const k = pinKey(layer);
    autoBand.set(
      k,
      chooseBand({
        store,
        key: k,
        current: previous?.autoBand.get(k),
        config,
      }),
    );
  }
  decayChurn({
    store,
    layers,
    decay: config.churnDecay,
  });

  const epoch: ContextEpoch = {
    id: `${key}#${generation}`,
    pins: new Map(),
    autoBand,
    instructionsHash,
    assemblies: 0,
    anchorTokens: 0,
    deltaTokens: 0,
    // A provider that has already shown it reports nothing stays untrusted
    // across epochs; there is no reason to expect it to start.
    cacheBlind: previous?.cacheBlind ?? false,
    // Misses carry across epochs. A miss is what CAUSED this re-anchor, so
    // resetting here would make the give-up threshold unreachable and leave a
    // never-caching provider re-anchoring on every turn forever.
    misses: previous?.misses ?? 0,
    lastReanchorReason: reason,
  };

  store.pendingReanchor.delete(key);
  touchLineage(store, key, epoch);
  evictOldestLineages(store);
  return epoch;
}

/**
 * Record a lineage as most recently used.
 *
 * `Map` keeps first-insertion order, so re-setting an existing key would leave
 * it where it was and let eviction drop the busiest lineage. Deleting first
 * moves it to the end, which is what makes eviction least-recently-used.
 */
export function touchLineage(store: ContextCacheStore, key: string, epoch?: ContextEpoch): void {
  const current = epoch ?? store.epochs.get(key);
  if (!current) {
    return;
  }
  store.epochs.delete(key);
  store.epochs.set(key, current);
}

/**
 * The band an `'auto'` layer takes for the coming epoch.
 *
 * The promote and demote thresholds leave a gap on purpose: a layer sitting
 * between them keeps the band it already had, so one hovering near the boundary
 * does not flip every epoch and undo the stability the bands exist to provide.
 */
function chooseBand({
  store,
  key,
  current,
  config,
}: {
  store: ContextCacheStore;
  key: string;
  current: 'anchor' | 'live' | undefined;
  config: Required<ContextCacheConfig>;
}): 'anchor' | 'live' {
  const churn = store.churn.get(key);
  const band = current ?? 'anchor';
  if (!churn || churn.observed < config.minChurnSamples) {
    return band;
  }
  const rate = churnRate(churn);
  if (rate >= config.autoDemoteChurn) {
    return 'live';
  }
  if (rate <= config.autoPromoteChurn) {
    return 'anchor';
  }
  return band;
}

function decayChurn({
  store,
  layers,
  decay,
}: {
  store: ContextCacheStore;
  layers: ReadonlyArray<ContextLayer>;
  decay: number;
}): void {
  for (const layer of layers) {
    const churn = store.churn.get(pinKey(layer));
    if (!churn) {
      continue;
    }
    churn.observed *= decay;
    churn.changed *= decay;
    churn.rebillTokens *= decay;
  }
}

/** Keep the lineage map bounded on a long-lived harness that spawns many children. */
function evictOldestLineages(store: ContextCacheStore): void {
  while (store.epochs.size > MAX_LINEAGES) {
    const oldest = store.epochs.keys().next();
    if (oldest.done) {
      return;
    }
    dropLineage(store, oldest.value);
  }
}

/**
 * Why the coming assembly must re-anchor, or `undefined` to carry the epoch on.
 * Ordered cheapest-check first; delta pressure is decided later, once the
 * supersedes are actually built.
 */
export function reanchorReason({
  epoch,
  key,
  instructionsHash,
  store,
  config,
}: {
  epoch: ContextEpoch | undefined;
  key: string;
  instructionsHash: string;
  store: ContextCacheStore;
  config: Required<ContextCacheConfig>;
}): ReanchorReason | undefined {
  if (!epoch) {
    return 'cold-start';
  }
  if (epoch.instructionsHash !== instructionsHash) {
    return 'instructions-changed';
  }
  const pending = store.pendingReanchor.get(key);
  if (pending) {
    return pending;
  }
  if (epoch.assemblies >= config.maxEpochAssemblies) {
    return 'max-age';
  }
  return undefined;
}

//#endregion

//#region Cache outcome

interface NoteCacheOutcomeParams {
  store: ContextCacheStore;
  key: string;
  response: LLMResponse;
  config: Required<ContextCacheConfig>;
  /** Tokens the prefix was expected to have cached — system plus anchor band. */
  expectedTokens: number;
}

/**
 * Judge, from the model's own token report, whether the prompt prefix survived,
 * and record a re-anchor for the next assembly if it did not.
 *
 * Records intent only; pins are never touched here, so a response that steering
 * later rejects cannot leave the epoch half-rebuilt.
 *
 * Three things stop this eating itself:
 *
 * - Only the first round counts. Later rounds replay the same view plus tool
 *   traffic and so hit the cache whatever the first round did — summing them
 *   hides a total miss behind a busy tool loop.
 * - Young epochs are spared. The assembly right after a re-anchor writes the
 *   cache rather than reading it, so its near-zero read is expected, not a miss.
 * - A provider that reports nothing, or misses persistently, is marked blind and
 *   stops being consulted. Age and delta pressure still bound the epoch.
 */
export function noteCacheOutcome({
  store,
  key,
  response,
  config,
  expectedTokens,
}: NoteCacheOutcomeParams): void {
  const epoch = store.epochs.get(key);
  if (!epoch || epoch.cacheBlind) {
    return;
  }

  const round: RoundUsage | undefined = response.rounds?.[0] ?? response.usage;
  if (!round || round.cachedTokens === undefined) {
    epoch.cacheBlind = true;
    return;
  }
  // Reads of zero alongside a write mean the prefix was just stored, not missed.
  if ((round.cacheWriteTokens ?? 0) > 0 && round.cachedTokens === 0) {
    return;
  }
  if (epoch.assemblies < config.minEpochAssemblies) {
    return;
  }

  // Judge against what there actually was to cache: a short prompt can never
  // reach a fixed floor, and holding it to one would re-anchor forever.
  const floor = Math.min(config.minCachedTokens, expectedTokens * 0.5);
  if (round.cachedTokens >= floor) {
    epoch.misses = 0;
    return;
  }

  epoch.misses += 1;
  if (epoch.misses >= MAX_CONSECUTIVE_MISSES) {
    epoch.cacheBlind = true;
    return;
  }
  store.pendingReanchor.set(key, 'cache-miss');
}

//#endregion

//#region Pins

/**
 * Record a layer's rendered output as the bytes to replay for the rest of the
 * epoch. The caller sets `epoch.anchorTokens` from the assembled band, which is
 * measured the same way as the supersedes it gets compared against.
 */
export function pin(epoch: ContextEpoch, key: string, entry: AnchorPin): void {
  epoch.pins.set(key, entry);
}

//#endregion
