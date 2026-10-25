import type {
  ContextLayer,
  DecisionRecord,
  ExecutionContext,
  Item,
  ItemLog,
  ItemSchemaRegistry,
  LayerTraceSpan,
  LLMResponse,
  RecallResult,
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
  NoeticErrorImpl,
  SteeringAction,
} from '@noetic-tools/types';
import { callHook, traceSkipped, withTimeout } from './hook-call';
import { createScopedStorage, resolveScopeKey } from './scope';

//#region Types

export interface LayerStateStore {
  get<T>(executionId: string, layerId: string): T | undefined;
  set<T>(executionId: string, layerId: string, state: T): void;
  /**
   * Whether ANY state entry exists for the (execution, layer) pair — including
   * an explicit `undefined` written by a layer clearing its state. This is what
   * lets the lifecycle distinguish "init never ran for this execution" (no
   * entry → an init-bearing layer is skipped) from "layer legitimately cleared
   * its state" (entry present → hooks keep running with `undefined` state).
   * Optional so custom stores keep compiling; without it, the lifecycle falls
   * back to the legacy sentinel (init-bearing layer with no state is skipped).
   */
  has?(executionId: string, layerId: string): boolean;
  cleanup(executionId: string): void;
  /**
   * Forget one layer's state, durable target, and disabled mark for an
   * execution, leaving the execution's other layers alone. Optional so custom
   * stores keep compiling; without it, a scoped dispose leaves the state in
   * place for the next `init` to overwrite.
   */
  drop?(executionId: string, layerId: string): void;
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
   * `onInitError: 'disable'`, or its `onSpawn` returned `null` or failed for
   * a child execution). Disabled layers are skipped by every later
   * hook. Optional so custom stores keep compiling; without explicit
   * tracking, the lifecycle falls back to the legacy sentinel (init-bearing
   * layer with no state).
   */
  disable?(executionId: string, layerId: string): void;
  /** Whether a layer was disabled for an execution. */
  isDisabled?(executionId: string, layerId: string): boolean;
}

interface InitLayersParams {
  layers: ContextLayer[];
  ctx: ExecutionContext;
  storage: StorageAdapter;
  store: LayerStateStore;
  /**
   * Skip `init` for layers that already hold state for this execution. Set for
   * an execution restored from a checkpoint, whose snapshot state `init` would
   * otherwise overwrite with a fresh start.
   */
  keep?: boolean;
}

interface RecallLayersParams {
  layers: ContextLayer[];
  query: string;
  ctx: ExecutionContext;
  log: ItemLog;
  budgets: Map<string, number>;
  store: LayerStateStore;
  itemSchemas?: ItemSchemaRegistry;
  /** Render without committing returned state. See `RecallOptions.peek`. */
  peek?: boolean;
}

interface StoreLayersParams {
  layers: ContextLayer[];
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
  layers: ContextLayer[];
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
  layers: ContextLayer[];
  /**
   * Id of the spawn (or inParallel) step whose child is returning. Names the
   * step in `spawn_summary_failed` diagnostics; defaults to the child's
   * execution id.
   */
  stepId?: string;
  parentCtx: ExecutionContext;
  childCtx: ExecutionContext;
  childLog: ItemLog;
  result: T;
  store: LayerStateStore;
}

interface CompleteLayersParams {
  layers: ContextLayer[];
  ctx: ExecutionContext;
  log: ItemLog;
  outcome: 'success' | 'failure' | 'aborted';
  store: LayerStateStore;
}

interface DisposeLayersParams {
  layers: ContextLayer[];
  ctx: ExecutionContext;
  store: LayerStateStore;
  /**
   * The layers share their execution with layers that stay live (a
   * `withContext` boundary closing). Drop only these layers' state instead of
   * cleaning up the whole execution.
   */
  scoped?: boolean;
}

interface BeforeToolCallLayersParams {
  layers: ContextLayer[];
  toolName: string;
  toolArgs: unknown;
  callId?: string;
  ctx: ExecutionContext;
  store: LayerStateStore;
}

interface AfterModelCallLayersParams {
  layers: ContextLayer[];
  response: LLMResponse;
  ctx: ExecutionContext;
  store: LayerStateStore;
}

interface ProjectHistoryLayersParams {
  layers: ContextLayer[];
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
  layers: ContextLayer[];
  items: Item[];
  ctx: ExecutionContext;
  log: ItemLog;
  store: LayerStateStore;
}

interface ExecuteRerenderParams {
  requests: RerenderRequest[];
  layers: ContextLayer[];
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
    has(executionId: string, layerId: string): boolean {
      return states.get(executionId)?.has(layerId) ?? false;
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
    drop(executionId: string, layerId: string): void {
      states.get(executionId)?.delete(layerId);
      durables.get(executionId)?.delete(layerId);
      disabled.get(executionId)?.delete(layerId);
    },
    diagnostic: report,
  };
}

interface IsLayerDisabledParams {
  store: LayerStateStore;
  executionId: string;
  layer: ContextLayer;
  state: unknown;
}

/**
 * Whether a layer must be skipped for this execution — either explicitly
 * disabled (its `init` failed with `onInitError: 'disable'`) or never
 * initialized (init-bearing layer whose `init` did not run for this
 * execution, e.g. a bare `harness.run()` outside a session). A layer that
 * legitimately cleared its state (`{ state: undefined }`) has a state ENTRY
 * (see `LayerStateStore.has`) and keeps running with `undefined` state.
 * Legacy stores without `has` fall back to the old sentinel — an init-bearing
 * layer with no state — which cannot make that distinction.
 */
function isLayerDisabled({ store, executionId, layer, state }: IsLayerDisabledParams): boolean {
  if (store.isDisabled?.(executionId, layer.id)) {
    return true;
  }
  if (state !== undefined || layer.hooks.init === undefined) {
    return false;
  }
  // Init-bearing layer with no state in hand: skip when no entry was ever
  // written (uninitialized); keep running when the state was explicitly
  // cleared. Stores without `has` cannot tell the two apart → legacy skip.
  if (store.has) {
    return !store.has(executionId, layer.id);
  }
  return true;
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
function recallCacheKey(layer: ContextLayer, ctx: ExecutionContext): string {
  return `${resolveScopeKey(layer.scope, ctx)}:${layer.id}`;
}

//#endregion

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
  layer: ContextLayer,
  base = defaultItemSchemaRegistry,
): ItemSchemaRegistry {
  return base.extend(layer.itemSchemas);
}

/** Span event added to the child's span when a layer's `onReturn` hook fails. */
export const SPAWN_SUMMARY_FAILED_EVENT = 'spawn.summary_failed';

interface SummaryFailure {
  layerId: string;
  stepId: string;
  childOutput: unknown;
  cause: unknown;
  childCtx: ExecutionContext;
  store: LayerStateStore;
}

function reportSummaryFailure({
  layerId,
  stepId,
  childOutput,
  cause,
  childCtx,
  store,
}: SummaryFailure): void {
  const summaryCause = cause instanceof Error ? cause : new Error(String(cause));
  const error = new NoeticErrorImpl({
    kind: 'spawn_summary_failed',
    stepId,
    childOutput,
    summaryCause,
  });
  childCtx.trace.addEvent(SPAWN_SUMMARY_FAILED_EVENT, {
    stepId,
    layerId,
    message: summaryCause.message,
  });
  store.diagnostic(layerId, 'onReturn', error);
}

//#endregion

//#region Public API

export async function initLayers({
  layers,
  ctx,
  storage,
  store,
  keep = false,
}: InitLayersParams): Promise<void> {
  // Sequential, array order
  for (const layer of layers) {
    if (!layer.hooks.init) {
      continue;
    }
    const init = layer.hooks.init;
    if (keep && store.has?.(ctx.executionId, layer.id)) {
      traceSkipped(ctx, layer.id, 'init');
      continue;
    }
    const scopeKey = resolveScopeKey(layer.scope, ctx);
    const scopedStorage = createScopedStorage(storage, layer.id, scopeKey);
    try {
      const result = await callHook({
        ctx,
        layerId: layer.id,
        hook: 'init',
        timeout: layer.timeouts?.init ?? 1e4,
        run: () =>
          init({
            storage: scopedStorage,
            scopeKey,
            ctx,
          }),
      });
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
  layers: ContextLayer[];
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
  peek = false,
}: RecallLayersParams): Promise<RecallEntry[]> {
  const sorted = [
    ...layers,
  ].sort((a, b) => a.slot - b.slot);
  const results: RecallEntry[] = [];

  for (const layer of sorted) {
    if (!layer.hooks.recall) {
      continue;
    }
    const stored = store.get(ctx.executionId, layer.id);
    if (
      isLayerDisabled({
        store,
        executionId: ctx.executionId,
        layer,
        state: stored,
      })
    ) {
      if (!peek) {
        traceSkipped(ctx, layer.id, 'recall');
      }
      continue; // was disabled
    }
    // Skipping the write is not enough for a peek: a hook may mutate the
    // stored object in place (steering splices its queue), so it gets a copy.
    const state = peek ? copyForPeek(stored) : stored;
    if (peek && state === PEEK_UNSAFE) {
      continue;
    }

    const budget = budgets.get(layer.id) ?? 0;
    const recall = layer.hooks.recall;
    const run = () =>
      recall({
        log,
        query,
        ctx,
        state,
        budget,
      });
    const timeout = layer.timeouts?.recall ?? 5e3;
    try {
      // A peek renders without leaving a trace, so it records no event either.
      const result = peek
        ? await withTimeout(run(), timeout)
        : await callHook({
            ctx,
            layerId: layer.id,
            hook: 'recall',
            timeout,
            run,
            measure: (output) => measureRecall(output, budget),
          });
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
      // Returning state means the render changed something, so it cannot be
      // replayed from a pin — flag it so view assembly never anchors it.
      const mutatedState = result.state !== undefined;
      results.push({
        layerId: layer.id,
        items: layerSchemas.parseMany(result.items),
        tokenCount: result.tokenCount,
        mutatedState,
      });
      if (mutatedState && !peek) {
        store.set(ctx.executionId, layer.id, result.state);
      }
    } catch (e) {
      store.diagnostic(layer.id, 'recall', e);
    }
  }

  return results;
}

const PEEK_UNSAFE = Symbol('peek-unsafe');

/** Budget and item count for a `layer.hook` recall event. */
function measureRecall(
  output: RecallResult | string | null | undefined,
  allocated: number,
): Pick<LayerTraceSpan, 'budget' | 'itemCount'> {
  const measured = (used: number, itemCount: number) => ({
    budget: {
      allocated,
      used,
      yielded: Math.max(0, allocated - used),
    },
    itemCount,
  });
  if (!output) {
    return measured(0, 0);
  }
  if (typeof output === 'string') {
    return measured(estimateTokens(output), 1);
  }
  return measured(output.tokenCount, output.items.length);
}

/** A deep copy, or `PEEK_UNSAFE` when the state cannot be copied (it holds functions). */
function copyForPeek(state: unknown): unknown {
  try {
    return structuredClone(state);
  } catch {
    return PEEK_UNSAFE;
  }
}

type RecallEntry = {
  layerId: string;
  items: Item[];
  tokenCount: number;
  /** See `RecallLayerOutput.mutatedState` — set when `recall` returned new state. */
  mutatedState?: boolean;
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

    // A peek renders a cold or stale layer but leaves the cache as it found it,
    // so the next real recall still sees the entry as needing a render.
    if (params.peek && (!cached || isStale)) {
      results.push(
        ...(await recallLayers({
          ...params,
          layers: [
            layer,
          ],
        })),
      );
      continue;
    }

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

    // Serving from cache commits nothing, so the flag from the render that
    // populated it must not ride along — it would force the layer out of the
    // anchor band for good, on turns where its recall never even ran.
    results.push({
      ...cached,
      mutatedState: false,
    });
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
    layer: ContextLayer;
    state: unknown;
    storeFn: NonNullable<ContextLayer['hooks']['store']>;
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
      traceSkipped(ctx, layer.id, 'store');
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
      try {
        const result = await callHook({
          ctx,
          layerId: layer.id,
          hook: 'store',
          timeout: layer.timeouts?.store ?? 3e4,
          run: () =>
            storeFn({
              newItems: response.items,
              log,
              response,
              ctx,
              state,
            }),
        });
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

interface NotifyDecisionParams {
  layers: ContextLayer[];
  record: DecisionRecord;
  ctx: ExecutionContext;
  store: LayerStateStore;
  recallCache?: RecallCache;
}

/**
 * Run each layer's `onDecision` hook in slot order. Sequential, unlike
 * `storeLayers`: decisions are small and ordered, and a later layer may read
 * what an earlier one recorded.
 */
export async function notifyDecision({
  layers,
  record,
  ctx,
  store,
  recallCache,
}: NotifyDecisionParams): Promise<void> {
  const sorted = [
    ...layers,
  ].sort((a, b) => a.slot - b.slot);
  for (const layer of sorted) {
    if (!layer.hooks.onDecision) {
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
      const result = await withTimeout(
        layer.hooks.onDecision({
          state,
          record,
          ctx,
        }),
        layer.timeouts?.onDecision ?? 5e3,
      );
      if (result && 'state' in result) {
        store.set(ctx.executionId, layer.id, result.state);
        if (recallCache && layer.recallMode === 'eventual') {
          recallCache.stale.add(recallCacheKey(layer, ctx));
        }
      }
    } catch (e) {
      store.diagnostic(layer.id, 'onDecision', e);
    }
  }
  await store.flush?.(ctx.executionId);
}

export async function disposeLayers({
  layers,
  ctx,
  store,
  scoped = false,
}: DisposeLayersParams): Promise<void> {
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
      traceSkipped(ctx, layer.id, 'dispose');
      continue;
    }
    const dispose = layer.hooks.dispose;
    try {
      await callHook({
        ctx,
        layerId: layer.id,
        hook: 'dispose',
        timeout: layer.timeouts?.dispose ?? 5e3,
        run: () =>
          dispose({
            state,
          }),
      });
    } catch (e) {
      store.diagnostic(layer.id, 'dispose', e);
    }
  }
  // Settle any in-flight durable mirror writes before dropping registrations.
  await store.flush?.(ctx.executionId);
  if (!scoped) {
    store.cleanup(ctx.executionId);
    return;
  }
  for (const layer of layers) {
    store.drop?.(ctx.executionId, layer.id);
  }
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
      traceSkipped(parentCtx, layer.id, 'onSpawn');
      continue;
    }
    const onSpawn = layer.hooks.onSpawn;
    try {
      const result = await callHook({
        ctx: parentCtx,
        layerId: layer.id,
        hook: 'onSpawn',
        timeout: layer.timeouts?.onSpawn ?? 1e4,
        run: () =>
          onSpawn({
            parentState,
            childCtx,
          }),
      });
      // A `null` result opts the layer out of this child: every later hook
      // skips it for the child's execution.
      if (!result) {
        store.disable?.(childCtx.executionId, layer.id);
        continue;
      }
      // `childState: null` still injects items; the child just gets no state.
      if (result.childState !== null) {
        store.set(childCtx.executionId, layer.id, result.childState);
      }
      results.push({
        layerId: layer.id,
        childState: result.childState,
        items: layerItemSchemas(layer, itemSchemas).parseMany(result.items ?? []),
      });
    } catch (e) {
      store.diagnostic(layer.id, 'onSpawn', e);
      store.disable?.(childCtx.executionId, layer.id);
    }
  }
  return results;
}

/**
 * Pipes a child's result through each layer's `onReturn` hook in slot order.
 *
 * A failing hook never fails the spawn: the child's work already succeeded,
 * so the result passes on unchanged and the failure is reported as a
 * `spawn_summary_failed` diagnostic plus a span event on the child's span.
 */
export async function returnLayers<T>({
  layers,
  stepId,
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
      traceSkipped(childCtx, layer.id, 'onReturn');
      continue;
    }
    const onReturn = layer.hooks.onReturn;
    try {
      const returnResult = await callHook({
        ctx: childCtx,
        layerId: layer.id,
        hook: 'onReturn',
        timeout: layer.timeouts?.onReturn ?? 1e4,
        run: () =>
          onReturn({
            childState,
            childLog,
            parentState,
            result: currentResult,
            childCtx,
          }),
      });
      if (returnResult?.parentState !== undefined) {
        store.set(parentCtx.executionId, layer.id, returnResult.parentState);
      }
      if (returnResult?.result !== undefined) {
        currentResult = returnResult.result;
      }
    } catch (e) {
      reportSummaryFailure({
        layerId: layer.id,
        stepId: stepId ?? childCtx.executionId,
        childOutput: currentResult,
        cause: e,
        childCtx,
        store,
      });
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
      traceSkipped(ctx, layer.id, 'onComplete');
      continue;
    }
    const onComplete = layer.hooks.onComplete;
    try {
      const result = await callHook({
        ctx,
        layerId: layer.id,
        hook: 'onComplete',
        timeout: layer.timeouts?.onComplete ?? 3e4,
        run: () =>
          onComplete({
            log,
            ctx,
            state,
            outcome,
          }),
      });
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
  callId,
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
          callId,
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
      // A permission GATE must fail closed: a hook that threw or timed out is
      // a check that did not run, and for a gating layer that means deny, not
      // the silent approval an abstention would collapse into.
      if (layer.onBeforeToolCallError === 'deny') {
        return {
          action: SteeringAction.Deny,
          guidance: `tool call denied: gating layer '${layer.id}' failed (${e instanceof Error ? e.message : String(e)})`,
        };
      }
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
