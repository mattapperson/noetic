import type {
  ExecutionContext,
  Item,
  ItemLog,
  ItemSchemaRegistry,
  LLMResponse,
  MemoryLayer,
  ScopedStorage,
  SteeringDecision,
  StorageAdapter,
} from '@noetic-tools/types';
import {
  createMessage,
  defaultItemSchemaRegistry,
  estimateTokens,
  frameworkCast,
  NoeticConfigError,
  SteeringAction,
} from '@noetic-tools/types';
import { createScopedStorage, resolveScopeKey } from './scope';

//#region Types

export interface LayerStateStore {
  get<T>(executionId: string, layerId: string): T | undefined;
  set<T>(executionId: string, layerId: string, state: T): void;
  cleanup(executionId: string): void;
  diagnostic: (layerId: string, hook: string, error: unknown) => void;
  /**
   * Register a durable write-through target for a layer's state under an
   * execution. Once registered, EVERY `set()` for that (execution, layer) pair
   * is asynchronously mirrored to `target` (key `'state'`); `set(…, undefined)`
   * deletes the durable key. Writes are coalesced per key (latest wins) and
   * mirror failures are reported via `diagnostic(layerId, 'persist', e)` —
   * they never throw. Optional so custom stores keep compiling; without it,
   * no durable mirroring occurs.
   */
  registerDurable?(executionId: string, layerId: string, target: ScopedStorage): void;
  /** Await all in-flight durable mirror writes for an execution. */
  flush?(executionId: string): Promise<void>;
  /**
   * Mark a layer disabled for an execution (its `init` failed with
   * `onInitError: 'disable'`). Disabled layers are skipped by every later
   * hook. Optional so custom stores keep compiling; without explicit
   * tracking, the lifecycle falls back to the legacy sentinel (init-bearing
   * layer with no state).
   */
  disable?(executionId: string, layerId: string): void;
  /** Whether a layer was disabled for an execution. */
  isDisabled?(executionId: string, layerId: string): boolean;
}

interface InitLayersParams {
  layers: MemoryLayer[];
  ctx: ExecutionContext;
  storage: StorageAdapter;
  store: LayerStateStore;
}

interface RecallLayersParams {
  layers: MemoryLayer[];
  query: string;
  ctx: ExecutionContext;
  log: ItemLog;
  budgets: Map<string, number>;
  store: LayerStateStore;
  itemSchemas?: ItemSchemaRegistry;
}

interface StoreLayersParams {
  layers: MemoryLayer[];
  response: LLMResponse;
  ctx: ExecutionContext;
  log: ItemLog;
  store: LayerStateStore;
  /**
   * Unused by storeLayers itself — durable persistence is centralized in the
   * state store's write-through (registered in `initLayers`). Accepted so
   * existing call sites keep compiling.
   */
  storage?: StorageAdapter;
  /** When provided, an eventual layer whose store produces new state is marked stale for the next recall. */
  recallCache?: RecallCache;
}

interface SpawnLayersParams {
  layers: MemoryLayer[];
  parentCtx: ExecutionContext;
  childCtx: ExecutionContext;
  store: LayerStateStore;
  itemSchemas?: ItemSchemaRegistry;
  /**
   * When provided, durable write-through targets are registered for the child
   * execution (non-execution scopes only), so state written during the child's
   * run is mirrored durably just like the parent's.
   */
  storage?: StorageAdapter;
}

interface ReturnLayersParams<T = unknown> {
  layers: MemoryLayer[];
  parentCtx: ExecutionContext;
  childCtx: ExecutionContext;
  childLog: ItemLog;
  result: T;
  store: LayerStateStore;
}

interface CompleteLayersParams {
  layers: MemoryLayer[];
  ctx: ExecutionContext;
  log: ItemLog;
  outcome: 'success' | 'failure' | 'aborted';
  store: LayerStateStore;
}

interface DisposeLayersParams {
  layers: MemoryLayer[];
  ctx: ExecutionContext;
  store: LayerStateStore;
}

interface BeforeToolCallLayersParams {
  layers: MemoryLayer[];
  toolName: string;
  toolArgs: unknown;
  ctx: ExecutionContext;
  store: LayerStateStore;
}

interface AfterModelCallLayersParams {
  layers: MemoryLayer[];
  response: LLMResponse;
  ctx: ExecutionContext;
  store: LayerStateStore;
}

interface ProjectHistoryLayersParams {
  layers: MemoryLayer[];
  items: ReadonlyArray<Item>;
  ctx: ExecutionContext;
  store: LayerStateStore;
}

/** @public A request to re-render the context window, collected from onItemAppend hooks. */
export interface RerenderRequest {
  layerId: string;
  slot: number;
  timing: 'immediate' | 'batched';
  scope: 'self' | 'slot-after' | 'all';
}

/** @public Result of running items through the onItemAppend pipeline. */
export interface AppendPipelineResult {
  /** Final items to append after all transformations. */
  items: Item[];
  /** Re-render requests collected from layers. */
  rerenderRequests: RerenderRequest[];
}

interface RunAppendPipelineParams {
  layers: MemoryLayer[];
  items: Item[];
  ctx: ExecutionContext;
  log: ItemLog;
  store: LayerStateStore;
}

interface ExecuteRerenderParams {
  requests: RerenderRequest[];
  layers: MemoryLayer[];
  ctx: ExecutionContext;
  log: ItemLog;
  budgets: Map<string, number>;
  store: LayerStateStore;
  itemSchemas?: ItemSchemaRegistry;
  /** Query for context-aware recall (e.g., last user message) */
  query?: string;
  /** Current re-render depth (for loop protection) */
  depth?: number;
}

/** Maximum allowed re-render depth to prevent infinite loops */
const MAX_RERENDER_DEPTH = 3;

//#endregion

//#region Helper Functions

/** Per-(execution, layer) durable write-through bookkeeping. */
interface DurableEntry {
  layerId: string;
  target: ScopedStorage;
  /** Latest value to persist (latest-wins coalescing). */
  latest: unknown;
  /** True when `latest` has not been written yet. */
  dirty: boolean;
  /** The single in-flight write loop for this key, if any. */
  inFlight: Promise<void> | null;
}

export function createLayerStateStore(
  diagnostic?: (layerId: string, hook: string, error: unknown) => void,
): LayerStateStore {
  const states = new Map<string, Map<string, unknown>>();
  const durables = new Map<string, Map<string, DurableEntry>>();
  const disabled = new Map<string, Set<string>>();
  const report = diagnostic ?? ((): void => {});

  // One write loop per key: re-checks `dirty` after each write so a value set
  // mid-write is persisted by the same loop (coalesced, latest wins). Failures
  // are diagnostics only — durable mirroring must never break the agent.
  async function writeThrough(entry: DurableEntry): Promise<void> {
    while (entry.dirty) {
      entry.dirty = false;
      const value = entry.latest;
      try {
        if (value === undefined) {
          await entry.target.delete('state');
        } else {
          await entry.target.set('state', value);
        }
      } catch (e) {
        report(entry.layerId, 'persist', e);
      }
    }
    entry.inFlight = null;
  }

  return {
    get<T>(executionId: string, layerId: string): T | undefined {
      return frameworkCast<T | undefined>(states.get(executionId)?.get(layerId));
    },
    set<T>(executionId: string, layerId: string, state: T): void {
      let execMap = states.get(executionId);
      if (!execMap) {
        execMap = new Map();
        states.set(executionId, execMap);
      }
      execMap.set(layerId, state);

      const entry = durables.get(executionId)?.get(layerId);
      if (!entry) {
        return;
      }
      entry.latest = state;
      entry.dirty = true;
      if (!entry.inFlight) {
        entry.inFlight = writeThrough(entry);
      }
    },
    registerDurable(executionId: string, layerId: string, target: ScopedStorage): void {
      let execMap = durables.get(executionId);
      if (!execMap) {
        execMap = new Map();
        durables.set(executionId, execMap);
      }
      execMap.set(layerId, {
        layerId,
        target,
        latest: undefined,
        dirty: false,
        inFlight: null,
      });
    },
    async flush(executionId: string): Promise<void> {
      const execMap = durables.get(executionId);
      if (!execMap) {
        return;
      }
      await Promise.all(
        [
          ...execMap.values(),
        ].map((entry) => entry.inFlight ?? Promise.resolve()),
      );
    },
    disable(executionId: string, layerId: string): void {
      let set = disabled.get(executionId);
      if (!set) {
        set = new Set();
        disabled.set(executionId, set);
      }
      set.add(layerId);
    },
    isDisabled(executionId: string, layerId: string): boolean {
      return disabled.get(executionId)?.has(layerId) ?? false;
    },
    cleanup(executionId: string): void {
      states.delete(executionId);
      durables.delete(executionId);
      disabled.delete(executionId);
    },
    diagnostic: report,
  };
}

interface IsLayerDisabledParams {
  store: LayerStateStore;
  executionId: string;
  layer: MemoryLayer;
  state: unknown;
}

/**
 * Whether a layer is disabled for this execution (its `init` failed with
 * `onInitError: 'disable'`). Prefers the store's explicit tracking, so a
 * layer that legitimately cleared its state (`{ state: undefined }`) keeps
 * running with `undefined` state. Legacy stores without `isDisabled` fall
 * back to the old sentinel — an init-bearing layer with no state — which
 * cannot make that distinction.
 */
function isLayerDisabled({ store, executionId, layer, state }: IsLayerDisabledParams): boolean {
  if (store.isDisabled) {
    return store.isDisabled(executionId, layer.id);
  }
  return state === undefined && layer.hooks.init !== undefined;
}

//#region Recall Cache (eventual recall)

interface RecallCacheEntry {
  layerId: string;
  items: Item[];
  tokenCount: number;
}

/**
 * Per-harness memoization for `recallMode: 'eventual'` layers. Eventual recall
 * serves the cached entry when warm and re-runs only when `store()` produces new
 * state (which marks the entry stale), so a slow layer's `recall()` does not run
 * on every turn.
 */
export interface RecallCache {
  entries: Map<string, RecallCacheEntry>;
  stale: Set<string>;
}

export function createRecallCache(): RecallCache {
  return {
    entries: new Map(),
    stale: new Set(),
  };
}

/**
 * Cache key for eventual recall. Keyed by the layer's SCOPE key (not the
 * per-turn executionId) so the cache survives across turns within a session —
 * matching where the layer's state lives. An 'execution'-scoped layer's key
 * rotates each turn (so its eventual recall behaves like atomic), which is
 * correct since its state does not persist either.
 */
function recallCacheKey(layer: MemoryLayer, ctx: ExecutionContext): string {
  return `${resolveScopeKey(layer.scope, ctx)}:${layer.id}`;
}

//#endregion

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    }),
  ]);
}

export function mostRestrictive(decisions: SteeringDecision[]): SteeringDecision {
  const guidances: string[] = [];

  let hasGuide = false;
  for (const d of decisions) {
    if (d.action === SteeringAction.Deny) {
      return d;
    }
    if (d.action === SteeringAction.Guide) {
      hasGuide = true;
      // Collect every non-empty guidance — a guidance-less Guide must never
      // overwrite/drop guidance carried by another Guide.
      if (d.guidance) {
        guidances.push(d.guidance);
      }
    }
  }

  if (!hasGuide) {
    return {
      action: SteeringAction.Allow,
    };
  }
  return {
    action: SteeringAction.Guide,
    guidance: guidances.length > 0 ? guidances.join('\n') : undefined,
  };
}

function layerItemSchemas(
  layer: MemoryLayer,
  base = defaultItemSchemaRegistry,
): ItemSchemaRegistry {
  return base.extend(layer.itemSchemas);
}

//#endregion

//#region Public API

export async function initLayers({ layers, ctx, storage, store }: InitLayersParams): Promise<void> {
  // Sequential, array order
  for (const layer of layers) {
    if (!layer.hooks.init) {
      continue;
    }
    const scopeKey = resolveScopeKey(layer.scope, ctx);
    const scopedStorage = createScopedStorage(storage, layer.id, scopeKey);
    try {
      const timeout = layer.timeouts?.init ?? 1e4;
      const result = await withTimeout(
        layer.hooks.init({
          storage: scopedStorage,
          scopeKey,
          ctx,
        }),
        timeout,
      );
      store.set(ctx.executionId, layer.id, result.state);
    } catch (e) {
      store.diagnostic(layer.id, 'init', e);
      // Fail loud by default: a failed init silently disabling a load-bearing
      // layer (e.g. steering → fail-open) hides real errors. Opt into graceful
      // degradation per layer with `onInitError: 'disable'`.
      if (layer.onInitError !== 'disable') {
        throw e;
      }
      store.disable?.(ctx.executionId, layer.id);
    }
  }

  registerDurableTargets({
    layers,
    ctx,
    storage,
    store,
  });
}

/**
 * Register durable write-through targets for every non-execution-scope layer.
 * A separate pass, independent of `hooks.init`, run AFTER init's `set()` so
 * freshly-rehydrated state is not immediately rewritten to storage. From this
 * point on, ALL state writes through the store — provides functions,
 * beforeToolCall/afterModelCall, onComplete, onReturn, the append pipeline,
 * and `store()` hooks — are mirrored durably; `store()` is not special.
 * 'execution' scope is excluded: its scope key rotates each run, so there is
 * nothing durable to mirror.
 */
function registerDurableTargets({
  layers,
  ctx,
  storage,
  store,
}: {
  layers: MemoryLayer[];
  ctx: ExecutionContext;
  storage: StorageAdapter;
  store: LayerStateStore;
}): void {
  if (!store.registerDurable) {
    return;
  }
  for (const layer of layers) {
    if (layer.scope === 'execution') {
      continue;
    }
    const scopeKey = resolveScopeKey(layer.scope, ctx);
    store.registerDurable(
      ctx.executionId,
      layer.id,
      createScopedStorage(storage, layer.id, scopeKey),
    );
  }
}

export async function recallLayers({
  layers,
  query,
  ctx,
  log,
  budgets,
  store,
  itemSchemas = defaultItemSchemaRegistry,
}: RecallLayersParams): Promise<
  {
    layerId: string;
    items: Item[];
    tokenCount: number;
  }[]
> {
  const sorted = [
    ...layers,
  ].sort((a, b) => a.slot - b.slot);
  const results: {
    layerId: string;
    items: Item[];
    tokenCount: number;
  }[] = [];

  for (const layer of sorted) {
    if (!layer.hooks.recall) {
      continue;
    }
    const state = store.get(ctx.executionId, layer.id);
    if (
      isLayerDisabled({
        store,
        executionId: ctx.executionId,
        layer,
        state,
      })
    ) {
      continue; // was disabled
    }

    const budget = budgets.get(layer.id) ?? 0;
    try {
      const timeout = layer.timeouts?.recall ?? 5e3;
      const result = await withTimeout(
        layer.hooks.recall({
          log,
          query,
          ctx,
          state,
          budget,
        }),
        timeout,
      );
      if (!result) {
        continue;
      }
      const layerSchemas = layerItemSchemas(layer, itemSchemas);
      if (typeof result === 'string') {
        results.push({
          layerId: layer.id,
          items: [
            layerSchemas.parseWithCategory(createMessage(result, 'developer'), 'developerMessages'),
          ],
          tokenCount: estimateTokens(result),
        });
        continue;
      }
      results.push({
        layerId: layer.id,
        items: layerSchemas.parseMany(result.items),
        tokenCount: result.tokenCount,
      });
      if (result.state !== undefined) {
        store.set(ctx.executionId, layer.id, result.state);
      }
    } catch (e) {
      store.diagnostic(layer.id, 'recall', e);
    }
  }

  return results;
}

type RecallEntry = {
  layerId: string;
  items: Item[];
  tokenCount: number;
};

interface RecallLayersModeParams extends RecallLayersParams {
  /** When true, treat every layer as atomic regardless of its `recallMode`. */
  forceAtomic?: boolean;
}

/**
 * Recall the layers that must complete before the model call: those with
 * `recallMode !== 'eventual'`, or every layer when `forceAtomic` is set.
 */
export async function recallLayersAtomic({
  forceAtomic,
  ...params
}: RecallLayersModeParams): Promise<RecallEntry[]> {
  const atomicLayers = forceAtomic
    ? params.layers
    : params.layers.filter((l) => l.recallMode !== 'eventual');
  return recallLayers({
    ...params,
    layers: atomicLayers,
  });
}

interface RecallLayersEventualParams extends RecallLayersModeParams {
  cache: RecallCache;
}

/**
 * Recall `recallMode: 'eventual'` layers, served from {@link RecallCache}.
 * A cold or store-invalidated (stale) entry is recalled and cached; a warm
 * entry is returned as-is, so an eventual layer's `recall()` runs only after
 * its `store()` produces new state. Returns nothing when `forceAtomic` is set —
 * those layers are then handled by {@link recallLayersAtomic} instead.
 */
export async function recallLayersEventual({
  cache,
  forceAtomic,
  ...params
}: RecallLayersEventualParams): Promise<RecallEntry[]> {
  if (forceAtomic) {
    return [];
  }
  const eventualLayers = params.layers.filter((l) => l.recallMode === 'eventual');
  if (eventualLayers.length === 0) {
    return [];
  }

  const results: RecallEntry[] = [];
  for (const layer of eventualLayers) {
    const key = recallCacheKey(layer, params.ctx);
    const cached = cache.entries.get(key);
    const isStale = cache.stale.has(key);

    if (!cached || isStale) {
      const recalled = await recallLayers({
        ...params,
        layers: [
          layer,
        ],
      });
      for (const entry of recalled) {
        cache.entries.set(key, entry);
        results.push(entry);
      }
      cache.stale.delete(key);
      continue;
    }

    results.push(cached);
  }

  return results;
}

export async function storeLayers({
  layers,
  response,
  ctx,
  log,
  store,
  recallCache,
}: StoreLayersParams): Promise<void> {
  // Concurrent via Promise.allSettled — each layer gets its own state snapshot
  const snapshots: {
    layer: MemoryLayer;
    state: unknown;
    storeFn: NonNullable<MemoryLayer['hooks']['store']>;
  }[] = [];
  for (const layer of layers) {
    if (!layer.hooks.store) {
      continue;
    }
    const state = store.get(ctx.executionId, layer.id);
    if (
      isLayerDisabled({
        store,
        executionId: ctx.executionId,
        layer,
        state,
      })
    ) {
      continue;
    }
    snapshots.push({
      layer,
      state,
      storeFn: layer.hooks.store,
    });
  }

  await Promise.allSettled(
    snapshots.map(async ({ layer, state, storeFn }) => {
      const timeout = layer.timeouts?.store ?? 3e4;
      try {
        const result = await withTimeout(
          storeFn({
            newItems: response.items,
            log,
            response,
            ctx,
            state,
          }),
          timeout,
        );
        // `'state' in result` (not `!== undefined`) so a layer can explicitly
        // clear its state by returning `{ state: undefined }`. The store's
        // durable write-through mirrors the write (clearing deletes the
        // durable key) — no inline mirror needed here.
        if (result && 'state' in result) {
          store.set(ctx.executionId, layer.id, result.state);
          // Invalidate this layer's eventual-recall cache so the next turn
          // re-runs recall() against the freshly stored state.
          if (recallCache && layer.recallMode === 'eventual') {
            recallCache.stale.add(recallCacheKey(layer, ctx));
          }
        }
      } catch (e) {
        store.diagnostic(layer.id, 'store', e);
      }
    }),
  );

  await store.flush?.(ctx.executionId);
}

export async function disposeLayers({ layers, ctx, store }: DisposeLayersParams): Promise<void> {
  // Sequential, REVERSE array order
  const reversed = [
    ...layers,
  ].reverse();
  for (const layer of reversed) {
    if (!layer.hooks.dispose) {
      continue;
    }
    const state = store.get(ctx.executionId, layer.id);
    // Skip disabled layers (init hook present but no state) — consistent with
    // recall/store; nothing was initialized, so there is nothing to dispose.
    if (
      isLayerDisabled({
        store,
        executionId: ctx.executionId,
        layer,
        state,
      })
    ) {
      continue;
    }
    try {
      const timeout = layer.timeouts?.dispose ?? 5e3;
      await withTimeout(
        layer.hooks.dispose({
          state,
        }),
        timeout,
      );
    } catch (e) {
      store.diagnostic(layer.id, 'dispose', e);
    }
  }
  // Settle any in-flight durable mirror writes before dropping registrations.
  await store.flush?.(ctx.executionId);
  store.cleanup(ctx.executionId);
}

export async function spawnLayers({
  layers,
  parentCtx,
  childCtx,
  store,
  itemSchemas = defaultItemSchemaRegistry,
  storage,
}: SpawnLayersParams): Promise<
  {
    layerId: string;
    childState: unknown;
    items: Item[];
  }[]
> {
  if (storage) {
    registerDurableTargets({
      layers,
      ctx: childCtx,
      storage,
      store,
    });
  }
  const results: {
    layerId: string;
    childState: unknown;
    items: Item[];
  }[] = [];
  const sorted = [
    ...layers,
  ].sort((a, b) => a.slot - b.slot);
  for (const layer of sorted) {
    if (!layer.hooks.onSpawn) {
      continue;
    }
    const parentState = store.get(parentCtx.executionId, layer.id);
    // Skip only disabled layers (init present but no state). An init-less layer
    // has legitimately undefined state and should still spawn — consistent with
    // how recall treats init-less layers.
    if (
      isLayerDisabled({
        store,
        executionId: parentCtx.executionId,
        layer,
        state: parentState,
      })
    ) {
      continue;
    }
    try {
      const timeout = layer.timeouts?.onSpawn ?? 1e4;
      const result = await withTimeout(
        layer.hooks.onSpawn({
          parentState,
          childCtx,
        }),
        timeout,
      );
      if (result && result.childState !== null) {
        store.set(childCtx.executionId, layer.id, result.childState);
        results.push({
          layerId: layer.id,
          childState: result.childState,
          items: layerItemSchemas(layer, itemSchemas).parseMany(result.items ?? []),
        });
      }
    } catch (e) {
      store.diagnostic(layer.id, 'onSpawn', e);
    }
  }
  return results;
}

export async function returnLayers<T>({
  layers,
  parentCtx,
  childCtx,
  childLog,
  result,
  store,
}: ReturnLayersParams<T>): Promise<T> {
  const sorted = [
    ...layers,
  ].sort((a, b) => a.slot - b.slot);
  let currentResult: unknown = result;

  for (const layer of sorted) {
    if (!layer.hooks.onReturn) {
      continue;
    }
    const childState = store.get(childCtx.executionId, layer.id);
    const parentState = store.get(parentCtx.executionId, layer.id);
    // Only the child's contribution is required to merge; a parent that never
    // initialized state can still be seeded from the child. Skip only when the
    // child produced nothing.
    if (childState === undefined) {
      continue;
    }
    try {
      const timeout = layer.timeouts?.onReturn ?? 1e4;
      const returnResult = await withTimeout(
        layer.hooks.onReturn({
          childState,
          childLog,
          parentState,
          result: currentResult,
        }),
        timeout,
      );
      if (returnResult?.parentState !== undefined) {
        store.set(parentCtx.executionId, layer.id, returnResult.parentState);
      }
      if (returnResult?.result !== undefined) {
        currentResult = returnResult.result;
      }
    } catch (e) {
      store.diagnostic(layer.id, 'onReturn', e);
    }
  }

  // The child execution's store is typically cleaned up right after onReturn —
  // settle both sides' durable mirror writes before that happens.
  await store.flush?.(parentCtx.executionId);
  await store.flush?.(childCtx.executionId);

  return frameworkCast<T>(currentResult);
}

export async function completeLayers({
  layers,
  ctx,
  log,
  outcome,
  store,
}: CompleteLayersParams): Promise<void> {
  for (const layer of layers) {
    if (!layer.hooks.onComplete) {
      continue;
    }
    const state = store.get(ctx.executionId, layer.id);
    // Skip disabled layers (init present but no state) — consistent with the
    // rest of the lifecycle; avoids invoking onComplete with undefined state.
    if (
      isLayerDisabled({
        store,
        executionId: ctx.executionId,
        layer,
        state,
      })
    ) {
      continue;
    }
    try {
      const timeout = layer.timeouts?.onComplete ?? 3e4;
      const result = await withTimeout(
        layer.hooks.onComplete({
          log,
          ctx,
          state,
          outcome,
        }),
        timeout,
      );
      if (result && 'state' in result) {
        store.set(ctx.executionId, layer.id, result.state);
      }
    } catch (e) {
      store.diagnostic(layer.id, 'onComplete', e);
    }
  }

  await store.flush?.(ctx.executionId);
}

export async function beforeToolCallLayers({
  layers,
  toolName,
  toolArgs,
  ctx,
  store,
}: BeforeToolCallLayersParams): Promise<SteeringDecision> {
  const sorted = [
    ...layers,
  ].sort((a, b) => a.slot - b.slot);
  const decisions: SteeringDecision[] = [];

  for (const layer of sorted) {
    if (!layer.hooks.beforeToolCall) {
      continue;
    }
    const state = store.get(ctx.executionId, layer.id);
    if (
      isLayerDisabled({
        store,
        executionId: ctx.executionId,
        layer,
        state,
      })
    ) {
      continue;
    }
    try {
      const timeout = layer.timeouts?.beforeToolCall ?? 5e3;
      const result = await withTimeout(
        layer.hooks.beforeToolCall({
          toolName,
          toolArgs,
          ctx,
          state,
        }),
        timeout,
      );
      if (result.state !== undefined) {
        store.set(ctx.executionId, layer.id, result.state);
      }
      if (result.decision.action === SteeringAction.Deny) {
        return result.decision;
      }
      decisions.push(result.decision);
    } catch (e) {
      if (e instanceof NoeticConfigError) {
        throw e;
      }
      store.diagnostic(layer.id, 'beforeToolCall', e);
    }
  }

  return mostRestrictive(decisions);
}

export async function afterModelCallLayers({
  layers,
  response,
  ctx,
  store,
}: AfterModelCallLayersParams): Promise<SteeringDecision> {
  const sorted = [
    ...layers,
  ].sort((a, b) => a.slot - b.slot);
  const decisions: SteeringDecision[] = [];

  for (const layer of sorted) {
    if (!layer.hooks.afterModelCall) {
      continue;
    }
    const state = store.get(ctx.executionId, layer.id);
    if (
      isLayerDisabled({
        store,
        executionId: ctx.executionId,
        layer,
        state,
      })
    ) {
      continue;
    }
    try {
      const timeout = layer.timeouts?.afterModelCall ?? 1e4;
      const result = await withTimeout(
        layer.hooks.afterModelCall({
          response,
          ctx,
          state,
        }),
        timeout,
      );
      if (result.state !== undefined) {
        store.set(ctx.executionId, layer.id, result.state);
      }
      if (result.decision.action === SteeringAction.Deny) {
        return result.decision;
      }
      decisions.push(result.decision);
    } catch (e) {
      if (e instanceof NoeticConfigError) {
        throw e;
      }
      store.diagnostic(layer.id, 'afterModelCall', e);
    }
  }

  return mostRestrictive(decisions);
}

/**
 * Run history items through every layer's `projectHistory` hook in slot order.
 * Each layer receives the previous layer's output. Storage (`itemLog`) is
 * never mutated — this is a pure projection over the input array. Returns
 * the projected items unchanged when no layer registers the hook.
 */
export async function projectHistoryLayers({
  layers,
  items,
  ctx,
  store,
}: ProjectHistoryLayersParams): Promise<ReadonlyArray<Item>> {
  const sorted = [
    ...layers,
  ].sort((a, b) => a.slot - b.slot);
  let current: ReadonlyArray<Item> = items;

  for (const layer of sorted) {
    if (!layer.hooks.projectHistory) {
      continue;
    }
    const state = store.get(ctx.executionId, layer.id);
    if (
      isLayerDisabled({
        store,
        executionId: ctx.executionId,
        layer,
        state,
      })
    ) {
      continue;
    }
    try {
      const timeout = layer.timeouts?.projectHistory ?? 5e3;
      const result = await withTimeout(
        layer.hooks.projectHistory({
          items: current,
          ctx,
          state,
        }),
        timeout,
      );
      current = result.items;
    } catch (e) {
      store.diagnostic(layer.id, 'projectHistory', e);
    }
  }

  return current;
}

const DEFAULT_ON_ITEM_APPEND_TIMEOUT = 5e3;

/**
 * Run items through the onItemAppend pipeline.
 * Each layer can filter, transform, or inject items.
 * Returns final items to append and any re-render requests.
 */
export async function runAppendPipeline({
  layers,
  items,
  ctx,
  log,
  store,
}: RunAppendPipelineParams): Promise<AppendPipelineResult> {
  const requests: RerenderRequest[] = [];
  let currentItems = items;

  // Run pipeline in slot order
  const sorted = [
    ...layers,
  ].sort((a, b) => a.slot - b.slot);

  for (const layer of sorted) {
    if (!layer.hooks.onItemAppend) {
      continue;
    }

    // Skip if no items left (all filtered by previous layer)
    if (currentItems.length === 0) {
      break;
    }

    const state = store.get(ctx.executionId, layer.id);
    // Skip if layer was disabled (has init but no state)
    if (
      isLayerDisabled({
        store,
        executionId: ctx.executionId,
        layer,
        state,
      })
    ) {
      continue;
    }

    try {
      const timeout = layer.timeouts?.onItemAppend ?? DEFAULT_ON_ITEM_APPEND_TIMEOUT;
      const result = await withTimeout(
        layer.hooks.onItemAppend({
          items: currentItems,
          log,
          ctx,
          state,
        }),
        timeout,
      );

      // Update items for next layer in pipeline
      currentItems = result.items;

      // Update state if provided
      if (result.state !== undefined) {
        store.set(ctx.executionId, layer.id, result.state);
      }

      // Collect re-render request if present
      if (result.rerender) {
        requests.push({
          layerId: layer.id,
          slot: layer.slot,
          timing: result.timing ?? layer.rerenderTiming ?? 'batched',
          scope: result.scope ?? 'slot-after',
        });
      }
    } catch (e) {
      store.diagnostic(layer.id, 'onItemAppend', e);
      // On error, pass through items unchanged for this layer
    }
  }

  return {
    items: currentItems,
    rerenderRequests: requests,
  };
}

/**
 * Execute re-render based on collected requests.
 * Determines which layers need re-recall based on scope and runs them.
 * Returns new recall results to merge into view.
 */
export async function executeRerender({
  requests,
  layers,
  ctx,
  log,
  budgets,
  store,
  itemSchemas,
  query = '',
  depth = 0,
}: ExecuteRerenderParams): Promise<
  {
    layerId: string;
    items: Item[];
    tokenCount: number;
  }[]
> {
  if (requests.length === 0) {
    return [];
  }

  // Prevent infinite re-render loops
  if (depth >= MAX_RERENDER_DEPTH) {
    // Log warning and return empty - don't throw to avoid breaking the flow
    console.warn(
      `[noetic] Re-render depth exceeded (${depth} >= ${MAX_RERENDER_DEPTH}). ` +
        'Possible infinite re-render loop detected. Stopping re-render cascade.',
    );
    return [];
  }

  // Determine which layers need re-recall based on scope
  const layersToRecall = new Set<string>();

  for (const req of requests) {
    switch (req.scope) {
      case 'self':
        layersToRecall.add(req.layerId);
        break;
      case 'slot-after':
        for (const layer of layers) {
          if (layer.slot >= req.slot) {
            layersToRecall.add(layer.id);
          }
        }
        break;
      case 'all':
        for (const layer of layers) {
          layersToRecall.add(layer.id);
        }
        break;
    }
  }

  // Re-run recall for affected layers
  const affectedLayers = layers
    .filter((l) => layersToRecall.has(l.id))
    .sort((a, b) => a.slot - b.slot);

  // Use existing recallLayers with filtered layers
  return recallLayers({
    layers: affectedLayers,
    query,
    ctx,
    log,
    budgets,
    store,
    itemSchemas,
  });
}

//#endregion
