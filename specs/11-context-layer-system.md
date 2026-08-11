# Context Layer System

> **Module:** `@noetic-tools/context` (source at `packages/context/src/**`); the `ContextLayer` contract is owned by `@noetic-tools/types` (`packages/types/src/types/context-layer.ts`, also at the `@noetic-tools/types/contract` subpath). Both are re-exported by `@noetic-tools/core`.
> **Depends On:** `07-context-and-event-log` (ItemLog, Item — type import only), `10-observability` (LayerTraceSpan, trace conventions), `04-spawn` (SpawnOpts — referenced in SpawnParams)
> **Exports:** `ContextLayer`, `ContextLayerHooks`, `ContextScope`, `BudgetConfig`, `Slot`, `InitParams`, `InitResult`, `RecallParams`, `RecallResult`, `StoreParams`, `StoreResult`, `SpawnParams`, `SpawnResult`, `ReturnParams`, `ReturnResult`, `CompleteParams`, `DisposeParams`, `BeforeToolCallParams`, `BeforeToolCallResult`, `AfterModelCallParams`, `AfterModelCallResult`, `OnItemAppendParams`, `OnItemAppendResult`, `RerenderScope`, `ParentUpdateParams`, `ParentUpdateResult`, `ExecutionOutcome`, `ExecutionContext`, `ScopedStorage`, `StorageAdapter`, `ProjectionPolicy`, `LayerTimeouts`, `LayerProvides`, `LayerDataDecl`, `LayerFunctionDecl`, `ContextConfig`, `InferContext`, `InferContextShape`, `layerData`, `layerFn`, `context`, `storageGetMany`, `LayerPlacement`, `RenderDeltaParams`, `ContextCacheConfig`, `ContextCacheStore`, `ContextEpoch`, `AnchorPin`, `LayerChurn`, `ReanchorReason`

## Module Boundary

The context layer system lives in `@noetic-tools/context` (`packages/context/src/**`), built on the dependency-free `@noetic-tools/types` foundation. It has a strict import boundary so that consumers who only use the context contract (custom layer authors) can tree-shake the interpreter and runtime code out of their bundle.

| Owned by `@noetic-tools/types` | Lives in `@noetic-tools/context` |
|---|---|
| `ContextLayer` interface and all hook types | Layer lifecycle orchestration (`initLayers`, `recallLayers`, etc.) |
| `ContextScope`, `ScopedStorage`, `StorageAdapter` | Projector (View assembly algorithm) in `projector.ts` |
| `BudgetConfig`, `Slot` | budget algorithm; `allocateBudgets` in `budget.ts` |
| `ExecutionContext` (layer-facing read-only view) | built-in layer factories under `context/layers/` |
| `ProjectionPolicy` | Projector implementation in `projector.ts` |

`Context` (the full execution object) lives in `@noetic-tools/core`'s `runtime/`; the `contextToExecCtx` mapping (Context → ExecutionContext) bridges core to the context contract.

**Boundary rule:** `@noetic-tools/context` depends only on `@noetic-tools/types` and MUST NOT import from `@noetic-tools/core`. Pure helpers needed by both sides (`frameworkCast`, `createMessage`, `estimateTokens`, `isAssistantMessage`, `isUserMessage`, `isOutputText`) live in `@noetic-tools/types`. This keeps the context package tree-shakable from the interpreter/runtime graph; importing a context layer factory does not pull in `ContextImpl`.

**Custom layer authors** import from `@noetic-tools/context` (or, equivalently, from `@noetic-tools/core`, which re-exports it). Their bundle contains only the context contract, the layer factories they use, and the shared `@noetic-tools/types` helpers — not the interpreter or runtime.

---

## Overview

A `ContextLayer` is a plugin that participates in the agent execution lifecycle to recall context before LLM calls and persist information after them. Context layers are the sole extension point for injecting non-conversation content into the View (the assembled item array sent to the model).

Normative language uses **MUST**, **SHOULD**, and **MAY** per RFC 2119.

---

## Mental Model: Reactive-Inspired Context Assembly

The layer system is loosely inspired by reactive programming — not in the formal RxJS/MobX sense, but in spirit: the View (what the LLM sees) is always re-assembled from current layer state before each request, producing a fresh, consistent snapshot.

**Context is the result of all layers converging — it is not itself a layer.** You define layers; the agent harness converges them. Their convergence is the context. Context is never exposed as an input, never passed into a layer hook, and never something you construct directly. It is the output.

**Recall is a type of layer, not a separate system.** Long-term recall (facts fetched from storage) and "context injection" (information injected for this turn) are both expressed as layers with the same hook interface. The mechanism is identical; the purpose differs. The `slot` number determines where in the converged result each layer's contribution appears.

**Each layer is one of two things** (or both):
- A **window section** — a portion of the context budget reserved for specific content (skills, reminders, entity facts)
- A **map/reduce** over prior information — transforming raw history or storage into a condensed, relevant form (summarization layers, RAG layers, episodic context)

**Context is scoped, not global.** callModel steps can share a converged context, operate in their own, or run in a child context created from a parent via `spawn`. There is no ambient global context. Spawned children are not fully isolated — they can receive updates from the parent context during their execution, and layers control whether and how those updates are incorporated.

**Internally reactive; externally hooks.** Users implementing custom layers do not write reactive pipelines. They implement lifecycle hooks (`recall`, `store`, `afterModelCall`, etc.) and the agent harness handles orchestration, ordering, budgeting, and re-evaluation. The reactive behavior is an implementation detail, not a user-facing API.

**Loose pattern, not strict formalism.** The reactive inspiration is a mental model, not a contract. Formal reactive concepts (observables, subscriptions, schedulers) do not appear in this API. The goal is the insight — always-fresh context from converging layers — without the boilerplate or jargon.

### Stale Context (Non-Default)

Context can be explicitly marked stale, causing the next request to block until all layers finish revalidating. This is opt-in for layers that need guaranteed consistency before the LLM call proceeds. The default `recall()` model is sufficient for most layers.

---

## The `ContextLayer` Interface

```typescript
interface ContextLayer<TState = unknown> {
  id: string;
  name?: string;
  slot: number;
  scope: ContextScope;
  budget?: BudgetConfig;
  hooks: ContextLayerHooks<TState>;
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
  /**
   * Which band of the assembled view this layer's recall output occupies.
   * - `'anchor'`: before history, pinned for the epoch (prompt-cache stable).
   * - `'live'`: after history, re-rendered freely.
   * - `'auto'` (default): starts anchored; the runtime MAY move it at an epoch
   *   boundary from observed churn. Explicit values are never overridden.
   */
  placement?: LayerPlacement;
}

type LayerPlacement = 'anchor' | 'live' | 'auto';

type ContextScope =
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
  SCRATCHPAD:  100,
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
interface ContextLayerHooks<TState = unknown> {
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
  renderDelta?:     (params: RenderDeltaParams<TState>)          => Promise<string | null>;
}
```

`renderDelta` is called only for an **anchored** layer whose pinned output has gone stale, to describe the change compactly instead of republishing the whole block. Returning `null` — or throwing, or timing out — falls back to republishing the full new content. It is never called for `'live'` layers, which re-render anyway. See **Prompt-Cache Anchoring** below.

`projectHistory` is a read-side hook: it receives the full historical items from `itemLog` and returns a (possibly narrower) projection used as `historyItems` in the next `assembleView` call. Layers compose in slot order, each receiving the output of the previous layer. Storage (`itemLog`, `accumulatedItems`) is never mutated by this hook — see `history` in spec 12 for the canonical use case.

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

- **Disabled-layer skip.** A layer whose `init` threw with `onInitError: 'disable'` is marked disabled via an **explicit flag** on the layer state store (`disable`/`isDisabled`) and is skipped by *every* later hook — `recall`, `store`, `onSpawn`, `onComplete`, `dispose`, `onItemAppend`, `projectHistory`, `beforeToolCall`, `afterModelCall`. The flag — not the absence of state — is the disabled signal, so a layer that legitimately cleared its state keeps running (its hooks receive `undefined` state). The store distinguishes the two via `has` (any state entry, including an explicit `undefined`): an init-bearing layer with **no entry at all** was never initialized for the execution (e.g. a bare `harness.run()` outside a session) and is skipped — its hooks MUST NOT run with `undefined` state, since init never seeded the state they were written against. A custom state store without explicit tracking falls back to the legacy sentinel (init-bearing layer with no state), which cannot make the cleared/uninitialized distinction.
- **State clearing.** `store` (and `onComplete`) detect the returned object with `'state' in result`, not `result.state !== undefined`, so a layer MAY clear its state by returning `{ state: undefined }`. Clearing deletes the durable key, so the next execution's `init` sees no saved state and falls back to its default. Clearing does NOT disable the layer.
- **`onReturn` requirements.** Only the *child*'s state is required to merge. A parent that never initialized state can still be seeded from the child; `onReturn` is skipped only when the child produced no state.
- **Child boundaries.** Both `spawn` (spec 04) and each `inParallel` path (spec 03) are child executions and run the `onSpawn`/`onReturn` pair. inParallel paths merge one at a time even when they execute concurrently, so each merge sees the previous path's contribution.
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
  /**
   * The child's execution context — the same one passed to `onSpawn`. Layers
   * merging several concurrent children (fan-out) namespace by
   * `childCtx.executionId` instead of letting the last child to return
   * overwrite its siblings.
   */
  childCtx: ExecutionContext;
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

There is a single allocator, `allocateBudgets` (in `context/budget.ts`). It splits the recall budget derived from the resolved `ProjectionPolicy` across layers, leaving a reserve for conversation history. The naive per-layer ceiling is gone.

### Policy Resolution

The policy that drives both allocation and view assembly is resolved per callModel step:

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
  layers: ContextLayer[];
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

Both modes recall once per callModel step. The harness runs atomic layers (`recallLayersAtomic`) and eventual layers (`recallLayersEventual`) and merges the two result sets in slot order.

A harness configured with `forceAtomicRecall: true` treats **every** layer as atomic regardless of its `recallMode` — the eventual cache is bypassed entirely.

## Re-render

An `onItemAppend` hook MAY set `rerender: true` to request that affected layers re-run `recall()` after their input transformed the log. The harness collects these requests from the append pipeline, then calls `executeRerender`, which re-recalls the layers selected by each request's `scope` (`'self'`, `'slot-after'`, or `'all'`) and returns fresh layer output. That output is merged over the base recall results **by layer id** (same-id entries replaced, new entries appended, slot order preserved). Re-render depth is bounded (max 3) to prevent infinite cascades.

---

## Scope Enforcement

### Scope Key Resolution

```typescript
function resolveScopeKey(scope: ContextScope, ctx: ExecutionContext): string {
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
  getMany<T>(keys: string[]): Promise<Map<string, T>>;
}
```

A layer declaring `scope: 'thread'` CANNOT accidentally read another thread's data.

### Cross-Scope Access

To read a different scope, declare the broader scope. No escape hatches.

---

## Layer Provides

A context layer MAY declare a `provides` map exposing typed data projections and callable functions to the rest of the agent. This gives code steps structured access to layer state without reaching into layer internals, and gives callModel steps automatic tool access to layer capabilities.

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
type LayerHandle<T extends ContextLayer> = T extends { provides: infer P }
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

Code steps access a layer's provides via `ctx.context['layerId']`, where the key is the layer's `id` string:

```typescript
const value = ctx.context['layerId'].someData;              // synchronous read
const result = await ctx.context['layerId'].someFunction({ query: 'test' });  // async call
```

Layers without `provides` produce an empty `{}` entry in `ctx.context`.

### Automatic LLM Tool Injection

Every `LayerFunctionDecl` in a layer's `provides` map is automatically exposed as a tool to any callModel step running within the layer's context. Tool names are namespaced as `{layerId}/{functionName}` to avoid collisions across layers. The `description`, `input` schema, and `output` schema from the declaration are used directly as the tool definition. The agent harness handles argument validation, state lookup, and state updates transparently.

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

### Type-Safe Context Access

The `context()` builder wraps a layer tuple in a `ContextConfig` that preserves individual layer types for compile-time inference:

```typescript
function context<const T extends readonly ContextLayer[]>(layers: T): ContextConfig<T>;

interface ContextConfig<TLayers extends readonly ContextLayer[] = readonly ContextLayer[]> {
  readonly layers: TLayers;
  readonly _shape: InferContextShape<TLayers>;
}
```

`InferContext<T>` extracts the typed context shape from a config (analogous to `z.infer<>` for Zod):

```typescript
type InferContext<T extends ContextConfig> = T['_shape'];
```

`TContext` is the first generic parameter on `Step` and `Context`, enabling end-to-end type safety:

```typescript
const mem = context([scratchpad(), counterLayer()]);
type Mem = InferContext<typeof mem>;

step.runCode<Mem>({
  id: 'work',
  execute: async (input, ctx) => {
    ctx.context['scratchpad'].snapshot;  // typed
    await ctx.context.counter.increment({ amount: 1 });  // typed
  },
});
```

Layer factories MUST use `satisfies ContextLayer<TState>` (not a return type annotation) and `as const` on the `id` field to preserve literal types for inference.

---

## Future Considerations

### Narrowed Scope (Not Yet Designed)

A potential optimization: allow a layer to declare interest in a specific subset of a parent scope rather than the whole thing. A specialist layer — one that cares only about user preferences or an active task list — could subscribe only to those keys and avoid receiving or processing unrelated parent context changes.

This would require extending `ContextScope` with a selector variant (e.g. key patterns or glob matching), adding filtering logic to `onParentUpdate` dispatch, and defining access-control semantics for `ScopedStorage`. The tradeoffs (pattern-matching cost per `store()`, complexity of the access model) need evaluation before committing to a design. Not scheduled.

---

## `StorageAdapter`

The raw storage backend. The agent harness wraps it in `ScopedStorage`.

```typescript
interface StorageAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  getMany?<T>(keys: string[]): Promise<Map<string, T>>;
}
```

### Batch Reads

`list(prefix)` returns keys, not values, so every consumer that wants the values
behind a prefix reads them afterwards — structurally an N+1. On an in-memory
adapter that costs nothing; on a D1- or network-backed one it is a query per key,
and the places that do it (the step ledger's `load`, the embedding cache) are on
recovery and startup paths where a burst of round trips hurts most.

`getMany` collapses those reads into one call. It is **optional** so adapters
written before it existed remain valid, which means no consumer may call it
directly. They call `storageGetMany(storage, keys)` instead — it delegates when
the backend implements the method and sweeps `get` in parallel when it does not.

Keys with no stored value are **absent** from the returned map. The map is never
sparse-with-nulls, so `map.size < keys.length` is how a caller sees that
something was missing, and a falsy stored value (`0`, `''`, `false`) is present
rather than mistaken for absence.

The returned map carries no ordering guarantee: a backend may return rows in
whatever order the underlying query produced. A caller whose correctness depends
on order (the ledger, where a later entry at a path must win over an earlier one)
must iterate its own key list and look values up, not iterate the map.

`ScopedStorage` exposes `getMany` as a **required** method — the scoped wrapper
supplies the fallback, so a layer author never checks for it. Its returned keys
are scope-relative, with the namespace prefix stripped, as with `list`.

### Serialization Constraint

All values MUST be JSON-serializable. No `Map`, `Set`, `Date` objects, or circular references. Use `Object.fromEntries()`, `Array.from()`, ISO timestamps, and `null` for intentional absence.

### State Migration

Layers own their migration. Recommended: versioned state with explicit migration in `init`.

---

## `ExecutionContext` (Layer-Specific)

The narrow, read-only context that context layer hooks receive:

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

`ExecutionContext` includes `readonly fs: FsAdapter` so context layers can perform filesystem operations (e.g., reading config files, persisting state to disk) through the harness's configured adapter.

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
4. Band the output: anchored layers (pinned) before history, live layers after,
   changed anchors gathered into one supersede message (see Prompt-Cache Anchoring)
5. Assemble: system items | anchor band | history | live band | supersedes | tail
6. Conversation history gets the remaining budget, with overflow policy applied
7. Result is Item[] — directly passable to the LLM provider
```

---

## Prompt-Cache Anchoring

Provider prompt caches match on a **prefix**: the first changed token invalidates every token after it. Assembling layer output ahead of conversation history therefore puts the most volatile content before the largest stable content, and re-bills the whole window whenever any layer re-renders.

The runtime splits layer output into two bands so that placement follows volatility rather than semantic priority:

```
[system] [anchor layers, slot asc] [history] [live layers, slot asc] [supersedes] [tail]
```

`slot` still orders layers **within** a band; `placement` chooses the band. A slot-90 live layer therefore renders after a slot-350 anchored one.

### Epochs

An **epoch** is a run of assemblies sharing a cacheable prefix. Within an epoch the anchor band is **append-only**: each anchored layer's first render is pinned, and those exact items are re-sent on every later assembly even when `recall()` produces something different. The change is published instead as a single `developer` message after the live band:

```
<context_updates epoch="t:thread-1#3">
These supersede the blocks with the same layer id earlier in this context.
Where they disagree, these are correct.
<update layer="plan" action="replace">…</update>
<update layer="notes" action="retract">This block no longer applies. Disregard it.</update>
<update layer="facts" action="add">…</update>
</context_updates>
```

Three actions MUST be representable: `replace` (pinned content changed), `retract` (a pinned layer produced nothing this turn — leaving its block standing unmarked would show the model content the runtime knows no longer applies), and `add` (a layer first seen mid-epoch, which cannot be spliced into a frozen prefix).

Layers never see epochs. `recall()` keeps its contract — return the current full content, every turn — and all cache reasoning stays in the runtime.

### Cache Lineage

Epochs are keyed by lineage, not execution: `depth === 0` keys on `threadId`, deeper executions key on their own `executionId`. A session mints a fresh `executionId` per turn, so keying on execution would re-anchor every turn and pin nothing; spawn and inParallel children inherit their parent's `threadId` but assemble a different view, so they must not inherit its pins.

### Re-anchor Triggers

Re-anchoring refreshes every pin from fresh recall output and drops all supersedes. It happens only when the prefix is already invalid, so it costs nothing:

| Reason | Trigger |
|---|---|
| `cold-start` | No epoch for this lineage |
| `instructions-changed` | Resolved instructions hash differs |
| `cache-miss` | The model's own token report shows the prefix was not cached |
| `delta-pressure` | Supersedes outgrew the band they patch |
| `delta-overflow` | Supersedes no longer fit the window |
| `max-age` | The epoch reached `maxEpochAssemblies` |

`delta-pressure` and `delta-overflow` are decided during assembly; the rest are decided before it. `cache-miss` is recorded from a response and applied at the **next** assembly, so a response steering later rejects cannot leave the epoch half-rebuilt.

### Asking For The Cache

A stable prefix is necessary but not sufficient. Anthropic caching is **opt-in**: without a `cache_control` breakpoint on the request it caches nothing, however byte-identical the prefix is — measured against live Haiku 4.5 and Sonnet 4.5, which reported zero cached tokens across an 18,925-token identical prefix. OpenAI and Gemini cache on their own and ignore the directive.

The runtime therefore sends `cache_control: { type: 'ephemeral' }` on every model request while anchoring is enabled, and OpenRouter places the breakpoints. The same measurement with the directive in place caches 18,922 of 18,925 tokens from the second turn on.

It is tied to `contextCache.enabled` rather than sent unconditionally because a cache **write** costs more than a plain read (1.25× input on Anthropic, against 0.1× for a read): the breakpoint only pays off when something is deliberately holding the prefix still, which is exactly what anchoring does.

The directive is sent to **every** model rather than only the families that need it. Measured across providers on the Responses API, sending the same identical prefix twice:

| Model | With directive | Without |
|---|---|---|
| `anthropic/claude-haiku-4.5` | 18,922 / 18,925 | **0** |
| `moonshotai/kimi-k3` | 14,336 from turn 2 | — |
| `deepseek/deepseek-v4-flash` | 16,896 from turn 2 | **0** |
| `openai/gpt-5.2`, `gpt-5.4` | unchanged | unchanged |
| `z-ai/glm-5`, `glm-5.2` | unchanged | unchanged |
| `minimax/minimax-m3` | unchanged | unchanged |

No provider rejected it. Providers that cache on their own are unaffected, so a per-family allowlist would add a maintenance burden and a new way to be wrong without buying anything.

**Placement is API-specific.** On OpenRouter's Responses API only the top-level field takes effect; a `cache_control` attached to a content part — the form OpenRouter documents for chat completions — is ignored. Adapters reaching a provider through a schema-validated SDK will also find the field stripped from the request as an unknown key, so it has to be injected where the request body is final.

### Reading Cache Telemetry

The `cache-miss` trigger reads `LLMResponse.rounds[0]`, and three rules keep it from eating itself:

1. **Only the first round counts.** Later rounds replay the same view plus tool traffic and hit the cache whatever the first round did; summing them hides a total miss behind a busy tool loop.
2. **Young epochs are spared.** The assembly right after a re-anchor *writes* the cache rather than reading it, so its near-zero read is expected. Nothing is judged before `minEpochAssemblies`.
3. **The floor scales to what there was to cache** (`min(minCachedTokens, expected * 0.5)`). A short prompt can never reach a fixed floor, and holding it to one would re-anchor forever.

A provider that reports no cache figures — `cachedTokens` absent, not zero — or that misses persistently is marked **cache-blind**, and the trigger stops being consulted. Age and delta pressure still bound the epoch. Adapters MUST preserve the absent/zero distinction rather than defaulting to `0`.

### Placement of `'auto'` Layers

Per-layer content hashes give churn telemetry for free. At an epoch boundary **and only then**, an `'auto'` layer changing at least `autoDemoteChurn` of watched assemblies moves to the live band, and one changing at most `autoPromoteChurn` returns to the anchor band. The gap between the two thresholds is deliberate: a layer sitting between them keeps its current band, so one hovering near the boundary does not flip every epoch and undo the stability the bands exist to provide. Churn counters survive re-anchors, decayed by `churnDecay`, so placement is not relearnt from nothing each time.

### Non-Idempotent Recall

A layer whose `recall()` returns state has committed a change as it rendered and MUST NOT be pinned — replaying an earlier render would discard the very thing that call committed. The runtime flags such output (`RecallLayerOutput.mutatedState`) and forces it to the live band regardless of declared placement. The built-in `steering` layer is the canonical case: it drains its pending queue as it renders.

### Configuration

```typescript
interface ContextCacheConfig {
  enabled?: boolean;              // default true
  minCachedTokens?: number;       // default 100
  minEpochAssemblies?: number;    // default 2
  maxEpochAssemblies?: number;    // default 50
  deltaBudgetFraction?: number;   // default 0.15
  autoDemoteChurn?: number;       // default 0.5
  autoPromoteChurn?: number;      // default 0.2
  minChurnSamples?: number;       // default 3
  churnDecay?: number;            // default 0.5
}
```

Set on the harness as `contextCache`. Anchoring is **on by default**; `enabled: false` renders every layer before history, as it did before bands existed.

### Limitation: History Overflow

Once conversation history exceeds its budget, the projector drops from the front, which moves the anchor/history boundary and loses the history portion of the cache on every subsequent turn. The `[system][anchor]` prefix still caches. Pair anchoring with `history` (spec 12) to keep the boundary still.

### Hard Token Cap (`assembleView`)

Given a `ProjectionPolicy`, `assembleView` holds the assembled view to a hard budget of `policy.tokenBudget − policy.responseReserve`, in priority order:

1. **System items are always kept** — they anchor the conversation and are never dropped.
2. **The anchor band is considered slot-ascending; non-fitting items are dropped individually.** Layer-output items are independent contributions with no contiguity requirement, so an item that exceeds the remaining budget is skipped while later (higher-slot) items that still fit are kept. Lower-slot (foundational) output gets first claim on the budget, and higher-slot output is dropped first when space is tight — but a single oversized item never evicts everything after it.
3. **The live band claims next**, by the same rule.
4. **The tail is always kept.** It carries steering guidance — the correction a retry exists to deliver — so the budget never drops it.
5. **Supersedes are never dropped, and claim ahead of history.** Each one corrects a pinned block that is already in the view, so dropping it would leave the model reading content the runtime knows is stale — silent corruption, and worse than losing a turn of history. History absorbs the cost; `deltaBudgetFraction` keeps the supersedes from growing large enough for that to matter.
6. **History takes the remainder, keeping the most recent turns.** Older items are dropped first; an optional `windowSize` caps item count before the token pass (sliding-window overflow).
7. **Orphan tool calls are stripped** at the slice boundary — any dangling `function_call` / `function_call_output` left after trimming history is removed.

Without a `policy`, the inputs are concatenated as-is (optionally sliding the history window by `windowSize`).

### Conversation History is Not a Context Layer

The ItemLog's rendering is handled by the Projector natively. Context layers get budgets FROM a pool. Conversation history gets the REMAINDER. This asymmetry is fundamental.

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
| `renderDelta`     | Falls back to republishing the layer's full new content. A supersede is a correctness obligation and is never skipped because a hook misbehaved. |

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

## Context Across Spawn Boundaries (see also `04-spawn`)

| Layer Scope | Spawn Behavior                                                                       |
|-------------|--------------------------------------------------------------------------------------|
| `execution` | `onSpawn` MUST be provided for child access. No automatic sharing.                   |
| `thread`    | Same thread → shared via storage. Different thread → isolated.                       |
| `resource`  | Shared via storage regardless of thread. `onSpawn` controls in-layer state.         |
| `global`    | Shared via storage. `onSpawn` controls in-layer state.                              |

Child state is a **deep clone**. Mutations in child do NOT affect parent. State crosses the boundary only via `onReturn`.

---

## Validation Rules

Validated at agent construction time (not first execution):

| Rule                                    | Error                    |
|-----------------------------------------|--------------------------|
| Duplicate `id` in layer array          | `DuplicateLayerIdError`  |
| `slot` is not a finite number           | `InvalidSlotError`       |
| `scope` is not a valid `ContextScope`    | `InvalidScopeError`      |
| `budget.min > budget.max`               | `InvalidBudgetError`     |
| `budget.min < 0`                        | `InvalidBudgetError`     |
| Layer has no hooks at all               | `EmptyLayerError` (warn) |
| `storage` undefined + layer has `init`  | `MissingStorageError`    |
