import type { ZodType } from 'zod';
import type { LLMResponse } from './common';
import type { ItemLog } from './context-parts/item-log';
import type { Item, ItemSchemaExtensions } from './items';
import type { ExecutionContext, ExecutionOutcome, MemoryScope } from './memory-context';
import type {
  AfterModelCallParams,
  AfterModelCallResult,
  BeforeToolCallParams,
  BeforeToolCallResult,
} from './steering';

/** @public Isolation scope controlling how a memory layer's state is keyed and shared. */
export type BudgetConfig =
  | number
  | {
      min: number;
      max: number;
    }
  | 'auto';

/** @public Per-hook timeout overrides in milliseconds for a memory layer. */
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

/** @public A read-only data projection from layer state, accessible via `ctx.memory['layerId'].prop`. */
export interface LayerDataDecl<T = unknown, TState = unknown> {
  kind: 'data';
  /** Project a value from the layer's current state. Method syntax enables bivariant assignability. */
  read(state: TState): T;
}

/** @public A callable function backed by layer state, accessible via `ctx.memory['layerId'].fn()` or as an LLM tool. */
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

/** @public Map of named data and function declarations exposed by a memory layer. */
export type LayerProvides = Record<string, LayerDataDecl | LayerFunctionDecl>;

/**
 * Mapped type that produces a flat handle from a layer's `provides` declaration.
 * Data entries become direct property reads; function entries become callable async methods.
 * @public
 */
export type LayerHandle<T extends MemoryLayer> = T extends {
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
export type ContextMemory = Readonly<Record<string, Record<string, unknown>>>;

/**
 * Maps a tuple of memory layers to a typed object keyed by layer ID.
 * Each layer's `provides` is flattened: data → value type, function → async callable.
 * @public
 */
export type InferMemoryShape<T extends readonly MemoryLayer[]> = {
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
 * Typed wrapper around a tuple of memory layers. Preserves individual layer types
 * for compile-time inference via `InferMemory<typeof config>`.
 * @public
 */
export interface MemoryConfig<TLayers extends readonly MemoryLayer[] = readonly MemoryLayer[]> {
  readonly layers: TLayers;
  /** Phantom field carrying the inferred memory shape. Never accessed at runtime. */
  readonly _shape: InferMemoryShape<TLayers>;
}

/**
 * Extract the typed memory shape from a MemoryConfig.
 * Constrains structurally on the phantom `_shape` field rather than on
 * `MemoryConfig` itself: `MemoryConfig` is invariant in `TLayers` (the `_shape`
 * field carries it in an invariant position), so a concrete
 * `MemoryConfig<readonly [SomeLayer]>` does not satisfy the defaulted
 * `MemoryConfig<readonly MemoryLayer[]>`. Since `InferMemory` only reads
 * `_shape`, this constraint accepts any config the `memory()` builder produces.
 * @public Usage: `type Mem = InferMemory<typeof config>`
 */
export type InferMemory<
  T extends {
    readonly _shape: unknown;
  },
> = T['_shape'];

//#endregion

/** @public Well-known ordering slots for positioning memory layers in the recall/store pipeline. */
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

/** @public Low-level key-value persistence backend used by scoped storage and memory layers. */
export interface StorageAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

/** @public Scope-namespaced storage interface provided to memory layer init hooks. */
export interface ScopedStorage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

/** @public Parameters passed to a memory layer's `init` hook. */
export interface InitParams {
  storage: ScopedStorage;
  scopeKey: string;
  ctx: ExecutionContext;
}

/** @public Value returned by a memory layer's `init` hook, carrying the initial state. */
export interface InitResult<TState> {
  state: TState;
}

/** @public Parameters passed to a memory layer's `recall` hook before each LLM call. */
export interface RecallParams<TState> {
  log: ItemLog;
  query: string;
  ctx: ExecutionContext;
  state: TState;
  budget: number;
}

/** @public Value returned by a memory layer's `recall` hook, containing items and token count. */
export interface RecallResult<TState = unknown> {
  items: Item[];
  tokenCount: number;
  state?: TState;
}

/** @public Parameters passed to a memory layer's `store` hook after each LLM response. */
export interface StoreParams<TState> {
  newItems: Item[];
  log: ItemLog;
  response: LLMResponse;
  ctx: ExecutionContext;
  state: TState;
}

/** @public Value returned by a memory layer's `store` hook, carrying the updated state. */
export interface StoreResult<TState> {
  state: TState;
}

/** @public Parameters passed to a memory layer's `onSpawn` hook when a child execution starts. */
export interface SpawnParams<TState> {
  parentState: TState;
  childCtx: ExecutionContext;
}

/** @public Value returned by a memory layer's `onSpawn` hook with the child's initial state. */
export interface SpawnResult<TState> {
  childState: TState | null;
  items?: Item[];
}

/** @public Parameters passed to a memory layer's `onReturn` hook when a child execution completes. */
export interface ReturnParams<TState> {
  childState: TState;
  childLog: ItemLog;
  parentState: TState;
  result: unknown;
}

/** @public Value returned by a memory layer's `onReturn` hook with the merged parent state. */
export interface ReturnResult<TState> {
  parentState: TState;
  result?: unknown;
}

/** @public Parameters passed to a memory layer's `onComplete` hook at execution end. */
export interface CompleteParams<TState> {
  log: ItemLog;
  ctx: ExecutionContext;
  state: TState;
  outcome: ExecutionOutcome;
}

/** @public Parameters passed to a memory layer's `dispose` hook during teardown. */
export interface DisposeParams<TState> {
  state: TState;
}

/** @public Parameters passed to a memory layer's `projectHistory` hook to project the history portion of the LLM context window. */
export interface ProjectHistoryParams<TState> {
  /** Full historical items from the item log, uncapped. */
  items: ReadonlyArray<Item>;
  /** Current execution context. */
  ctx: ExecutionContext;
  /** Layer's current state snapshot. */
  state: TState;
}

/** @public Value returned by a memory layer's `projectHistory` hook, carrying the projected items. */
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

/** @public Parameters passed to a memory layer's `onItemAppend` hook when input items are about to be appended. */
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

/** @public Value returned by a memory layer's `onItemAppend` hook. */
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

/** @public Lifecycle hook implementations for a memory layer. Method syntax enables bivariant assignability for typed layers. */
export interface MemoryHooks<TState = unknown> {
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
}

/**
 * A composable memory layer that participates in the recall/store lifecycle.
 * @public
 */
export interface MemoryLayer<TState = unknown> {
  /** Unique identifier for this layer instance. */
  id: string;
  /** Human-readable name for debugging and trace output. */
  name?: string;
  /** Ordering slot (lower = recalled first). Use `Slot` constants for well-known positions. */
  slot: number;
  /** Scope controlling state isolation: `'thread'`, `'resource'`, `'global'`, or `'execution'`. */
  scope: MemoryScope;
  /** Token budget: a fixed number, a `{ min, max }` range, or `'auto'` for dynamic allocation. */
  budget?: BudgetConfig;
  /** Lifecycle hooks invoked by the runtime at each phase (init, recall, store, etc.). */
  hooks: MemoryHooks<TState>;
  /** Per-hook timeout overrides in ms. */
  timeouts?: Partial<LayerTimeouts>;
  /**
   * What to do when this layer's `init` hook throws.
   * - `'throw'` (default): surface the error and abort the execution — memory is
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
  /** Typed functions and data exposed to code steps via `ctx.memory['layerId']` and automatically as LLM tools. */
  provides?: LayerProvides;
  /** Optional item schemas contributed by this layer, primarily for developer-role memory items. */
  itemSchemas?: Pick<ItemSchemaExtensions, 'developerMessages' | 'items'>;
  /** Default re-render timing when `onItemAppend` requests a re-render. */
  rerenderTiming?: 'immediate' | 'batched';
}

/** @public Configuration for how the runtime projects conversation items into the model's context window. */
export interface ProjectionPolicy {
  tokenBudget: number;
  responseReserve: number;
  overflow: 'truncate' | 'summarize' | 'sliding_window';
  overflowModel?: string;
  windowSize?: number;
}
