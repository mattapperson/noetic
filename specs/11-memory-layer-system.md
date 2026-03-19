# Memory Layer System

> **Depends On:** `07-context-and-event-log` (ItemLog, Item), `10-observability` (MemoryTraceSpan, trace conventions), `04-spawn` (SpawnOpts — referenced in SpawnParams)
> **Exports:** `MemoryLayer`, `MemoryHooks`, `MemoryScope`, `BudgetConfig`, `Slot`, `InitParams`, `InitResult`, `RecallParams`, `RecallResult`, `StoreParams`, `StoreResult`, `SpawnParams`, `SpawnResult`, `ReturnParams`, `ReturnResult`, `CompleteParams`, `DisposeParams`, `BeforeToolCallParams`, `BeforeToolCallResult`, `AfterModelCallParams`, `AfterModelCallResult`, `ExecutionOutcome`, `ExecutionContext`, `ScopedStorage`, `StorageAdapter`, `ProjectionPolicy`, `LayerTimeouts`

---

## Overview

A `MemoryLayer` is a plugin that participates in the agent execution lifecycle to recall context before LLM calls and persist information after them. Memory layers are the sole extension point for injecting non-conversation content into the View (the assembled item array sent to the model).

Normative language uses **MUST**, **SHOULD**, and **MAY** per RFC 2119.

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
}

type MemoryScope = 'thread' | 'resource' | 'global' | 'execution';

type BudgetConfig =
  | number
  | { min: number; max: number }
  | 'auto';
```

### Slot Constants

```typescript
export const Slot = {
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

The runtime sorts layers by slot ascending. Ties broken by array index (stable sort). Custom layers SHOULD use multiples of 10 within these ranges. The runtime does NOT enforce slot uniqueness.

---

## Lifecycle Hooks

```typescript
interface MemoryHooks<TState = unknown> {
  init?:            (params: InitParams)                         => Promise<InitResult<TState>>;
  recall?:          (params: RecallParams<TState>)               => Promise<RecallResult<TState> | string | null>;
  store?:           (params: StoreParams<TState>)                => Promise<StoreResult<TState> | void>;
  beforeToolCall?:  (params: BeforeToolCallParams<TState>)       => Promise<BeforeToolCallResult | void>;
  afterModelCall?:  (params: AfterModelCallParams<TState>)       => Promise<AfterModelCallResult<TState> | void>;
  onSpawn?:         (params: SpawnParams<TState>)                => Promise<SpawnResult<TState> | null>;
  onReturn?:        (params: ReturnParams<TState>)               => Promise<ReturnResult<TState> | void>;
  onComplete?:      (params: CompleteParams<TState>)             => Promise<void>;
  dispose?:         (params: DisposeParams<TState>)              => Promise<void>;
}
```

### Lifecycle Sequence

The runtime MUST execute hooks in this order:

```
EXECUTION START
│
├─ init()              Sequential, array order. MUST complete before any recall().
│                      Throws → layer DISABLED for this execution.
│
▼
LOOP ITERATION ─────────────────────────────────────────────────
│
├─ recall()            Sequential, SLOT ORDER (ascending). Ties by array index.
│
├─ [VIEW ASSEMBLY]     Projector assembles system prompt item + layer output items + history items.
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

**String shorthand:** `recall` MAY return a plain `string` instead of a `RecallResult`. The runtime wraps it in a `developer` message item and estimates the token count automatically. This avoids boilerplate for layers that only inject text.

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

type ExecutionOutcome = 'success' | 'failure' | 'aborted';
```

### Concurrency Rules for `store()`

1. Each store hook receives a **snapshot** of its own layer state. Mutations don't affect other layers.
2. `Promise.allSettled`, NOT `Promise.all`. Individual failures don't prevent other layers.
3. Store hooks MUST NOT mutate shared execution state. `ExecutionContext` is read-only.

---

## Budget Allocation

### Algorithm (Normative)

```typescript
function allocateBudgets(
  layers: MemoryLayer[],
  totalBudget: number,
  responseReserve: number,
  systemPromptTokens: number,
): Map<string, number> {
  const available = totalBudget - responseReserve - systemPromptTokens;
  const budgets = new Map<string, number>();
  const configs = layers.map(l => ({ id: l.id, ...normalizeBudget(l.budget) }));

  // Phase 1: Satisfy minimum guarantees
  let remaining = available;
  for (const cfg of configs) {
    const allocated = Math.min(cfg.min, remaining);
    budgets.set(cfg.id, allocated);
    remaining -= allocated;
  }

  // Phase 2: Distribute remaining proportionally up to max
  const unsatisfied = configs.filter(c => budgets.get(c.id)! < c.max);
  const totalCapacity = unsatisfied.reduce(
    (sum, c) => sum + (c.max - budgets.get(c.id)!), 0
  );

  if (totalCapacity > 0 && remaining > 0) {
    const forLayers = Math.floor(remaining * 0.6);  // 40% reserved for history
    for (const cfg of unsatisfied) {
      const headroom = cfg.max - budgets.get(cfg.id)!;
      const share = Math.floor(forLayers * (headroom / totalCapacity));
      budgets.set(cfg.id, budgets.get(cfg.id)! + Math.min(share, headroom));
    }
  }

  // Phase 3: Remaining goes to conversation history (implicit)
  return budgets;
}

function normalizeBudget(b: BudgetConfig | undefined): { min: number; max: number } {
  if (b === undefined || b === 'auto') return { min: 0, max: Infinity };
  if (typeof b === 'number') return { min: 0, max: b };
  return b;
}
```

### Budget Yielding

When `recall()` returns `tokenCount` less than allocated, the difference goes to conversation history. The Projector MUST NOT reallocate to other layers (prevents cascading re-recalls).

### Budget Verification

Runtime independently counts tokens. If layer-reported count diverges by >10%, runtime count is authoritative and a warning is emitted.

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

## `StorageAdapter`

The raw storage backend. The runtime wraps it in `ScopedStorage`.

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
  tokenize(text: string): number;
  trace: {
    setAttribute(key: string, value: string | number | boolean): void;
    addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
  };
}
```

Note what is NOT on `ExecutionContext`: no `getLayerState()`, no `storage` (captured in `init`), no `itemLog` mutation, no `setRenderingHint()`.

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
3. Run recall() hooks (sequential, slot order)
4. Assemble: system prompt item (role: system) + layer output items (role: developer) + conversation history items
5. Conversation history gets remaining budget after layers, with overflow policy applied
6. Result is Item[] — directly passable to callModel
```

### Conversation History is Not a Memory Layer

The ItemLog's rendering is handled by the Projector natively. Memory layers get budgets FROM a pool. Conversation history gets the REMAINDER. This asymmetry is fundamental.

---

## Error Handling

| Hook              | On Error                                                                |
|-------------------|-------------------------------------------------------------------------|
| `init`            | Layer **disabled** for this execution. Warning emitted.                 |
| `recall`          | Layer **skipped** this iteration. Warning emitted.                      |
| `store`           | Error **logged**. Other stores unaffected (`allSettled`).               |
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
  beforeToolCall?:  number;  // ms, default 5_000
  afterModelCall?:  number;  // ms, default 5_000
  onSpawn?:         number;  // ms, default 10_000
  onReturn?:        number;  // ms, default 10_000
  onComplete?:      number;  // ms, default 30_000
  dispose?:         number;  // ms, default 5_000
}
```

### Disabled Layer Behavior

Skipped for all hooks. `dispose()` still called. Recorded in trace as `{ layerId, status: 'disabled', reason }`.

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
