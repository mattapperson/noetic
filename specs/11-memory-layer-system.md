# Memory Layer System

> **Module:** `@noetic-tools/memory` (source at `packages/memory/src/**`); the `MemoryLayer` contract is owned by `@noetic-tools/types` (`packages/types/src/types/memory.ts`, also at the `@noetic-tools/types/contract` subpath). Both are re-exported by `@noetic-tools/core`.
> **Depends On:** `07-context-and-event-log` (ItemLog, Item — type import only), `10-observability` (MemoryTraceSpan, trace conventions), `04-spawn` (SpawnOpts — referenced in SpawnParams)
> **Exports:** `MemoryLayer`, `MemoryHooks`, `MemoryScope`, `BudgetConfig`, `Slot`, `InitParams`, `InitResult`, `RecallParams`, `RecallResult`, `StoreParams`, `StoreResult`, `SpawnParams`, `SpawnResult`, `ReturnParams`, `ReturnResult`, `CompleteParams`, `DisposeParams`, `BeforeToolCallParams`, `BeforeToolCallResult`, `AfterModelCallParams`, `AfterModelCallResult`, `OnItemAppendParams`, `OnItemAppendResult`, `RerenderScope`, `ParentUpdateParams`, `ParentUpdateResult`, `ExecutionOutcome`, `ExecutionContext`, `ScopedStorage`, `StorageAdapter`, `ProjectionPolicy`, `LayerTimeouts`, `LayerProvides`, `LayerDataDecl`, `LayerFunctionDecl`, `MemoryConfig`, `InferMemory`, `InferMemoryShape`, `layerData`, `layerFn`, `memory`

## Module Boundary

The memory layer system lives in `@noetic-tools/memory` (`packages/memory/src/**`), built on the dependency-free `@noetic-tools/types` foundation. It has a strict import boundary so that consumers who only use the memory contract (custom layer authors) can tree-shake the interpreter and runtime code out of their bundle.

| Owned by `@noetic-tools/types` | Lives in `@noetic-tools/memory` |
|---|---|
| `MemoryLayer` interface and all hook types | Layer lifecycle orchestration (`initLayers`, `recallLayers`, etc.) |
| `MemoryScope`, `ScopedStorage`, `StorageAdapter` | Projector (View assembly algorithm) in `projector.ts` |
| `BudgetConfig`, `Slot` | budget algorithm; `allocateBudgets` in `budget.ts` |
| `ExecutionContext` (memory-facing read-only view) | built-in layer factories under `memory/layers/` |
| `ProjectionPolicy` | Projector implementation in `projector.ts` |

`Context` (the full execution object) lives in `@noetic-tools/core`'s `runtime/`; the `contextToExecCtx` mapping (Context → ExecutionContext) bridges core to the memory contract.

**Boundary rule:** `@noetic-tools/memory` depends only on `@noetic-tools/types` and MUST NOT import from `@noetic-tools/core`. Pure helpers needed by both sides (`frameworkCast`, `createMessage`, `estimateTokens`, `isAssistantMessage`, `isUserMessage`, `isOutputText`) live in `@noetic-tools/types`. This keeps the memory package tree-shakable from the interpreter/runtime graph; importing a memory layer factory does not pull in `ContextImpl`.

**Custom layer authors** import from `@noetic-tools/memory` (or, equivalently, from `@noetic-tools/core`, which re-exports it). Their bundle contains only the memory contract, the layer factories they use, and the shared `@noetic-tools/types` helpers — not the interpreter or runtime.

---

## Overview

A `MemoryLayer` is a plugin that participates in the agent execution lifecycle to recall context before LLM calls and persist information after them. Memory layers are the sole extension point for injecting non-conversation content into the View (the assembled item array sent to the model).

Normative language uses **MUST**, **SHOULD**, and **MAY** per RFC 2119.

---

## Mental Model: Reactive-Inspired Context Assembly

The layer system is loosely inspired by reactive programming — not in the formal RxJS/MobX sense, but in spirit: the View (what the LLM sees) is always re-assembled from current layer state before each request, producing a fresh, consistent snapshot.

**Context is the result of all layers converging — it is not itself a layer.** You define layers; the agent harness converges them. Their convergence is the context. Context is never exposed as an input, never passed into a layer hook, and never something you construct directly. It is the output.

**Memory is a type of layer, not a separate system.** "Memory" (facts recalled from storage) and "context injection" (information injected for this turn) are both expressed as layers with the same hook interface. The mechanism is identical; the purpose differs. The `slot` number determines where in the converged result each layer's contribution appears.

**Each layer is one of two things** (or both):
- A **window section** — a portion of the context budget reserved for specific content (skills, reminders, entity facts)
- A **map/reduce** over prior information — transforming raw history or storage into a condensed, relevant form (summarization layers, RAG layers, episodic memory)

**Context is scoped, not global.** LLM steps can share a converged context, operate in their own, or run in a child context forked from a parent via `spawn`. There is no ambient global context. Forked children are not fully isolated — they can receive updates from the parent context during their execution, and layers control whether and how those updates are incorporated.

**Internally reactive; externally hooks.** Users implementing custom layers do not write reactive pipelines. They implement lifecycle hooks (`recall`, `store`, `afterModelCall`, etc.) and the agent harness handles orchestration, ordering, budgeting, and re-evaluation. The reactive behavior is an implementation detail, not a user-facing API.

**Loose pattern, not strict formalism.** The reactive inspiration is a mental model, not a contract. Formal reactive concepts (observables, subscriptions, schedulers) do not appear in this API. The goal is the insight — always-fresh context from converging layers — without the boilerplate or jargon.

### Stale Context (Non-Default)

Context can be explicitly marked stale, causing the next request to block until all layers finish revalidating. This is opt-in for layers that need guaranteed consistency before the LLM call proceeds. The default `recall()` model is sufficient for most layers.

---

## The `MemoryLayer` Interface

```typescript
interface MemoryLayer<TState = unknown> {
  id: string;
  name?: string;
  slot: number;
  scope: MemoryScope;
  budget?: BudgetConfig;
  hooks: MemoryHooks<TState>;
  timeouts?: Partial<LayerTimeouts>;
  /**
   * What to do when this layer's `init` hook throws.
   * - `'throw'` (default): surface the error and abort the execution.
   * - `'disable'`: log a diagnostic and run without this layer.
   */
  onInitError?: 'throw' | 'disable';
  /**
   * Whether `recall()` blocks the model call.
   * - `'atomic'` (default): recall runs in the hot path before view assembly.
   * - `'eventual'`: recall is served from a per-harness cache and never blocks;
   *   the cache refreshes after `store()` produces new state.
   */
  recallMode?: 'atomic' | 'eventual';
  provides?: LayerProvides;
  rerenderTiming?: 'immediate' | 'batched';
}

type MemoryScope =
  | 'thread'
  | 'resource'
  | 'global'
  | 'execution';

type BudgetConfig =
  | number
  | { min: number; max: number }
  | 'auto';
```

### Slot Constants

```typescript
export const Slot = {
  REMINDER:        80,
  STEERING:        90,
  WORKING_MEMORY:  100,
  ENTITY:          150,
  OBSERVATIONS:    200,
  PROCEDURAL:      250,
  EPISODIC:        300,
  RAG:             350,
  SEMANTIC_RECALL: 400,
} as const;
```

`REMINDER` (80) is reserved for ephemeral `<system-reminder>`-wrapped developer messages (e.g., mid-conversation nags, plan-mode reminders, error-recovery hints). Layers using this slot typically maintain their own turn counters and throttle emissions per trigger. Sitting below `STEERING` ensures reminders are visible to the model before any steering guidance runs.

The agent harness sorts layers by slot ascending. Ties broken by array index (stable sort). Custom layers SHOULD use multiples of 10 within these ranges. The agent harness does NOT enforce slot uniqueness.

---

## Lifecycle Hooks

```typescript
interface MemoryHooks<TState = unknown> {
  init?:            (params: InitParams)                         => Promise<InitResult<TState>>;
  recall?:          (params: RecallParams<TState>)               => Promise<RecallResult<TState> | string | null>;
  store?:           (params: StoreParams<TState>)                => Promise<StoreResult<TState> | void>;
  onItemAppend?:    (params: OnItemAppendParams<TState>)         => Promise<OnItemAppendResult<TState>>;
  projectHistory?:  (params: ProjectHistoryParams<TState>)       => Promise<ProjectHistoryResult>;
  beforeToolCall?:  (params: BeforeToolCallParams<TState>)       => Promise<BeforeToolCallResult | void>;
  afterModelCall?:  (params: AfterModelCallParams<TState>)       => Promise<AfterModelCallResult<TState> | void>;
  onSpawn?:         (params: SpawnParams<TState>)                => Promise<SpawnResult<TState> | null>;
  onReturn?:        (params: ReturnParams<TState>)               => Promise<ReturnResult<TState> | void>;
  onParentUpdate?:  (params: ParentUpdateParams<TState>)         => Promise<ParentUpdateResult<TState> | void>;
  onComplete?:      (params: CompleteParams<TState>)             => Promise<void>;
  dispose?:         (params: DisposeParams<TState>)              => Promise<void>;
}
```

`projectHistory` is a read-side hook: it receives the full historical items from `itemLog` and returns a (possibly narrower) projection used as `historyItems` in the next `assembleView` call. Layers compose in slot order, each receiving the output of the previous layer. Storage (`itemLog`, `accumulatedItems`) is never mutated by this hook — see `historyWindow` in spec 12 for the canonical use case.

### Lifecycle Sequence

The agent harness MUST execute hooks in this order:

```
EXECUTION START
│
├─ init()              Sequential, array order. MUST complete before any recall().
│                      Throws → execution ABORTS (fail-loud default). A layer that
│                      sets `onInitError: 'disable'` is instead skipped for the
│                      rest of the execution (its other hooks do not run).
│
▼
LOOP ITERATION ─────────────────────────────────────────────────
│
├─ (on user input / tool output)
│   └─ onItemAppend()  Sequential, SLOT ORDER. Pipeline: each layer receives
│                      the output of the previous layer. Can filter, transform,
│                      or inject items. MAY request re-render — those requests are
│                      collected and run after recall (see Re-render below); the
│                      re-recalled output is merged over the base recall by layer id.
│                      NOT called for LLM response items (use store()).
│
├─ recall()            Sequential, SLOT ORDER (ascending). Ties by array index.
│                      Atomic layers (`recallMode !== 'eventual'`, the default)
│                      run here in the hot path. Eventual layers are served from
│                      the per-harness recall cache and re-run only after their
│                      own `store()` has produced new state. A disabled layer
│                      (init failed with `onInitError: 'disable'`) is skipped.
│
├─ projectHistory()    Sequential, SLOT ORDER. Each layer receives the previous
│                      layer's output. Caps/transforms history items only.
│                      Does NOT mutate itemLog. No-op when no layer registers it.
│
├─ [VIEW ASSEMBLY]     Projector assembles system prompt item + layer output items + (projected) history items.
│
├─ [LLM CALL]
│
├─ afterModelCall()    Sequential, SLOT ORDER. Receives LLM response. MAY abort
│                      the turn (e.g., policy violation) or update layer state.
│
├─ (for each tool call the model requested)
│   └─ beforeToolCall()  Sequential, SLOT ORDER. MAY block execution of the tool
│                        (e.g., rule violation) or rewrite tool arguments.
│
├─ store()             CONCURRENT via Promise.allSettled(). Each layer gets
│                      its own state snapshot.
│
├─ (if spawning)
│   ├─ onSpawn()       Sequential, array order.
│   │   ...child...
│   └─ onReturn()      Sequential, array order.
│
└─ (loop continues or...)
    │
    ▼
EXECUTION END
│
├─ onComplete()        Sequential, array order. Always runs (even on failure).
│
└─ dispose()           Sequential, REVERSE array order. Always runs.
```

### State Guarantee

If a layer provides `init`, the returned `state` is guaranteed non-null for all subsequent hooks. If no `init`, `TState` SHOULD be `void`.

### Lifecycle Consistency

The runtime applies these invariants uniformly across the lifecycle:

- **Disabled-layer skip.** A layer whose `init` threw with `onInitError: 'disable'` is marked disabled via an **explicit flag** on the layer state store (`disable`/`isDisabled`) and is skipped by *every* later hook — `recall`, `store`, `onSpawn`, `onComplete`, `dispose`, `onItemAppend`, `projectHistory`, `beforeToolCall`, `afterModelCall`. The flag — not the absence of state — is the disabled signal, so a layer that legitimately cleared its state keeps running (its hooks receive `undefined` state). A custom state store without explicit tracking falls back to the legacy sentinel (init-bearing layer with no state), which cannot make that distinction.
- **State clearing.** `store` (and `onComplete`) detect the returned object with `'state' in result`, not `result.state !== undefined`, so a layer MAY clear its state by returning `{ state: undefined }`. Clearing deletes the durable key, so the next execution's `init` sees no saved state and falls back to its default. Clearing does NOT disable the layer.
- **`onReturn` requirements.** Only the *child*'s state is required to merge. A parent that never initialized state can still be seeded from the child; `onReturn` is skipped only when the child produced no state.
- **`onSpawn` for init-less layers.** `onSpawn` runs for layers with no `init` hook (state legitimately `undefined`), consistent with `recall`. Only disabled layers (init present, no state) are skipped.

---

## Hook Parameter Types

```typescript
interface InitParams {
  storage: ScopedStorage;
  scopeKey: string;
  ctx: ExecutionContext;
}

interface InitResult<TState> {
  state: TState;
}

interface RecallParams<TState> {
  log: ItemLog;
  query: string;
  ctx: ExecutionContext;
  state: TState;
  budget: number;
}

interface RecallResult<TState = unknown> {
  items: Item[];
  tokenCount: number;
  state?: TState;
}
```

**String shorthand:** `recall` MAY return a plain `string` instead of a `RecallResult`. The agent harness wraps it in a `developer` message item and estimates the token count automatically. This avoids boilerplate for layers that only inject text.

```typescript
interface StoreParams<TState> {
  newItems: Item[];
  log: ItemLog;
  response: LLMResponse;
  ctx: ExecutionContext;
  state: TState;
}

interface StoreResult<TState> {
  state: TState;
}

type RerenderScope =
  | 'self'        // Only the triggering layer
  | 'slot-after'  // Triggering layer and all higher-slot layers (DEFAULT)
  | 'all';        // All layers

interface OnItemAppendParams<TState> {
  items: Item[];         // Items to be appended (may be transformed by prior layers)
  log: ItemLog;          // Full log (read-only)
  ctx: ExecutionContext;
  state: TState;
}

interface OnItemAppendResult<TState> {
  /** Items to append — can filter, transform, or inject items. */
  items: Item[];
  /** Updated layer state. */
  state?: TState;
  /** Request context re-render. */
  rerender?: boolean;
  /** When to apply re-render (default: layer's rerenderTiming). */
  timing?: 'immediate' | 'batched';
  /** Which layers to re-recall (default: 'slot-after'). */
  scope?: RerenderScope;
}

interface BeforeToolCallParams<TState> {
  toolName: string;
  toolArgs: unknown;
  ctx: ExecutionContext;
  state: TState;
}

interface BeforeToolCallResult {
  /** If set, tool execution is blocked and this message is returned as the tool error. */
  block?: string;
  /** If set, replaces the original tool arguments before execution. */
  overrideArgs?: unknown;
}

interface AfterModelCallParams<TState> {
  response: LLMResponse;
  ctx: ExecutionContext;
  state: TState;
}

interface AfterModelCallResult<TState> {
  state?: TState;
  /** If set, aborts the current turn and uses this string as the error reason. */
  abort?: string;
}

interface SpawnParams<TState> {
  parentState: TState;
  childCtx: ExecutionContext;
  spawnOpts: SpawnOptions;
}

interface SpawnResult<TState> {
  childState: TState | null;
  items?: Item[];
}

interface ReturnParams<TState> {
  childState: TState;
  childLog: ItemLog;
  parentState: TState;
  result: unknown;
}

interface ReturnResult<TState> {
  parentState: TState;
}

interface CompleteParams<TState> {
  log: ItemLog;
  ctx: ExecutionContext;
  state: TState;
  outcome: ExecutionOutcome;
}

interface DisposeParams<TState> {
  state: TState;
}

interface ParentUpdateParams<TState> {
  parentState: TState;        // the parent layer's current state after its latest store()
  childState: TState;         // the child layer's current state
  childCtx: ExecutionContext;
}

interface ParentUpdateResult<TState> {
  childState?: TState;        // updated child state, if the child wants to act on the update
  items?: Item[];             // optional items to inject into the child's ItemLog
}

type ExecutionOutcome = 'success' | 'failure' | 'aborted';
```

### Durable Persistence (Write-Through)

ALL layer-state writes to non-`'execution'` scopes are durably mirrored to the layer's `ScopedStorage` (key `'state'`) — `store()` is not special. The mirror is centralized in the layer state store's `set()`: state produced by `provides` functions, `beforeToolCall`/`afterModelCall`, `onComplete`, `onReturn`, the `onItemAppend` pipeline, and `store()` hooks all flow through the same write-through, so the next execution's `init` can always rehydrate the latest state.

- Durable targets are registered after `init` runs (so rehydrated state is not immediately rewritten) and again for child executions at the spawn boundary.
- Writes are asynchronous and **coalesced per (execution, layer) key** — at most one write is in flight per key and the latest value wins.
- Writing `undefined` (state clearing) **deletes** the durable key.
- Mirror failures are reported as diagnostics (`persist`) and MUST NOT throw or interrupt the agent.
- `'execution'`-scoped state is never mirrored: its scope key rotates each run, so there is nothing durable to rehydrate.
- The runtime flushes pending mirror writes at the end of `storeLayers`, `completeLayers`, and `returnLayers`, and in `disposeLayers` before cleanup.

### Concurrency Rules for `store()`

1. Each store hook receives a **snapshot** of its own layer state. Mutations don't affect other layers.
2. `Promise.allSettled`, NOT `Promise.all`. Individual failures don't prevent other layers.
3. Store hooks MUST NOT mutate shared execution state. `ExecutionContext` is read-only.

---

## Budget Allocation

There is a single allocator, `allocateBudgets` (in `memory/budget.ts`). It splits the recall budget derived from the resolved `ProjectionPolicy` across layers, leaving a reserve for conversation history. The naive per-layer ceiling is gone.

### Policy Resolution

The policy that drives both allocation and view assembly is resolved per LLM step:

```
step.projection  >  harness.projection  >  DEFAULT_PROJECTION
```

```typescript
const DEFAULT_PROJECTION: ProjectionPolicy = {
  tokenBudget: 128_000,
  responseReserve: 4_000,
  overflow: 'sliding_window',
};
```

`DEFAULT_PROJECTION` is a conservative fallback. Configure `harness.projection` or `step.projection` to match the target model's real context length.

### Algorithm (Normative)

```typescript
function allocateBudgets(opts: {
  layers: MemoryLayer[];
  totalBudget: number;       // policy.tokenBudget
  systemPromptTokens: number;
  responseReserve: number;   // policy.responseReserve
}): { allocations: { layerId: string; allocated: number }[]; historyBudget: number } {
  // Input validation: NaN in totalBudget/systemPromptTokens/responseReserve
  // throws NoeticConfigError (code INVALID_BUDGET_INPUT). Infinity is allowed
  // (= uncapped budget); fractional values are accepted.
  const available = opts.totalBudget - opts.responseReserve - opts.systemPromptTokens;
  if (available <= 0) {
    // Every layer gets 0; history gets 0.
  }

  // Phase 1: satisfy each layer's minimum first.
  let remaining = available;
  for (const layer of opts.layers) {
    const min = extractMin(layer.budget);   // {min,max}.min, else 0
    allocate(layer.id, min);
    remaining -= min;
  }

  // Phase 2: distribute a proportional pool above the minimums.
  //   60% of what remains funds the layers (by headroom = max - min,
  //   where 'auto'/undefined max is +Infinity), 40% is reserved for history.
  const layerPool = remaining * 0.6;
  const historyBudget = remaining * 0.4;
  // each layer's share is its headroom proportion of layerPool, clamped to headroom
}
```

- **Minimums are satisfied first**, in array order.
- The remaining budget is split: **60% into a proportional pool** distributed across layers by headroom (`max − min`; `'auto'`/`undefined` budgets have infinite headroom and split the pool among themselves after finite layers take their share), and **40% reserved for conversation history** (`historyBudget`).
- **The pool is conserved.** Finite shares are single-priced: each finite layer's share (in a mixed finite/infinite population, `min(headroom, half-pool proportional)`) is computed once, and the infinite-headroom layers split exactly `layerPool − Σ finiteShare`. No part of the pool is silently lost.
- A layer's final allocation never exceeds its `max`.
- **Input contract.** `totalBudget`, `systemPromptTokens`, and `responseReserve` MUST NOT be NaN — the allocator throws `NoeticConfigError` (code `INVALID_BUDGET_INPUT`). `Infinity` is a coherent "uncapped" budget and is accepted; fractional values are accepted.

### Budget Yielding

When `recall()` returns `tokenCount` less than allocated, the difference goes to conversation history. The Projector MUST NOT reallocate to other layers (prevents cascading re-recalls).

### Budget Verification

The agent harness independently counts tokens. If layer-reported count diverges by >10%, the agent harness count is authoritative and a warning is emitted.

## Recall Modes

Each layer's `recallMode` controls whether its `recall()` blocks the model call:

- **`'atomic'` (default)** — recall runs synchronously in the hot path. The harness waits for it before assembling the view, so the current turn always sees fresh output.
- **`'eventual'`** — recall is served from a per-harness cache and never blocks. A cold or invalidated entry is recalled and cached; a warm entry is returned as-is. The cache entry is marked stale when the layer's own `store()` produces new state, so the *next* turn re-runs recall against the fresh state. This keeps a slow layer's `recall()` off the critical path.

Both modes recall once per LLM step. The harness runs atomic layers (`recallLayersAtomic`) and eventual layers (`recallLayersEventual`) and merges the two result sets in slot order.

A harness configured with `forceAtomicRecall: true` treats **every** layer as atomic regardless of its `recallMode` — the eventual cache is bypassed entirely.

## Re-render

An `onItemAppend` hook MAY set `rerender: true` to request that affected layers re-run `recall()` after their input transformed the log. The harness collects these requests from the append pipeline, then calls `executeRerender`, which re-recalls the layers selected by each request's `scope` (`'self'`, `'slot-after'`, or `'all'`) and returns fresh layer output. That output is merged over the base recall results **by layer id** (same-id entries replaced, new entries appended, slot order preserved). Re-render depth is bounded (max 3) to prevent infinite cascades.

---

## Scope Enforcement

### Scope Key Resolution

```typescript
function resolveScopeKey(scope: MemoryScope, ctx: ExecutionContext): string {
  switch (scope) {
    case 'thread':    return ctx.threadId;
    case 'resource':  return ctx.resourceId ?? ctx.threadId;
    case 'global':    return '__global__';
    case 'execution': return ctx.executionId;
  }
}
```

### `ScopedStorage`

Layers receive a `ScopedStorage` wrapper that namespaces all keys: `layers/${layerId}/${scopeKey}/${userKey}`.

```typescript
interface ScopedStorage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}
```

A layer declaring `scope: 'thread'` CANNOT accidentally read another thread's data.

### Cross-Scope Access

To read a different scope, declare the broader scope. No escape hatches.

---

## Layer Provides

A memory layer MAY declare a `provides` map exposing typed data projections and callable functions to the rest of the agent. This gives code steps structured access to layer state without reaching into layer internals, and gives LLM steps automatic tool access to layer capabilities.

### Declaration Types

```typescript
type LayerProvides = Record<string, LayerDataDecl | LayerFunctionDecl>;
```

**`LayerDataDecl`** — a read-only data projection from layer state:

```typescript
interface LayerDataDecl<T = unknown, TState = unknown> {
  kind: 'data';
  read(state: TState): T;
}
```

The `read` function is called on demand against the layer's current state. It MUST be a pure projection with no side effects.

**`LayerFunctionDecl`** — a callable function backed by layer state:

```typescript
interface LayerFunctionDecl<TInput = unknown, TOutput = unknown, TState = unknown> {
  kind: 'function';
  description: string;
  input: ZodType<TInput>;
  output: ZodType<TOutput>;
  execute(
    args: TInput,
    state: TState,
    ctx: ExecutionContext,
  ): Promise<{ result: TOutput; state?: TState }>;
}
```

The `description` is used as the tool description when exposed to LLMs. The `input` and `output` Zod schemas provide runtime validation and JSON Schema generation. If `execute` returns a `state` value, the agent harness replaces the layer's current state with the returned value.

### `LayerHandle<T>`

A mapped type that produces a flat access interface from a layer's `provides` declaration:

```typescript
type LayerHandle<T extends MemoryLayer> = T extends { provides: infer P }
  ? {
      [K in keyof P]: P[K] extends LayerDataDecl<infer D, unknown>
        ? D
        : P[K] extends LayerFunctionDecl<infer I, infer O, unknown>
          ? (args: I) => Promise<O>
          : never;
    }
  : Record<string, never>;
```

Data entries become synchronous property reads (via getter). Function entries become async methods. A layer with no `provides` produces an empty handle.

### Accessing Provides from Code Steps

Code steps access a layer's provides via `ctx.memory['layerId']`, where the key is the layer's `id` string:

```typescript
const value = ctx.memory['layerId'].someData;              // synchronous read
const result = await ctx.memory['layerId'].someFunction({ query: 'test' });  // async call
```

Layers without `provides` produce an empty `{}` entry in `ctx.memory`.

### Automatic LLM Tool Injection

Every `LayerFunctionDecl` in a layer's `provides` map is automatically exposed as a tool to any LLM step running within the layer's context. Tool names are namespaced as `{layerId}/{functionName}` to avoid collisions across layers. The `description`, `input` schema, and `output` schema from the declaration are used directly as the tool definition. The agent harness handles argument validation, state lookup, and state updates transparently.

### Builder Helpers

Two convenience functions construct declaration objects for use in a `provides` map:

```typescript
function layerData<T, TState>(opts: {
  read: (state: TState) => T;
}): LayerDataDecl<T, TState>;

function layerFn<TInput, TOutput, TState>(opts: {
  description: string;
  input: ZodType<TInput>;
  output: ZodType<TOutput>;
  execute: (
    args: TInput,
    state: TState,
    ctx: ExecutionContext,
  ) => Promise<{ result: TOutput; state?: TState }>;
}): LayerFunctionDecl<TInput, TOutput, TState>;
```

### Type-Safe Memory Access

The `memory()` builder wraps a layer tuple in a `MemoryConfig` that preserves individual layer types for compile-time inference:

```typescript
function memory<const T extends readonly MemoryLayer[]>(layers: T): MemoryConfig<T>;

interface MemoryConfig<TLayers extends readonly MemoryLayer[] = readonly MemoryLayer[]> {
  readonly layers: TLayers;
  readonly _shape: InferMemoryShape<TLayers>;
}
```

`InferMemory<T>` extracts the typed memory shape from a config (analogous to `z.infer<>` for Zod):

```typescript
type InferMemory<T extends MemoryConfig> = T['_shape'];
```

`TMemory` is the first generic parameter on `Step` and `Context`, enabling end-to-end type safety:

```typescript
const mem = memory([workingMemory(), counterLayer()]);
type Mem = InferMemory<typeof mem>;

step.run<Mem>({
  id: 'work',
  execute: async (input, ctx) => {
    ctx.memory['working-memory'].snapshot;  // typed
    await ctx.memory.counter.increment({ amount: 1 });  // typed
  },
});
```

Layer factories MUST use `satisfies MemoryLayer<TState>` (not a return type annotation) and `as const` on the `id` field to preserve literal types for inference.

---

## Future Considerations

### Narrowed Scope (Not Yet Designed)

A potential optimization: allow a layer to declare interest in a specific subset of a parent scope rather than the whole thing. A specialist layer — one that cares only about user preferences or an active task list — could subscribe only to those keys and avoid receiving or processing unrelated parent context changes.

This would require extending `MemoryScope` with a selector variant (e.g. key patterns or glob matching), adding filtering logic to `onParentUpdate` dispatch, and defining access-control semantics for `ScopedStorage`. The tradeoffs (pattern-matching cost per `store()`, complexity of the access model) need evaluation before committing to a design. Not scheduled.

---

## `StorageAdapter`

The raw storage backend. The agent harness wraps it in `ScopedStorage`.

```typescript
interface StorageAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
```

### Serialization Constraint

All values MUST be JSON-serializable. No `Map`, `Set`, `Date` objects, or circular references. Use `Object.fromEntries()`, `Array.from()`, ISO timestamps, and `null` for intentional absence.

### State Migration

Layers own their migration. Recommended: versioned state with explicit migration in `init`.

---

## `ExecutionContext` (Memory-Specific)

The narrow, read-only context that memory layer hooks receive:

```typescript
interface ExecutionContext {
  readonly executionId: string;
  readonly threadId: string;
  readonly resourceId: string | undefined;
  readonly stepNumber: number;
  readonly tokenUsage: { input: number; output: number };
  readonly cost: number;
  readonly model: string;
  readonly fs: FsAdapter;
  tokenize(text: string): number;
  trace: {
    setAttribute(key: string, value: string | number | boolean): void;
    addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
  };
  readLayerState<T>(layerId: string): T | undefined;
}
```

`ExecutionContext` includes `readonly fs: FsAdapter` so memory layers can perform filesystem operations (e.g., reading config files, persisting state to disk) through the harness's configured adapter.

`readLayerState<T>(layerId)` returns a sibling layer's current state by its `layer.id`, or `undefined` if no such state exists yet. This enables cross-layer coordination (e.g., a reminder layer reading a planning layer's mode flag). Layers MUST treat the returned value as read-only — mutations are not persisted and observability is undefined.

**The generic `T` is an author-assertion — it is NOT runtime-validated.** Any layer may register under the queried id with an arbitrary state shape (including `unknown` where the reader expected a specific object), so callers MUST add a runtime shape guard (e.g. `Array.isArray`, a Zod parse, or a narrow `typeof` check) before dereferencing fields. The canonical pattern is a small type-predicate function (`function hasX(v: unknown): v is { x: ... }`) used immediately after the `readLayerState` call.

Note what is NOT on `ExecutionContext`: no `storage` (captured in `init`), no `itemLog` mutation, no `setRenderingHint()`.

---

## View Assembly (The Projector)

### `ProjectionPolicy`

```typescript
interface ProjectionPolicy {
  tokenBudget: number;
  responseReserve: number;
  overflow: 'truncate' | 'summarize' | 'sliding_window';
  overflowModel?: string;
  windowSize?: number;
}
```

### Assembly Algorithm

```
1. Count system prompt tokens
2. Allocate budgets to layers
3. Run recall() hooks (atomic in the hot path; eventual from cache)
4. Assemble: system prompt items (role: system) + layer output items (role: developer) + conversation history items
5. Conversation history gets remaining budget after layers, with overflow policy applied
6. Result is Item[] — directly passable to the LLM provider
```

### Hard Token Cap (`assembleView`)

Given a `ProjectionPolicy`, `assembleView` holds the assembled view to a hard budget of `policy.tokenBudget − policy.responseReserve`, in priority order:

1. **System items are always kept** — they anchor the conversation and are never dropped.
2. **Layer output is considered slot-ascending; non-fitting items are dropped individually.** Layer-output items are independent contributions with no contiguity requirement, so an item that exceeds the remaining budget is skipped while later (higher-slot) items that still fit are kept. Lower-slot (foundational) output gets first claim on the budget, and higher-slot output is dropped first when space is tight — but a single oversized item never evicts everything after it.
3. **History takes the remainder, keeping the most recent turns.** Older items are dropped first; an optional `windowSize` caps item count before the token pass (sliding-window overflow).
4. **Orphan tool calls are stripped** at the slice boundary — any dangling `function_call` / `function_call_output` left after trimming history is removed.

Without a `policy`, the inputs are concatenated as-is (optionally sliding the history window by `windowSize`).

### Conversation History is Not a Memory Layer

The ItemLog's rendering is handled by the Projector natively. Memory layers get budgets FROM a pool. Conversation history gets the REMAINDER. This asymmetry is fundamental.

---

## Error Handling

| Hook              | On Error                                                                |
|-------------------|-------------------------------------------------------------------------|
| `init`            | **Fail-loud by default**: the error is surfaced and the execution **aborts**. A layer with `onInitError: 'disable'` is instead **disabled** for the execution (diagnostic logged). |
| `recall`          | Layer **skipped** this iteration. Warning emitted.                      |
| `store`           | Error **logged**. Other stores unaffected (`allSettled`).               |
| `onItemAppend`    | Error **logged**. Items pass through unchanged.                         |
| `beforeToolCall`  | Error **logged**. Tool call proceeds as if hook returned `void`.        |
| `afterModelCall`  | Error **logged**. Turn continues as if hook returned `void`.            |
| `onSpawn`         | Layer **unavailable** in child. Warning emitted.                        |
| `onReturn`        | Error **logged**. Parent state unchanged.                               |
| `onComplete`      | Error **logged**.                                                       |
| `dispose`         | Error **logged**. Must not prevent other layer cleanup.                 |

### Timeouts

```typescript
interface LayerTimeouts {
  init?:            number;  // ms, default 10_000
  recall?:          number;  // ms, default 5_000
  store?:           number;  // ms, default 30_000
  onItemAppend?:    number;  // ms, default 5_000
  beforeToolCall?:  number;  // ms, default 5_000
  afterModelCall?:  number;  // ms, default 5_000
  onSpawn?:         number;  // ms, default 10_000
  onReturn?:        number;  // ms, default 10_000
  onComplete?:      number;  // ms, default 30_000
  dispose?:         number;  // ms, default 5_000
}
```

### Disabled Layer Behavior

A layer disabled via `onInitError: 'disable'` is marked with an explicit disabled flag on the layer state store and skipped by every hook, **including `dispose()`** — nothing was initialized, so there is nothing to tear down. Recorded in trace as `{ layerId, status: 'disabled', reason }`. The flag is per execution and cleared on store cleanup.

---

## Memory Across Spawn Boundaries (see also `04-spawn`)

| Layer Scope | Spawn Behavior                                                                       |
|-------------|--------------------------------------------------------------------------------------|
| `execution` | `onSpawn` MUST be provided for child access. No automatic sharing.                   |
| `thread`    | Same thread → shared via storage. Different thread → isolated.                       |
| `resource`  | Shared via storage regardless of thread. `onSpawn` controls in-memory state.         |
| `global`    | Shared via storage. `onSpawn` controls in-memory state.                              |

Child state is a **deep clone**. Mutations in child do NOT affect parent. State crosses the boundary only via `onReturn`.

---

## Validation Rules

Validated at agent construction time (not first execution):

| Rule                                    | Error                    |
|-----------------------------------------|--------------------------|
| Duplicate `id` in memory array          | `DuplicateLayerIdError`  |
| `slot` is not a finite number           | `InvalidSlotError`       |
| `scope` is not a valid `MemoryScope`    | `InvalidScopeError`      |
| `budget.min > budget.max`               | `InvalidBudgetError`     |
| `budget.min < 0`                        | `InvalidBudgetError`     |
| Layer has no hooks at all               | `EmptyLayerError` (warn) |
| `storage` undefined + layer has `init`  | `MissingStorageError`    |
