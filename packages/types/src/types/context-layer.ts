import type { ZodType } from 'zod';
import type { LLMResponse } from './common';
import type { ItemLog } from './context-parts/item-log';
import type { ContextScope, ExecutionContext, ExecutionOutcome } from './context-scope';
import type { Item, ItemSchemaExtensions } from './items';
import type {
  AfterModelCallParams,
  AfterModelCallResult,
  BeforeToolCallParams,
  BeforeToolCallResult,
} from './steering';

/** @public Isolation scope controlling how a context layer's state is keyed and shared. */
export type BudgetConfig =
  | number
  | {
      min: number;
      max: number;
    }
  | 'auto';

/** @public Per-hook timeout overrides in milliseconds for a context layer. */
export interface LayerTimeouts {
  init?: number;
  recall?: number;
  store?: number;
  onSpawn?: number;
  onReturn?: number;
  onComplete?: number;
  dispose?: number;
  beforeToolCall?: number;
  afterModelCall?: number;
  onItemAppend?: number;
  projectHistory?: number;
}

/** @public A read-only data projection from layer state, accessible via `ctx.context['layerId'].prop`. */
export interface LayerDataDecl<T = unknown, TState = unknown> {
  kind: 'data';
  /** Project a value from the layer's current state. Method syntax enables bivariant assignability. */
  read(state: TState): T;
}

/** @public A callable function backed by layer state, accessible via `ctx.context['layerId'].fn()` or as an LLM tool. */
export interface LayerFunctionDecl<TInput = unknown, TOutput = unknown, TState = unknown> {
  kind: 'function';
  /** Human-readable description (used as tool description when exposed to LLM). */
  description: string;
  /** Zod schema for input arguments. */
  input: ZodType<TInput>;
  /** Zod schema for return value. */
  output: ZodType<TOutput>;
  /** Execute the function with the layer's current state. Return optional state update. */
  execute(
    args: TInput,
    state: TState,
    ctx: ExecutionContext,
  ): Promise<{
    result: TOutput;
    state?: TState;
  }>;
}

/** @public Map of named data and function declarations exposed by a context layer. */
export type LayerProvides = Record<string, LayerDataDecl | LayerFunctionDecl>;

/**
 * Mapped type that produces a flat handle from a layer's `provides` declaration.
 * Data entries become direct property reads; function entries become callable async methods.
 * @public
 */
export type LayerHandle<T extends ContextLayer> = T extends {
  provides: infer P;
}
  ? {
      [K in keyof P]: P[K] extends LayerDataDecl<infer D, unknown>
        ? D
        : P[K] extends LayerFunctionDecl<infer I, infer O, unknown>
          ? (args: I) => Promise<O>
          : never;
    }
  : Record<string, never>;

/** @public Object keyed by layer ID, where each value is a resolved handle for that layer's provides. */
export type ContextData = Readonly<Record<string, Record<string, unknown>>>;

/**
 * Maps a tuple of context layers to a typed object keyed by layer ID.
 * Each layer's `provides` is flattened: data → value type, function → async callable.
 * @public
 */
export type InferContextShape<T extends readonly ContextLayer[]> = {
  [L in T[number] as L extends {
    readonly id: infer Id extends string;
  }
    ? Id
    : never]: L extends {
    provides: infer P;
  }
    ? {
        [K in keyof P]: P[K] extends LayerDataDecl<infer D, unknown>
          ? D
          : P[K] extends LayerFunctionDecl<infer I, infer O, unknown>
            ? (args: I) => Promise<O>
            : never;
      }
    : Record<string, never>;
};

/**
 * Typed wrapper around a tuple of context layers. Preserves individual layer types
 * for compile-time inference via `InferContext<typeof config>`.
 * @public
 */
export interface ContextConfig<TLayers extends readonly ContextLayer[] = readonly ContextLayer[]> {
  readonly layers: TLayers;
  /** Phantom field carrying the inferred context shape. Never accessed at runtime. */
  readonly _shape: InferContextShape<TLayers>;
}

/**
 * What every context-accepting entry point takes: either a bare list of layers
 * or anything carrying a `layers` list — notably the `ContextConfig` the
 * `context()` builder returns.
 *
 * Declared structurally rather than as `ContextConfig | ContextLayer[]` because
 * `ContextConfig` is **invariant** in `TLayers`: the phantom `_shape` field puts
 * `TLayers` in an invariant position, so the concrete
 * `ContextConfig<readonly [SomeLayer]>` that `context()` infers is not
 * assignable to the defaulted `ContextConfig<readonly ContextLayer[]>`.
 * Spelling the union as `ContextConfig | ContextLayer[]` therefore rejects the
 * builder's own output at its primary destination. Matching on the `layers`
 * field instead accepts every config the builder produces while still refusing
 * unrelated objects.
 *
 * @public
 */
export type ContextInput =
  | ReadonlyArray<ContextLayer>
  | {
      readonly layers: ReadonlyArray<ContextLayer>;
    };

/**
 * Extract the typed context shape from a ContextConfig.
 * Constrains structurally on the phantom `_shape` field rather than on
 * `ContextConfig` itself: `ContextConfig` is invariant in `TLayers` (the `_shape`
 * field carries it in an invariant position), so a concrete
 * `ContextConfig<readonly [SomeLayer]>` does not satisfy the defaulted
 * `ContextConfig<readonly ContextLayer[]>`. Since `InferContext` only reads
 * `_shape`, this constraint accepts any config the `context()` builder produces.
 * @public Usage: `type Mem = InferContext<typeof config>`
 */
export type InferContext<
  T extends {
    readonly _shape: unknown;
  },
> = T['_shape'];

//#endregion

/** @public Well-known ordering slots for positioning context layers in the recall/store pipeline. */
export const Slot = {
  REMINDER: 80,
  STEERING: 90,
  WORKING_MEMORY: 100,
  ENTITY: 150,
  OBSERVATIONS: 200,
  PROCEDURAL: 250,
  EPISODIC: 300,
  RAG: 350,
  SEMANTIC_RECALL: 400,
} as const satisfies Record<string, number>;

/** @public Low-level key-value persistence backend used by scoped storage and context layers. */
export interface StorageAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  /**
   * Batch read. Anything that lists a prefix and then reads each key is an N+1 —
   * one round trip per key on a network- or database-backed adapter, which is
   * exactly what a resume path cannot afford. Implement this and the round trips
   * collapse to one.
   *
   * Optional so existing adapters keep working: callers MUST NOT depend on it
   * directly — go through `storageGetMany`, which falls back to a parallel
   * `get` sweep when a backend has not implemented it.
   *
   * Keys with no stored value are ABSENT from the returned map. The map is never
   * sparse-with-nulls, so `map.size < keys.length` is the normal way to see that
   * something was missing.
   */
  getMany?<T>(keys: string[]): Promise<Map<string, T>>;
}

/** @public Scope-namespaced storage interface provided to context layer init hooks. */
export interface ScopedStorage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
  /**
   * Batch read, always available — the scoped wrapper supplies the fallback so a
   * layer never has to check. Returned keys are scope-relative (the namespace
   * prefix is stripped, as with `list`), and missing keys are absent rather than
   * null.
   */
  getMany<T>(keys: string[]): Promise<Map<string, T>>;
}

/** @public Parameters passed to a context layer's `init` hook. */
export interface InitParams {
  storage: ScopedStorage;
  scopeKey: string;
  ctx: ExecutionContext;
}

/** @public Value returned by a context layer's `init` hook, carrying the initial state. */
export interface InitResult<TState> {
  state: TState;
}

/** @public Parameters passed to a context layer's `recall` hook before each LLM call. */
export interface RecallParams<TState> {
  log: ItemLog;
  query: string;
  ctx: ExecutionContext;
  state: TState;
  budget: number;
}

/** @public Value returned by a context layer's `recall` hook, containing items and token count. */
export interface RecallResult<TState = unknown> {
  items: Item[];
  tokenCount: number;
  state?: TState;
}

/** @public Parameters passed to a context layer's `store` hook after each LLM response. */
export interface StoreParams<TState> {
  newItems: Item[];
  log: ItemLog;
  response: LLMResponse;
  ctx: ExecutionContext;
  state: TState;
}

/** @public Value returned by a context layer's `store` hook, carrying the updated state. */
export interface StoreResult<TState> {
  state: TState;
}

/**
 * @public Which band of the assembled view a layer's recall output sits in.
 *
 * Prompt caches match on a prefix, so a layer that re-renders every turn
 * invalidates everything after it. The bands let stable content sit ahead of
 * conversation history where it can be cached, and volatile content sit after
 * it where re-rendering is nearly free.
 *
 * - `'anchor'` — before history. Pinned for the epoch: the bytes sent on the
 *   first assembly are re-sent unchanged until the next re-anchor, and any
 *   change is published as a supersede instead of rewriting the prefix.
 * - `'live'` — after history. Re-rendered freely. Use for content that changes
 *   every turn, or whose `recall()` mutates state and so cannot be replayed.
 * - `'auto'` (default) — starts anchored; the runtime may move it to `'live'`
 *   at an epoch boundary once it has watched how often the layer changes.
 *   An explicit `'anchor'` or `'live'` is never overridden.
 */
export type LayerPlacement = 'anchor' | 'live' | 'auto';

/** @public Parameters passed to a context layer's `renderDelta` hook when its pinned output goes stale. */
export interface RenderDeltaParams<TState = unknown> {
  /** The items still pinned in the anchor band — what the model can currently see. */
  prev: ReadonlyArray<Item>;
  /** The freshly recalled items that would have replaced them. */
  next: ReadonlyArray<Item>;
  /**
   * The layer state captured when `prev` was pinned. Best-effort: it is held by
   * reference, so a layer that mutates its state in place sees the current
   * object here rather than a snapshot.
   */
  prevState: TState | undefined;
  /** The layer's current state. */
  state: TState | undefined;
  ctx: ExecutionContext;
  /** Soft token budget for the returned text. */
  budget: number;
}

/** @public Parameters passed to a context layer's `onSpawn` hook when a child execution starts. */
export interface SpawnParams<TState> {
  parentState: TState;
  childCtx: ExecutionContext;
}

/** @public Value returned by a context layer's `onSpawn` hook with the child's initial state. */
export interface SpawnResult<TState> {
  childState: TState | null;
  items?: Item[];
}

/** @public Parameters passed to a context layer's `onReturn` hook when a child execution completes. */
export interface ReturnParams<TState> {
  childState: TState;
  childLog: ItemLog;
  parentState: TState;
  result: unknown;
  /**
   * The child's execution context — the same one passed to `onSpawn`. Layers
   * that merge artifacts from several concurrent children (fan-out) use
   * `childCtx.executionId` to namespace the child's contribution instead of
   * letting the last child to return silently overwrite its siblings.
   */
  childCtx: ExecutionContext;
}

/** @public Value returned by a context layer's `onReturn` hook with the merged parent state. */
export interface ReturnResult<TState> {
  parentState: TState;
  result?: unknown;
}

/** @public Parameters passed to a context layer's `onComplete` hook at execution end. */
export interface CompleteParams<TState> {
  log: ItemLog;
  ctx: ExecutionContext;
  state: TState;
  outcome: ExecutionOutcome;
}

/** @public Parameters passed to a context layer's `dispose` hook during teardown. */
export interface DisposeParams<TState> {
  state: TState;
}

/** @public Parameters passed to a context layer's `projectHistory` hook to project the history portion of the LLM context window. */
export interface ProjectHistoryParams<TState> {
  /** Full historical items from the item log, uncapped. */
  items: ReadonlyArray<Item>;
  /** Current execution context. */
  ctx: ExecutionContext;
  /** Layer's current state snapshot. */
  state: TState;
}

/** @public Value returned by a context layer's `projectHistory` hook, carrying the projected items. */
export interface ProjectHistoryResult {
  /** Items to send to the LLM as history. Typically a subset of the input. */
  items: ReadonlyArray<Item>;
}

//#region onItemAppend Hook

/** @public Controls which layers re-run recall() when a re-render is triggered. */
export type RerenderScope =
  | 'self' // Only the triggering layer
  | 'slot-after' // Triggering layer and all higher-slot layers (DEFAULT)
  | 'all'; // All layers

/** @public Parameters passed to a context layer's `onItemAppend` hook when input items are about to be appended. */
export interface OnItemAppendParams<TState> {
  /** Items to be appended (may have been transformed by prior layers in the pipeline). */
  items: Item[];
  /** Full item log (read-only). */
  log: ItemLog;
  /** Current execution context. */
  ctx: ExecutionContext;
  /** Layer's current state snapshot. */
  state: TState;
}

/** @public Value returned by a context layer's `onItemAppend` hook. */
export interface OnItemAppendResult<TState> {
  /**
   * Items to actually append to the log.
   * - Return original items unchanged to pass through
   * - Return modified items to transform
   * - Return empty array to filter/drop items
   * - Return additional items to inject extras
   */
  items: Item[];
  /** Updated layer state. */
  state?: TState;
  /** Request context re-render. */
  rerender?: boolean;
  /** When to apply re-render (default: layer's configured `rerenderTiming`). */
  timing?: 'immediate' | 'batched';
  /** Which layers to re-recall (default: 'slot-after'). */
  scope?: RerenderScope;
}

//#endregion

/** @public Lifecycle hook implementations for a context layer. Method syntax enables bivariant assignability for typed layers. */
export interface ContextLayerHooks<TState = unknown> {
  init?(params: InitParams): Promise<InitResult<TState>>;
  recall?(params: RecallParams<TState>): Promise<RecallResult<TState> | string | null>;
  store?(params: StoreParams<TState>): Promise<StoreResult<TState> | undefined>;
  onSpawn?(params: SpawnParams<TState>): Promise<SpawnResult<TState> | null>;
  onReturn?(params: ReturnParams<TState>): Promise<ReturnResult<TState> | undefined>;
  onComplete?(params: CompleteParams<TState>): Promise<
    | undefined
    | {
        state: TState;
      }
  >;
  dispose?(params: DisposeParams<TState>): Promise<void>;
  beforeToolCall?(params: BeforeToolCallParams<TState>): Promise<BeforeToolCallResult<TState>>;
  afterModelCall?(params: AfterModelCallParams<TState>): Promise<AfterModelCallResult<TState>>;
  /**
   * Called when input items (user messages, tool outputs) are about to be appended.
   * Returns items to append — enables filtering, transformation, and injection.
   *
   * Pipeline: items flow through layers in slot order. Each layer receives
   * the output of the previous layer (or original items for first layer).
   *
   * NOT called for LLM response items — use `store()` for those.
   */
  onItemAppend?(params: OnItemAppendParams<TState>): Promise<OnItemAppendResult<TState>>;
  /**
   * Called once per LLM step to project (cap, transform) the history portion
   * of the context window before assembleView. Layers compose in slot order:
   * each receives the output of the previous layer. Storage (`itemLog`) is
   * NOT mutated — this is a read-side projection only.
   *
   * Use for: capping history, summarising old turns, redacting items.
   */
  projectHistory?(params: ProjectHistoryParams<TState>): Promise<ProjectHistoryResult>;
  /**
   * Called for an anchored layer whose pinned output has gone stale, to describe
   * the change compactly instead of re-sending the whole block.
   *
   * Return `null` to fall back to the default, which republishes the full new
   * content. Worth implementing only when the layer's output is large and its
   * changes are small — a file set where one file changed, a ledger that gained
   * a row. Never called for layers in the `'live'` band, which re-render anyway.
   */
  renderDelta?(params: RenderDeltaParams<TState>): Promise<string | null>;
}

/**
 * A composable context layer that participates in the recall/store lifecycle.
 * @public
 */
export interface ContextLayer<TState = unknown> {
  /** Unique identifier for this layer instance. */
  id: string;
  /** Human-readable name for debugging and trace output. */
  name?: string;
  /** Ordering slot (lower = recalled first). Use `Slot` constants for well-known positions. */
  slot: number;
  /** Scope controlling state isolation: `'thread'`, `'resource'`, `'global'`, or `'execution'`. */
  scope: ContextScope;
  /** Token budget: a fixed number, a `{ min, max }` range, or `'auto'` for dynamic allocation. */
  budget?: BudgetConfig;
  /** Lifecycle hooks invoked by the runtime at each phase (init, recall, store, etc.). */
  hooks: ContextLayerHooks<TState>;
  /** Per-hook timeout overrides in ms. */
  timeouts?: Partial<LayerTimeouts>;
  /**
   * What to do when this layer's `init` hook throws.
   * - `'throw'` (default): surface the error and abort the execution — context is
   *   load-bearing, and silent disabling hides failures (and, for the steering
   *   layer, would fail *open*).
   * - `'disable'`: log a diagnostic and run the execution without this layer
   *   (its `recall`/`store`/etc. are skipped). Opt in only for non-critical layers.
   */
  onInitError?: 'throw' | 'disable';
  /**
   * Recall mode controlling whether this layer's `recall()` blocks the model call.
   * - `'atomic'` (default): recall runs synchronously in the hot path; the
   *   harness waits for it before assembling the view.
   * - `'eventual'`: recall is served from cache and never blocks; the cache
   *   refreshes after `store()` produces new state, so the next turn sees it.
   *
   * A harness configured with `forceAtomicRecall` treats every layer as atomic,
   * ignoring this field.
   */
  recallMode?: 'atomic' | 'eventual';
  /** Typed functions and data exposed to code steps via `ctx.context['layerId']` and automatically as LLM tools. */
  provides?: LayerProvides;
  /** Optional item schemas contributed by this layer, primarily for developer-role context items. */
  itemSchemas?: Pick<ItemSchemaExtensions, 'developerMessages' | 'items'>;
  /** Default re-render timing when `onItemAppend` requests a re-render. */
  rerenderTiming?: 'immediate' | 'batched';
  /**
   * Which band of the assembled view this layer's recall output sits in, and so
   * whether it is pinned for the prompt cache. Defaults to `'auto'`.
   */
  placement?: LayerPlacement;
}

/** @public Configuration for how the runtime projects conversation items into the model's context window. */
export interface ProjectionPolicy {
  tokenBudget: number;
  responseReserve: number;
  overflow: 'truncate' | 'summarize' | 'sliding_window';
  overflowModel?: string;
  windowSize?: number;
}
