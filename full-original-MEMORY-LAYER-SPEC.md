# `@orchid/core` — Memory Layer Specification

> **Status**: Draft v2
> **Scope**: Normative specification for the `MemoryLayer` primitive, its lifecycle contract, runtime guarantees, and built-in reference implementations.

-----

## 1. Overview

A `MemoryLayer` is a plugin that participates in the agent execution lifecycle to recall context before LLM calls and persist information after them. Memory layers are the sole extension point for injecting non-conversation content into the View (the assembled message array sent to the model).

This document is divided into normative sections (the contract) and informative sections (reference implementations and examples). Normative language uses **MUST**, **SHOULD**, and **MAY** per RFC 2119. Informative sections are marked as such.

### 1.1 Design Goals

1. **Composable**: Independently-authored layers combine without coordination.
1. **Replaceable**: Every built-in layer is a factory function returning a `MemoryLayer`. No special-casing in the runtime.
1. **Predictable**: The runtime provides explicit guarantees about ordering, error handling, concurrency, and state isolation.
1. **Debuggable**: Every layer interaction is traceable.

### 1.2 Non-Goals

- Conversation history rendering. The Event Log's own projection into the View is handled by the Projector, not by a memory layer. (See §8 for the rationale.)
- Cross-layer coordination or conflict resolution. Layers are independent; the Projector assembles their outputs without arbitration. Higher-level coordination (e.g., "suppress RAG when working memory already answers the query") is a concern for skill-level logic or a future coordination protocol.

-----

## 2. The `MemoryLayer` Interface

```typescript
/**
 * A MemoryLayer is a plain object. No classes, no inheritance.
 * If it satisfies this interface, it is a memory layer.
 */
interface MemoryLayer<TState = unknown> {
  /**
   * Unique identifier. MUST be unique within an agent's memory array.
   * Used as the key for state storage, budget allocation, and trace spans.
   *
   * Convention: use kebab-case. Built-in layers use:
   *   'working-memory', 'semantic-recall', 'observational-memory', 'episodic-memory'
   */
  id: string;

  /** Human-readable name. Appears in projector section headers and traces. */
  name: string;

  /**
   * Insertion slot in the View. Determines WHERE this layer's recalled
   * content appears relative to other layers.
   *
   * The runtime sorts layers by slot ascending. Layers with the same slot
   * are ordered by their index in the agent's `memory` array (stable sort).
   *
   * Built-in slot conventions:
   *   Slot.WORKING_MEMORY   = 100
   *   Slot.ENTITY            = 150
   *   Slot.OBSERVATIONS      = 200
   *   Slot.PROCEDURAL        = 250
   *   Slot.EPISODIC          = 300
   *   Slot.RAG               = 350
   *   Slot.SEMANTIC_RECALL   = 400
   *
   * Custom layers SHOULD use multiples of 10 within these ranges.
   * The runtime does NOT enforce slot uniqueness.
   */
  slot: number;

  /**
   * Scoping declaration. The runtime enforces this — see §5.
   *
   * 'thread':    State is isolated per conversation thread.
   * 'resource':  State is shared across threads for the same resource
   *              (user, entity, or whatever the resource represents).
   * 'global':    State is shared across all executions.
   * 'execution': State exists only for the lifetime of one execution.
   *              spawn() creates a new scope; the parent's onSpawn hook
   *              controls what (if anything) crosses the boundary.
   */
  scope: MemoryScope;

  /** Token budget configuration. See §4. */
  budget?: BudgetConfig;

  /** Lifecycle hooks. All optional. See §3. */
  hooks: MemoryHooks<TState>;

  /** Configurable timeouts per hook. See §6.2. */
  timeouts?: Partial<LayerTimeouts>;
}

type MemoryScope = 'thread' | 'resource' | 'global' | 'execution';

/**
 * Budget can be:
 *  - A fixed number of tokens (hard cap).
 *  - A range with min/max (the Projector allocates within this range).
 *  - 'auto' (equivalent to { min: 0, max: Infinity } — Projector decides).
 *  - Undefined (equivalent to 'auto').
 */
type BudgetConfig =
  | number
  | { min: number; max: number }
  | 'auto';
```

### 2.1 Named Slot Constants (Informative)

To reduce magic-number collisions, the library exports slot constants:

```typescript
export const Slot = {
  WORKING_MEMORY:  100,
  ENTITY:          150,
  OBSERVATIONS:    200,
  PROCEDURAL:      250,
  EPISODIC:        300,
  RAG:             350,
  SEMANTIC_RECALL: 400,
} as const;
```

Custom layers SHOULD pick slots that express their semantic position relative to built-ins. The numeric gaps (50 between each) allow interleaving.

-----

## 3. Lifecycle Hooks

### 3.1 Hook Interface

```typescript
interface MemoryHooks<TState = unknown> {
  init?:       (params: InitParams)                => Promise<InitResult<TState>>;
  recall?:     (params: RecallParams<TState>)      => Promise<RecallResult<TState> | null>;
  store?:      (params: StoreParams<TState>)       => Promise<StoreResult<TState> | void>;
  onSpawn?:    (params: SpawnParams<TState>)       => Promise<SpawnResult<TState> | null>;
  onReturn?:   (params: ReturnParams<TState>)      => Promise<ReturnResult<TState> | void>;
  onComplete?: (params: CompleteParams<TState>)    => Promise<void>;
  dispose?:    (params: DisposeParams<TState>)     => Promise<void>;
}
```

### 3.2 Lifecycle Sequence

The runtime MUST execute hooks in this order:

```
EXECUTION START
│
├─ init()              For each layer, sequentially in array order.
│                      MUST complete before any recall() is called.
│                      If init() throws → layer is DISABLED for this
│                      execution (see §6). Other layers proceed.
│
▼
LOOP ITERATION ─────────────────────────────────────────────────────
│
├─ recall()            For each layer with a recall hook, sequentially
│                      in SLOT ORDER (ascending). Ties broken by array index.
│                      Each recall() receives state guaranteed to be
│                      non-null (init has run). See §3.3 for the
│                      state guarantee.
│
├─ [VIEW ASSEMBLY]     Projector assembles system prompt + layer outputs
│                      + conversation history. See §4.
│
├─ [LLM CALL]
│
├─ store()             For each layer with a store hook, CONCURRENTLY
│                      via Promise.allSettled(). Each layer receives
│                      its own state snapshot — no shared mutation.
│                      See §3.5 for concurrency rules.
│
├─ (if spawning)
│   ├─ onSpawn()       Sequential, in array order.
│   │   ...child...
│   └─ onReturn()      Sequential, in array order.
│
└─ (loop continues or...)
    │
    ▼
EXECUTION END
│
├─ onComplete()        Sequential, in array order.
│                      Always runs (even if execution failed/aborted).
│
└─ dispose()           Sequential, in reverse array order.
                       Always runs. Errors are logged, not thrown.
```

### 3.3 State Guarantee

The `TState` parameter eliminates the "is state null or not?" ambiguity:

- If a layer provides an `init` hook, the runtime calls it first and stores the returned `state`. All subsequent hooks receive this state (never `null`).
- If a layer does NOT provide an `init` hook, its state is `undefined` throughout the execution. The `TState` parameter SHOULD be `void` in this case.

```typescript
/**
 * InitResult provides the initial state.
 * After init(), state is guaranteed non-null for all subsequent hooks.
 */
interface InitResult<TState> {
  state: TState;
}

/**
 * For layers without init, TState = void and state params are omitted
 * from the types via conditional mapping (see §17 for full types).
 *
 * For layers WITH init, state is always TState (never TState | null).
 */
```

To support both stateful and stateless layers cleanly:

```typescript
// Stateless layer — no init, state is never referenced
function ragMemory(config: RagConfig): MemoryLayer<void> {
  return {
    id: 'rag',
    name: 'Knowledge Base',
    slot: Slot.RAG,
    scope: 'global',
    hooks: {
      recall: async ({ query }) => {
        // No state parameter needed — TState is void
        const chunks = await config.retriever.search(query);
        // ...
      },
    },
  };
}

// Stateful layer — init provides state, all hooks receive it
function workingMemory(config: WMConfig): MemoryLayer<WorkingMemoryState> {
  return {
    id: 'working-memory',
    name: 'Working Memory',
    slot: Slot.WORKING_MEMORY,
    scope: config.scope ?? 'thread',
    hooks: {
      init: async ({ storage, scopeKey }) => {
        const stored = await storage.get(`wm:${scopeKey}`);
        return { state: stored ?? config.defaultState };
      },
      recall: async ({ state }) => {
        // state is WorkingMemoryState, guaranteed non-null
      },
    },
  };
}
```

### 3.4 Hook Parameters

```typescript
interface InitParams {
  /** Scoped storage accessor. See §5. */
  storage: ScopedStorage;
  /** The resolved scope key for this layer. See §5. */
  scopeKey: string;
  /** Read-only execution metadata. */
  ctx: ExecutionContext;
}

interface RecallParams<TState> {
  /** The full event log up to this point. */
  log: EventLog;
  /** The latest user input or task prompt. */
  query: string;
  /** Read-only execution metadata. */
  ctx: ExecutionContext;
  /** This layer's current state (non-null if init was provided). */
  state: TState;
  /** This layer's allocated token budget for this recall. */
  budget: number;
}

interface RecallResult<TState = unknown> {
  /** Messages to inject into the View at this layer's slot. */
  messages: Message[];
  /**
   * Actual token count of the injected messages.
   * The runtime VERIFIES this against its own count. If the layer's
   * reported count differs by more than 10%, the runtime's count is
   * used and a warning is emitted to the trace.
   */
  tokenCount: number;
  /** Optionally updated state. */
  state?: TState;
}

interface StoreParams<TState> {
  /** Events produced by this LLM call only. */
  newEvents: Event[];
  /** The full event log including new events. */
  log: EventLog;
  /** The LLM response. */
  response: LLMResponse;
  /** Read-only execution metadata. */
  ctx: ExecutionContext;
  /** This layer's current state (snapshot — mutations don't affect other layers). */
  state: TState;
}

interface StoreResult<TState> {
  state: TState;
}

interface SpawnParams<TState> {
  parentState: TState;
  childCtx: ExecutionContext;
  spawnOpts: SpawnOptions;
}

interface SpawnResult<TState> {
  /** Initial state for this layer in the child. null = layer disabled in child. */
  childState: TState | null;
  /** Messages to inject into the child's initial event log. */
  messages?: Message[];
}

interface ReturnParams<TState> {
  childState: TState;
  childLog: EventLog;
  parentState: TState;
  result: unknown;
}

interface ReturnResult<TState> {
  parentState: TState;
}

interface CompleteParams<TState> {
  log: EventLog;
  ctx: ExecutionContext;
  state: TState;
  outcome: ExecutionOutcome;
}

interface DisposeParams<TState> {
  state: TState;
}

type ExecutionOutcome = 'success' | 'failure' | 'aborted';
```

### 3.5 Concurrency Rules for `store()`

Store hooks run concurrently because they are independent post-processing. The runtime enforces isolation:

1. Each store hook receives a **snapshot** of its own layer state. If the hook returns `{ state }`, the runtime atomically replaces the layer's state. If two store hooks somehow share a layer ID (a configuration error), the last write wins.
1. The runtime uses `Promise.allSettled`, NOT `Promise.all`. Individual store failures do not prevent other layers from completing. Failures are recorded in the execution trace.
1. Store hooks MUST NOT call `ctx` methods that mutate shared execution state. The `ExecutionContext` passed to store hooks exposes only read-only properties.

-----

## 4. Budget Allocation

### 4.1 Budget Configuration

```typescript
type BudgetConfig =
  | number                        // Fixed cap: layer gets at most this many tokens
  | { min: number; max: number }  // Range: Projector allocates within bounds
  | 'auto';                       // Projector decides (equivalent to { min: 0, max: Infinity })
```

### 4.2 Allocation Algorithm (Normative)

The Projector allocates budgets in three phases:

```typescript
function allocateBudgets(
  layers: MemoryLayer[],
  totalBudget: number,
  responseReserve: number,
  systemPromptTokens: number,
): Map<string, number> {
  const available = totalBudget - responseReserve - systemPromptTokens;
  const budgets = new Map<string, number>();

  // Normalize all configs to { min, max }
  const configs = layers.map(l => ({
    id: l.id,
    ...normalizeBudget(l.budget),
  }));

  // Phase 1: Satisfy minimum guarantees
  let remaining = available;
  for (const cfg of configs) {
    const allocated = Math.min(cfg.min, remaining);
    budgets.set(cfg.id, allocated);
    remaining -= allocated;
  }

  // Phase 2: Distribute remaining to layers up to their max,
  // proportional to (max - min) / total_remaining_capacity
  const unsatisfied = configs.filter(c => budgets.get(c.id)! < c.max);
  const totalCapacity = unsatisfied.reduce(
    (sum, c) => sum + (c.max - budgets.get(c.id)!), 0
  );

  if (totalCapacity > 0 && remaining > 0) {
    // Reserve 40% of remaining for conversation history
    const forLayers = Math.floor(remaining * 0.6);
    remaining -= forLayers;
    let layerPool = forLayers;

    for (const cfg of unsatisfied) {
      const headroom = cfg.max - budgets.get(cfg.id)!;
      const share = Math.floor(layerPool * (headroom / totalCapacity));
      const additional = Math.min(share, headroom);
      budgets.set(cfg.id, budgets.get(cfg.id)! + additional);
    }
  }

  // Phase 3: Remaining tokens go to conversation history
  // (implicitly — the Projector uses totalBudget minus sum of layer allocations)

  return budgets;
}

function normalizeBudget(b: BudgetConfig | undefined): { min: number; max: number } {
  if (b === undefined || b === 'auto') return { min: 0, max: Infinity };
  if (typeof b === 'number') return { min: 0, max: b };
  return b;
}
```

### 4.3 Budget Yielding

When a layer's `recall()` returns a `tokenCount` less than its allocated budget, the difference is returned to the conversation history pool. The Projector MUST NOT reallocate yielded tokens to other memory layers (this prevents cascading re-recalls).

### 4.4 Budget Verification

The runtime independently counts tokens in the returned `messages` using the tokenizer for the configured model. If the layer-reported `tokenCount` diverges from the runtime count by more than 10%, the runtime count is authoritative and a warning is emitted:

```typescript
interface TraceWarning {
  type: 'budget_mismatch';
  layerId: string;
  reportedTokens: number;
  actualTokens: number;
}
```

### 4.5 Tokenizer

The runtime provides a `tokenize` function scoped to the current model:

```typescript
interface ExecutionContext {
  // ... other fields ...

  /**
   * Count tokens for the currently configured model.
   * Layers SHOULD use this rather than their own estimator.
   */
  tokenize: (text: string) => number;
}
```

-----

## 5. Scope Enforcement

The `scope` field is not just documentation — the runtime enforces it.

### 5.1 Scope Key Resolution

When a layer is initialized, the runtime resolves a `scopeKey` based on the declared scope:

```typescript
function resolveScopeKey(
  scope: MemoryScope,
  ctx: ExecutionContext,
): string {
  switch (scope) {
    case 'thread':    return ctx.threadId;
    case 'resource':  return ctx.resourceId ?? ctx.threadId;  // falls back to thread
    case 'global':    return '__global__';
    case 'execution': return ctx.executionId;
  }
}
```

### 5.2 Scoped Storage

Layers do NOT receive raw storage. They receive a `ScopedStorage` wrapper that automatically namespaces all keys:

```typescript
interface ScopedStorage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

// Internally, keys are prefixed:
// `layers/${layerId}/${scopeKey}/${userKey}`
//
// A layer declaring scope: 'thread' CANNOT accidentally read
// another thread's data because the scopeKey differs.
```

### 5.3 Cross-Scope Access

If a layer needs to read data from a different scope (e.g., a thread-scoped layer that occasionally checks resource-level config), it MUST declare `scope: 'resource'` (the broader scope). The runtime does not provide escape hatches for reading outside your declared scope.

-----

## 6. Error Handling

### 6.1 Error Policy by Hook

| Hook         | On Error                                                                           | Rationale                                                    |
|--------------|------------------------------------------------------------------------------------|--------------------------------------------------------------|
| `init`       | Layer is **disabled** for this execution. Other layers proceed. Warning emitted.   | A broken layer shouldn't prevent the agent from running.     |
| `recall`     | Layer is **skipped** for this iteration. Empty messages injected. Warning emitted. | The View can be assembled without this layer's contribution. |
| `store`      | Error is **logged**. Other store hooks are unaffected (`allSettled`).              | Store is best-effort; the LLM call already succeeded.        |
| `onSpawn`    | Layer is **unavailable** in child. Warning emitted.                                | Child can run without this layer.                            |
| `onReturn`   | Error is **logged**. Parent state is unchanged.                                    | Parent can continue without child's learnings.               |
| `onComplete` | Error is **logged**.                                                               | Execution is already done.                                   |
| `dispose`    | Error is **logged**.                                                               | Must not prevent cleanup of other layers.                    |

### 6.2 Timeout Policy

Every hook invocation is subject to a configurable timeout (default: 5 seconds for `recall`, 30 seconds for `store`, 10 seconds for all others). Timeouts are treated as errors and follow the error policy above.

```typescript
interface LayerTimeouts {
  init?:       number;  // ms, default 10_000
  recall?:     number;  // ms, default 5_000
  store?:      number;  // ms, default 30_000
  onSpawn?:    number;  // ms, default 10_000
  onReturn?:   number;  // ms, default 10_000
  onComplete?: number;  // ms, default 30_000
  dispose?:    number;  // ms, default 5_000
}
```

### 6.3 Disabled Layer Behavior

A disabled layer (due to init failure):

- Is skipped for all subsequent hook calls.
- Has its `dispose()` called at execution end (if it has one) to clean up partial state.
- Is recorded in the execution trace as `{ layerId, status: 'disabled', reason: Error }`.

-----

## 7. Observability

Every hook invocation produces a trace span. The runtime MUST emit structured trace events compatible with OpenTelemetry conventions.

### 7.1 Trace Events

```typescript
interface MemoryTraceSpan {
  /** Layer that produced this span. */
  layerId: string;
  /** Which hook was invoked. */
  hook: keyof MemoryHooks;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Whether the hook succeeded. */
  status: 'ok' | 'error' | 'timeout' | 'skipped';
  /** For recall: tokens allocated vs. tokens used. */
  budget?: { allocated: number; used: number; yielded: number };
  /** For recall: number of messages injected. */
  messageCount?: number;
  /** Error details if status is 'error' or 'timeout'. */
  error?: { message: string; stack?: string };
}
```

### 7.2 Layer-Level Tracing

Layers MAY emit custom trace attributes via the context:

```typescript
interface ExecutionContext {
  // ... other fields ...
  trace: {
    /** Add a custom attribute to the current span. */
    setAttribute(key: string, value: string | number | boolean): void;
    /** Record a point-in-time event within the current span. */
    addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
  };
}
```

-----

## 8. Conversation History is Not a Memory Layer

Previous iterations of this design attempted to model conversation history (message history) as a `MemoryLayer`. This was abandoned because:

1. **Conversation history is the baseline.** It's the Event Log's own rendering — the thing everything else augments. Making it a layer implies it's optional or swappable at the same level as semantic recall, which is misleading.
1. **It doesn't fit the lifecycle.** Message history doesn't "recall" (it IS the recall). It doesn't "store" (events are appended by the runtime, not by a hook). Forcing it into the hook interface required a "rendering hints" escape hatch that broke the abstraction.
1. **Budget allocation treats it differently.** Memory layers get allocated budgets FROM a pool. Conversation history gets the REMAINDER of that pool. This asymmetry is fundamental, not incidental.

The Projector handles conversation history rendering natively via `ProjectionPolicy`:

```typescript
interface ProjectionPolicy {
  /** Max tokens for the entire View. */
  tokenBudget: number;
  /** Tokens reserved for the model's response. */
  responseReserve: number;
  /** How to handle conversation history that exceeds remaining budget. */
  overflow: 'truncate' | 'summarize' | 'sliding_window';
  /** For 'summarize': which model to use. */
  overflowModel?: string;
  /** For 'sliding_window': how many recent messages to always keep. */
  windowSize?: number;
}
```

-----

## 9. Memory Across Spawn Boundaries

### 9.1 Spawn Lifecycle

When `spawn()` creates a child execution, the runtime processes each layer:

```
Parent calls spawn(opts)
│
├─ For each layer (sequential, array order):
│   ├─ Has onSpawn hook?
│   │   ├─ Yes → call onSpawn({ parentState, childCtx, spawnOpts })
│   │   │   ├─ Returns { childState, messages? } → layer active in child
│   │   │   └─ Returns null → layer disabled in child
│   │   └─ No → layer disabled in child
│   │
│   └─ (continue to next layer)
│
├─ Child execution runs with its own state snapshots
│
├─ Child completes
│
└─ For each layer (sequential, array order):
    └─ Has onReturn hook AND was active in child?
        ├─ Yes → call onReturn({ childState, childLog, parentState, result })
        │   ├─ Returns { parentState } → update parent state
        │   └─ Returns void → parent state unchanged
        └─ No → skip
```

### 9.2 State Isolation Guarantee

Child state is a **deep clone** of whatever `onSpawn` returns. Mutations in the child do NOT affect the parent's state, and vice versa. The only moment state crosses the boundary is via the explicit `onReturn` hook.

### 9.3 Scope Interactions

| Layer Scope | Spawn Behavior                                                                       |
|-------------|--------------------------------------------------------------------------------------|
| `execution` | `onSpawn` MUST be provided for child access. No automatic sharing.                   |
| `thread`    | Same thread → state is shared via storage (not cloned). Different thread → isolated. |
| `resource`  | Shared via storage regardless of thread. `onSpawn` controls in-memory state.         |
| `global`    | Shared via storage. `onSpawn` controls in-memory state.                              |

-----

## 10. The `ExecutionContext` Interface

This is the runtime-provided context that all hooks receive. It is deliberately narrow to prevent layers from reaching into runtime internals.

```typescript
interface ExecutionContext {
  /** Unique ID for this execution (one per top-level run or spawned child). */
  readonly executionId: string;

  /** Thread identifier. Stable across calls in the same conversation. */
  readonly threadId: string;

  /** Resource identifier (user, entity). May be undefined if not configured. */
  readonly resourceId: string | undefined;

  /** Current step number in the execution loop. */
  readonly stepNumber: number;

  /** Cumulative token usage for this execution. */
  readonly tokenUsage: { input: number; output: number };

  /** Cumulative cost for this execution. */
  readonly cost: number;

  /** The model being used for LLM calls. */
  readonly model: string;

  /** Count tokens for the current model. */
  tokenize(text: string): number;

  /** Tracing interface. */
  trace: {
    setAttribute(key: string, value: string | number | boolean): void;
    addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
  };
}
```

Note what is NOT on `ExecutionContext`:

- No `getLayerState()` / `setLayerState()`. State is passed to hooks as a parameter and returned as a result. The runtime manages the state map internally.
- No `storage`. Storage is provided as `ScopedStorage` via `InitParams` only. Layers that need storage access in other hooks should capture it during `init`.
- No `eventLog` mutation. The log is read-only in all hook parameters.
- No `setRenderingHint()`. This was an earlier design mistake.

-----

## 11. The `StorageAdapter` Interface

Layers persist state through a `StorageAdapter`. The runtime wraps it in `ScopedStorage` (§5.2) before providing it to layers.

```typescript
interface StorageAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
```

### 11.1 Serialization Constraint

All values passed to `set()` MUST be JSON-serializable. The runtime will `JSON.stringify` before persisting and `JSON.parse` on retrieval. This means:

- `Map` and `Set` are NOT directly storable. Use `Object.fromEntries()` / `Array.from()`.
- `Date` objects are serialized as strings. Use ISO timestamps.
- `undefined` values in objects are dropped. Use `null` for intentional absence.
- Circular references will throw.

### 11.2 Migration

Layers are responsible for migrating their own state. The recommended pattern:

```typescript
interface VersionedState<T> {
  version: number;
  data: T;
}

// In init:
init: async ({ storage, scopeKey }) => {
  const raw = await storage.get<VersionedState<MyStateV2>>('state');
  if (!raw) return { state: defaultState() };
  if (raw.version === 1) return { state: migrateV1toV2(raw.data as MyStateV1) };
  if (raw.version === 2) return { state: raw.data };
  throw new Error(`Unknown state version: ${raw.version}`);
}
```

-----

## 12. `AgentConfig` Integration

```typescript
interface AgentConfig {
  name: string;
  description: string;
  model: string;
  instructions: string | (() => string | Promise<string>);
  tools?: Tool[];
  outputSchema?: ZodType;
  skills?: Skill[];

  /**
   * Memory layers. Each is an independent, hookable module.
   * Array order is the tiebreaker when layers have the same slot.
   *
   * Use the built-in factories or build your own:
   */
  memory?: MemoryLayer[];

  /** Storage backend for memory persistence. */
  storage?: StorageAdapter;

  /** View assembly configuration. */
  projection?: ProjectionPolicy;

  /** Agent-level lifecycle hooks (separate from memory hooks). */
  hooks?: AgentHooks;
}
```

Usage:

```typescript
import {
  agent, Slot,
  workingMemory, semanticRecall, observationalMemory, episodicMemory,
} from '@orchid/core';

const researcher = agent({
  name: 'researcher',
  model: 'anthropic/claude-sonnet-4-20250514',
  instructions: 'You are a research assistant.',
  tools: [searchTool, readFileTool],

  storage: new PgStorage({ connectionString: process.env.DATABASE_URL }),

  memory: [
    workingMemory({
      scope: 'resource',
      schema: z.object({
        userName: z.string().optional(),
        topics: z.array(z.string()).optional(),
      }),
    }),
    observationalMemory({
      bufferThreshold: 8000,
      observerModel: 'anthropic/claude-haiku-4-5-20251001',
    }),
    episodicMemory({
      store: pgEpisodicStore,
      embedder: openaiEmbedder,
    }),
    semanticRecall({
      vectorStore: pgVector,
      embedder: openaiEmbedder,
      topK: 5,
    }),
  ],
});
```

-----

## 13. Built-In Layer Reference Implementations

These are informative — they show how the built-in factories use the primitives. They are NOT special-cased in the runtime.

### 13.1 `workingMemory()`

Always-available structured or freeform state, injected near the top of the View.

```typescript
interface WorkingMemoryConfig {
  scope?: 'thread' | 'resource';
  /** If provided, state is validated against this schema. */
  schema?: ZodType;
  /** If no schema, state is freeform text initialized to this value. */
  template?: string;
  /** If true, the LLM cannot update working memory (read-only context). */
  readOnly?: boolean;
}

function workingMemory(config: WorkingMemoryConfig = {}): MemoryLayer<WorkingMemoryState> {
  type WorkingMemoryState = Record<string, unknown> | string;

  let storage: ScopedStorage;  // captured in init

  return {
    id: 'working-memory',
    name: 'Working Memory',
    slot: Slot.WORKING_MEMORY,
    scope: config.scope ?? 'thread',
    budget: { min: 200, max: 1500 },

    hooks: {
      init: async (params) => {
        storage = params.storage;
        const stored = await storage.get<WorkingMemoryState>('state');
        const defaultState = config.schema ? {} : (config.template ?? '');
        return { state: stored ?? defaultState };
      },

      recall: async ({ state, ctx }) => {
        const content = typeof state === 'string'
          ? state
          : JSON.stringify(state, null, 2);

        if (!content || content === '{}') return null;

        const formatted = `<working_memory>\n${content}\n</working_memory>`;
        return {
          messages: [{ role: 'system' as const, content: formatted }],
          tokenCount: ctx.tokenize(formatted),
        };
      },

      store: async ({ response, state }) => {
        if (config.readOnly) return;

        const updateCall = response.toolCalls?.find(
          tc => tc.name === 'updateWorkingMemory'
        );
        if (!updateCall) return;

        let newState: WorkingMemoryState;
        if (config.schema) {
          const update = config.schema.parse(updateCall.input);
          newState = deepMerge(state as Record<string, unknown>, update);
        } else {
          newState = updateCall.input as string;
        }

        await storage.set('state', newState);
        return { state: newState };
      },

      onSpawn: async ({ parentState }) => {
        if (config.scope === 'resource') {
          return { childState: structuredClone(parentState) };
        }
        return null;
      },
    },
  };
}
```

### 13.2 `semanticRecall()`

Vector-search over past messages, injected for relevant context.

```typescript
interface SemanticRecallConfig {
  vectorStore: VectorStore;
  embedder: Embedder;
  topK?: number;
  /** How many surrounding messages to include with each result. */
  contextWindow?: number | { before: number; after: number };
  minScore?: number;
  scope?: 'thread' | 'resource' | 'global';
}

function semanticRecall(config: SemanticRecallConfig): MemoryLayer<void> {
  return {
    id: 'semantic-recall',
    name: 'Semantic Recall',
    slot: Slot.SEMANTIC_RECALL,
    scope: config.scope ?? 'resource',
    budget: { min: 0, max: 4000 },

    hooks: {
      recall: async ({ query, ctx, budget }) => {
        const embedding = await config.embedder.embed(query);

        const results = await config.vectorStore.search(embedding, {
          topK: config.topK ?? 5,
          filter: { scope: config.scope ?? 'resource', ctx },
          minScore: config.minScore ?? 0.7,
        });

        if (results.length === 0) return null;

        const window = normalizeWindow(config.contextWindow ?? 1);
        const expanded = await expandWithContext(results, window);

        // Trim to budget — drop lowest-scored results first
        const content = trimToBudget(
          expanded,
          budget,
          ctx.tokenize,
        );

        return {
          messages: [{
            role: 'system' as const,
            content: `<semantic_recall>\n${content}\n</semantic_recall>`,
          }],
          tokenCount: ctx.tokenize(content),
        };
      },

      store: async ({ newEvents, ctx }) => {
        const toEmbed = newEvents.filter(
          e => e.kind === 'user' || e.kind === 'assistant'
        );

        // Fire-and-forget embedding (within the store timeout)
        await Promise.all(
          toEmbed.map(async (event) => {
            const text = extractText(event);
            const embedding = await config.embedder.embed(text);
            await config.vectorStore.upsert({
              id: `${ctx.executionId}-${event.id}`,
              embedding,
              metadata: {
                text,
                threadId: ctx.threadId,
                resourceId: ctx.resourceId,
                timestamp: event.timestamp,
              },
            });
          })
        );
      },
    },
  };
}
```

### 13.3 `observationalMemory()`

Distills conversation into concise observations using a background LLM call.

```typescript
interface ObservationalMemoryConfig {
  /**
   * How many tokens of new content must accumulate before the
   * observer runs. Default: 2000.
   */
  bufferThreshold?: number;
  /**
   * Maximum number of observations to keep. When exceeded,
   * oldest observations are compacted (merged) by the observer.
   * Default: 50.
   */
  maxObservations?: number;
  /** Model for the observer LLM call. Default: haiku. */
  observerModel?: string;
  /** Custom observer prompt. */
  observerPrompt?: string;
  scope?: 'thread' | 'resource';
}

interface ObservationalState {
  version: 2;
  observations: Array<{ content: string; timestamp: number; eventRange: [number, number] }>;
  lastProcessedEventId: number;
  accumulatedTokensSinceLastRun: number;
}

function observationalMemory(
  config: ObservationalMemoryConfig = {},
): MemoryLayer<ObservationalState> {
  let storage: ScopedStorage;

  return {
    id: 'observational-memory',
    name: 'Observations',
    slot: Slot.OBSERVATIONS,
    scope: config.scope ?? 'resource',
    budget: { min: 500, max: 2500 },
    // The observer LLM call can take a while
    timeouts: { store: 60_000 },

    hooks: {
      init: async (params) => {
        storage = params.storage;
        const stored = await storage.get<ObservationalState>('state');
        return {
          state: stored ?? {
            version: 2,
            observations: [],
            lastProcessedEventId: -1,
            accumulatedTokensSinceLastRun: 0,
          },
        };
      },

      recall: async ({ state, ctx }) => {
        if (state.observations.length === 0) return null;

        const content = state.observations
          .map(o => `- ${o.content}`)
          .join('\n');

        return {
          messages: [{
            role: 'system' as const,
            content: `<observations>\n${content}\n</observations>`,
          }],
          tokenCount: ctx.tokenize(content),
        };
      },

      store: async ({ newEvents, log, state, ctx }) => {
        const newTokens = newEvents.reduce(
          (sum, e) => sum + ctx.tokenize(extractText(e)), 0
        );
        state.accumulatedTokensSinceLastRun += newTokens;

        const threshold = config.bufferThreshold ?? 2000;
        if (state.accumulatedTokensSinceLastRun < threshold) {
          // Not enough new content — just persist the updated counter
          await storage.set('state', state);
          return { state };
        }

        // Run the observer on unprocessed events
        const unprocessed = log.events.filter(
          e => e.id > state.lastProcessedEventId
        );

        if (unprocessed.length === 0) return { state };

        const newObservations = await runObserver(unprocessed, config);
        state.observations.push(...newObservations);
        state.lastProcessedEventId = unprocessed.at(-1)!.id;
        state.accumulatedTokensSinceLastRun = 0;

        // Compaction: if over maxObservations, merge oldest
        const max = config.maxObservations ?? 50;
        if (state.observations.length > max) {
          state.observations = await compactObservations(
            state.observations, max, config,
          );
        }

        await storage.set('state', state);
        return { state };
      },

      onSpawn: async ({ parentState }) => ({
        childState: structuredClone(parentState),
      }),
    },
  };
}
```

Key differences from v1:

- Single threshold (`bufferThreshold`) instead of confusing dual thresholds.
- Explicit `maxObservations` with compaction to prevent unbounded growth.
- Observer timeout is set to 60s via the `timeouts` config.
- State is versioned for future migration.

### 13.4 `episodicMemory()`

Records execution summaries and retrieves relevant past experiences.

```typescript
interface EpisodicMemoryConfig {
  store: EpisodicStore;
  embedder: Embedder;
  retrieval?: 'embedding' | 'recency' | 'both';
  maxEpisodes?: number;
  scope?: 'resource' | 'global';
}

function episodicMemory(config: EpisodicMemoryConfig): MemoryLayer<void> {
  return {
    id: 'episodic-memory',
    name: 'Past Experiences',
    slot: Slot.EPISODIC,
    scope: config.scope ?? 'resource',
    budget: { min: 0, max: 2000 },

    hooks: {
      recall: async ({ query, ctx, budget }) => {
        const maxEps = config.maxEpisodes ?? 3;
        const retrieval = config.retrieval ?? 'both';
        const episodes: Episode[] = [];

        if (retrieval === 'embedding' || retrieval === 'both') {
          const embedding = await config.embedder.embed(query);
          const results = await config.store.searchByEmbedding(embedding, {
            maxResults: maxEps,
            scope: config.scope ?? 'resource',
            ctx,
          });
          episodes.push(...results);
        }

        if (retrieval === 'recency' || retrieval === 'both') {
          const results = await config.store.getRecent({
            maxResults: maxEps,
            scope: config.scope ?? 'resource',
            ctx,
          });
          episodes.push(...results);
        }

        // Deduplicate by ID, preserving higher-scored entries
        const unique = deduplicateById(episodes);
        if (unique.length === 0) return null;

        const content = formatEpisodes(unique, budget, ctx.tokenize);

        return {
          messages: [{
            role: 'system' as const,
            content: `<past_experiences>\n${content}\n</past_experiences>`,
          }],
          tokenCount: ctx.tokenize(content),
        };
      },

      onComplete: async ({ log, ctx, outcome }) => {
        const episode = await createEpisode(log, ctx, outcome);
        const embedding = await config.embedder.embed(episode.summary);
        await config.store.save(episode, embedding);
      },
    },
  };
}
```

### 13.5 `durableTaskState()`

Persists task-level artifacts (files modified, progress checkpoints, git commits) across spawn boundaries. This replaces a standalone `Persistence` interface — all state that survives across fresh-context iterations is managed uniformly through memory layers.

```typescript
interface DurableTaskStateConfig {
  /**
   * Base directory for task state. Each execution gets a subdirectory.
   * Default: '.orchid/tasks'
   */
  baseDir?: string;
  /**
   * If true, git-commit task state after each store() cycle.
   * Default: false.
   */
  gitCommit?: boolean;
  /**
   * Schema for structured task state. If provided, state is validated.
   * If not, state is freeform JSON.
   */
  schema?: ZodType;
  /**
   * Custom serializer for non-JSON artifacts (binary files, etc.).
   * Default: JSON.stringify/parse.
   */
  serializer?: {
    serialize: (state: unknown) => Promise<Buffer | string>;
    deserialize: (data: Buffer | string) => Promise<unknown>;
  };
}

interface DurableTaskState {
  version: 1;
  data: unknown;
  filesModified: string[];
  checkpoints: Array<{ label: string; timestamp: number }>;
}

function durableTaskState(
  config: DurableTaskStateConfig = {},
): MemoryLayer<DurableTaskState> {
  const baseDir = config.baseDir ?? '.orchid/tasks';
  let storage: ScopedStorage;

  return {
    id: 'durable-task-state',
    name: 'Task State',
    slot: Slot.WORKING_MEMORY + 10,  // just after working memory (slot 110)
    scope: 'execution',
    budget: { min: 100, max: 800 },
    timeouts: { store: 30_000 },

    hooks: {
      init: async (params) => {
        storage = params.storage;
        const stored = await storage.get<DurableTaskState>('state');

        // Also check for state on disk (for recovery after crashes)
        if (!stored) {
          const diskState = await readFromDisk(baseDir, params.ctx.executionId);
          if (diskState) return { state: diskState };
        }

        return {
          state: stored ?? {
            version: 1,
            data: config.schema ? {} : null,
            filesModified: [],
            checkpoints: [],
          },
        };
      },

      recall: async ({ state, ctx }) => {
        if (!state.data && state.filesModified.length === 0) return null;

        const parts: string[] = [];

        if (state.data) {
          parts.push(`Current state:\n${JSON.stringify(state.data, null, 2)}`);
        }

        if (state.filesModified.length > 0) {
          parts.push(`Files modified:\n${state.filesModified.map(f => `- ${f}`).join('\n')}`);
        }

        if (state.checkpoints.length > 0) {
          const latest = state.checkpoints.slice(-3);
          parts.push(`Recent checkpoints:\n${latest.map(c => `- ${c.label}`).join('\n')}`);
        }

        const content = parts.join('\n\n');

        return {
          messages: [{
            role: 'system' as const,
            content: `<task_state>\n${content}\n</task_state>`,
          }],
          tokenCount: ctx.tokenize(content),
        };
      },

      store: async ({ response, state, ctx }) => {
        // Extract state updates from tool calls or structured output
        const stateUpdate = extractTaskStateUpdate(response);
        if (stateUpdate) {
          if (config.schema) {
            state.data = config.schema.parse(
              deepMerge(state.data as Record<string, unknown>, stateUpdate.data),
            );
          } else {
            state.data = stateUpdate.data ?? state.data;
          }

          if (stateUpdate.filesModified) {
            state.filesModified.push(...stateUpdate.filesModified);
            // Deduplicate
            state.filesModified = [...new Set(state.filesModified)];
          }
        }

        // Persist to disk
        await writeToDisk(baseDir, ctx.executionId, state, config.serializer);

        // Persist to storage (for scope-based access)
        await storage.set('state', state);

        // Optional git commit
        if (config.gitCommit) {
          const dir = `${baseDir}/${ctx.executionId}`;
          await exec(`cd ${dir} && git add -A && git commit -m "step ${ctx.stepNumber}" --allow-empty`);
        }

        return { state };
      },

      onSpawn: async ({ parentState, spawnOpts }) => {
        // Task state always crosses spawn boundaries — this is the whole point.
        // The child continues the parent's task.
        return {
          childState: structuredClone(parentState),
        };
      },

      onReturn: async ({ childState, parentState }) => {
        // Merge child's progress back into parent
        return {
          parentState: {
            ...parentState,
            data: childState.data,
            filesModified: [...new Set([
              ...parentState.filesModified,
              ...childState.filesModified,
            ])],
            checkpoints: [
              ...parentState.checkpoints,
              ...childState.checkpoints,
            ],
          },
        };
      },

      onComplete: async ({ state, ctx, outcome }) => {
        // Final checkpoint
        state.checkpoints.push({
          label: `Execution ${outcome}`,
          timestamp: Date.now(),
        });

        await writeToDisk(baseDir, ctx.executionId, state, config.serializer);
        await storage.set('state', state);

        if (config.gitCommit) {
          const dir = `${baseDir}/${ctx.executionId}`;
          await exec(`cd ${dir} && git add -A && git commit -m "execution ${outcome}"`);
        }
      },
    },
  };
}
```

Key design points:

- **Always crosses spawn boundaries.** Unlike other memory layers where `onSpawn` might return `null`, task state always provides child state. The child is continuing the same task.
- **Dual persistence.** State is written to both disk (for crash recovery and git integration) and `ScopedStorage` (for runtime access). The disk path is the source of truth for artifacts; storage is for the runtime lifecycle.
- **Recalls into the View.** The LLM can see what files have been modified, what the current state is, and what checkpoints have been reached. This replaces ad-hoc prompt engineering for task context.
- **Git integration is optional.** `gitCommit: true` enables version-controlled task state, useful for Ralph Wiggum patterns where you want to inspect or rollback individual iterations.

-----

## 14. Custom Layer Examples (Informative)

### 14.1 RAG Knowledge Base

```typescript
function ragMemory(config: {
  retriever: DocumentRetriever;
  maxChunks: number;
  reranker?: Reranker;
}): MemoryLayer<void> {
  return {
    id: 'rag-knowledge-base',
    name: 'Knowledge Base',
    slot: Slot.RAG,
    scope: 'global',
    budget: { min: 0, max: 6000 },

    hooks: {
      recall: async ({ query, budget, ctx }) => {
        let chunks = await config.retriever.search(query, config.maxChunks * 2);

        if (config.reranker) {
          chunks = await config.reranker.rerank(query, chunks, config.maxChunks);
        } else {
          chunks = chunks.slice(0, config.maxChunks);
        }

        if (chunks.length === 0) return null;

        const content = formatChunksToBudget(chunks, budget, ctx.tokenize);

        return {
          messages: [{
            role: 'system' as const,
            content: `<knowledge_base>\n${content}\n</knowledge_base>`,
          }],
          tokenCount: ctx.tokenize(content),
        };
      },
    },
  };
}
```

### 14.2 Entity Graph

```typescript
function entityMemory(config: {
  extractorModel?: string;
}): MemoryLayer<EntityGraphState> {
  // Use a plain object instead of Map for JSON serialization
  interface EntityGraphState {
    version: 1;
    entities: Record<string, Entity>;
    relations: Array<{ from: string; relation: string; to: string }>;
  }

  let storage: ScopedStorage;

  return {
    id: 'entity-memory',
    name: 'Known Entities',
    slot: Slot.ENTITY,
    scope: 'resource',
    budget: { min: 0, max: 1500 },

    hooks: {
      init: async (params) => {
        storage = params.storage;
        const stored = await storage.get<EntityGraphState>('state');
        return {
          state: stored ?? { version: 1, entities: {}, relations: [] },
        };
      },

      recall: async ({ query, state, ctx }) => {
        const entityIds = Object.keys(state.entities);
        if (entityIds.length === 0) return null;

        const relevant = findRelevantEntities(query, state);
        if (relevant.length === 0) return null;

        const content = relevant
          .map(e => `${e.name} (${e.type}): ${e.summary}`)
          .join('\n');

        return {
          messages: [{
            role: 'system' as const,
            content: `<known_entities>\n${content}\n</known_entities>`,
          }],
          tokenCount: ctx.tokenize(content),
        };
      },

      store: async ({ newEvents, state, ctx }) => {
        const text = newEvents.map(e => extractText(e)).join('\n');
        const extracted = await extractEntities(text, config.extractorModel);

        for (const entity of extracted.entities) {
          const existing = state.entities[entity.id];
          if (existing) {
            state.entities[entity.id] = mergeEntity(existing, entity);
          } else {
            state.entities[entity.id] = entity;
          }
        }
        state.relations.push(...extracted.relations);

        await storage.set('state', state);
        return { state };
      },
    },
  };
}
```

### 14.3 Shared Swarm Memory

```typescript
interface SwarmConfig {
  /**
   * Pub/sub channel. The runtime does NOT manage this —
   * the layer is responsible for connection lifecycle.
   */
  channel: PubSubChannel;
  /** How often to poll for peer updates (ms). Default: 500. */
  pollInterval?: number;
}

function sharedSwarmMemory(config: SwarmConfig): MemoryLayer<SwarmState> {
  interface SwarmState {
    findings: Array<{
      workerId: string;
      finding: string;
      timestamp: number;
    }>;
    /** Track what we've already seen to avoid duplicates. */
    seenIds: Set<string>;
  }

  let subscription: Subscription | null = null;
  let pendingFindings: SwarmState['findings'] = [];

  return {
    id: 'swarm-shared',
    name: 'Swarm Findings',
    slot: 380,  // custom slot between RAG and semantic recall
    scope: 'execution',
    budget: { min: 0, max: 2500 },

    hooks: {
      init: async ({ ctx }) => {
        // Subscribe to peer findings immediately so we don't miss any
        // that arrive during our LLM calls
        subscription = config.channel.subscribe('swarm-finding', (msg) => {
          if (msg.workerId !== ctx.executionId) {
            pendingFindings.push(msg);
          }
        });

        return {
          state: {
            findings: [],
            seenIds: new Set(),  // Note: converted to Array for storage
          },
        };
      },

      recall: async ({ state, ctx }) => {
        // Drain any findings that arrived since last recall
        for (const f of pendingFindings) {
          const key = `${f.workerId}:${f.timestamp}`;
          if (!state.seenIds.has(key)) {
            state.findings.push(f);
            state.seenIds.add(key);
          }
        }
        pendingFindings = [];

        if (state.findings.length === 0) return null;

        const content = state.findings
          .map(f => `[Worker ${f.workerId}]: ${f.finding}`)
          .join('\n');

        return {
          messages: [{
            role: 'system' as const,
            content: `<swarm_findings>\n${content}\n</swarm_findings>`,
          }],
          tokenCount: ctx.tokenize(content),
          state,  // persist the drained findings
        };
      },

      store: async ({ response, ctx, state }) => {
        const findings = extractFindings(response);
        for (const finding of findings) {
          const entry = {
            workerId: ctx.executionId,
            finding,
            timestamp: Date.now(),
          };
          state.findings.push(entry);
          // Publish to peers
          await config.channel.publish('swarm-finding', entry);
        }
        return { state };
      },

      onSpawn: async ({ parentState }) => ({
        childState: structuredClone(parentState),
      }),

      onReturn: async ({ childState, parentState }) => {
        // Merge child findings into parent, deduplicating
        const merged = [...parentState.findings];
        for (const f of childState.findings) {
          const key = `${f.workerId}:${f.timestamp}`;
          if (!parentState.seenIds.has(key)) {
            merged.push(f);
            parentState.seenIds.add(key);
          }
        }
        return { parentState: { ...parentState, findings: merged } };
      },

      dispose: async () => {
        subscription?.unsubscribe();
        subscription = null;
        pendingFindings = [];
      },
    },
  };
}
```

Key differences from v1:

- Uses a persistent subscription (set up in `init`, torn down in `dispose`) instead of polling/draining in `store`. This eliminates the race condition where findings published during an LLM call are missed.
- Explicit deduplication via `seenIds`.
- Proper cleanup in `dispose`.

-----

## 15. View Assembly (Normative)

The complete View assembly algorithm:

```typescript
async function assembleView(
  agent: AgentConfig,
  input: string,
  ctx: InternalContext,
): Promise<Message[]> {
  const layers = agent.memory ?? [];
  const policy = agent.projection ?? defaultPolicy();

  // 1. Count system prompt tokens
  const systemMessages = await renderSystemPrompt(agent, ctx);
  const systemTokens = systemMessages.reduce(
    (sum, m) => sum + ctx.tokenize(messageToString(m)), 0
  );

  // 2. Allocate budgets
  const budgets = allocateBudgets(layers, policy.tokenBudget, policy.responseReserve, systemTokens);

  // 3. Run recall hooks (sequential, slot order)
  const sorted = [...layers].sort((a, b) => a.slot - b.slot);
  const layerOutputs: Array<{ slot: number; messages: Message[] }> = [];

  for (const layer of sorted) {
    if (!layer.hooks.recall || ctx.isLayerDisabled(layer.id)) continue;

    const budget = budgets.get(layer.id) ?? 0;

    try {
      const result = await withTimeout(
        layer.hooks.recall({
          log: ctx.eventLog,
          query: input,
          ctx: ctx.toPublic(),
          state: ctx.getLayerState(layer.id),
          budget,
        }),
        layer.timeouts?.recall ?? 5_000,
      );

      if (result && result.messages.length > 0) {
        // Verify and trim to budget
        const actualTokens = result.messages.reduce(
          (sum, m) => sum + ctx.tokenize(messageToString(m)), 0
        );

        if (Math.abs(actualTokens - result.tokenCount) / actualTokens > 0.1) {
          ctx.emitWarning({
            type: 'budget_mismatch',
            layerId: layer.id,
            reportedTokens: result.tokenCount,
            actualTokens,
          });
        }

        const trimmed = trimToTokenBudget(result.messages, budget, ctx.tokenize);
        layerOutputs.push({ slot: layer.slot, messages: trimmed });

        if (result.state !== undefined) {
          ctx.setLayerState(layer.id, result.state);
        }
      }
    } catch (err) {
      ctx.emitWarning({ type: 'recall_error', layerId: layer.id, error: err });
      // Layer is skipped for this iteration, not disabled
    }
  }

  // 4. Assemble final View
  const view: Message[] = [
    ...systemMessages,
    ...layerOutputs
      .sort((a, b) => a.slot - b.slot)
      .flatMap(o => o.messages),
  ];

  // 5. Render conversation history with remaining budget
  const usedTokens = view.reduce(
    (sum, m) => sum + ctx.tokenize(messageToString(m)), 0
  );
  const historyBudget = policy.tokenBudget - usedTokens - policy.responseReserve;
  view.push(...renderEventLog(ctx.eventLog, historyBudget, policy));

  return view;
}
```

-----

## 16. Validation Rules

The runtime MUST validate layer configuration at agent construction time (not at first execution):

| Rule                                                  | Error                                  |
|-------------------------------------------------------|----------------------------------------|
| Duplicate `id` in memory array                        | `DuplicateLayerIdError`                |
| `slot` is not a finite number                         | `InvalidSlotError`                     |
| `scope` is not a valid `MemoryScope`                  | `InvalidScopeError`                    |
| `budget.min > budget.max`                             | `InvalidBudgetError`                   |
| `budget.min < 0`                                      | `InvalidBudgetError`                   |
| Layer has no hooks at all                             | `EmptyLayerError` (warning, not fatal) |
| `storage` is undefined but a layer has an `init` hook | `MissingStorageError`                  |

-----

## 17. Complete Type Exports

```typescript
// === Core Primitive ===
export type { MemoryLayer, MemoryHooks, MemoryScope, BudgetConfig };

// === Hook Parameter & Result Types ===
export type {
  InitParams, InitResult,
  RecallParams, RecallResult,
  StoreParams, StoreResult,
  SpawnParams, SpawnResult,
  ReturnParams, ReturnResult,
  CompleteParams,
  DisposeParams,
  ExecutionOutcome,
};

// === Infrastructure ===
export type { ExecutionContext, ScopedStorage, StorageAdapter };
export type { ProjectionPolicy };
export type { MemoryTraceSpan, LayerTimeouts };

// === Slot Constants ===
export { Slot };

// === Built-In Factories ===
export { workingMemory } from './layers/working-memory';
export { semanticRecall } from './layers/semantic-recall';
export { observationalMemory } from './layers/observational-memory';
export { episodicMemory } from './layers/episodic-memory';
export { durableTaskState } from './layers/durable-task-state';
```

-----

## Appendix A: Checklist for Custom Layer Authors

1. **Pick a unique `id`**. Namespace it: `'mycompany/layer-name'`.
1. **Choose the narrowest `scope`**. Don't use `'global'` if `'resource'` suffices.
1. **Implement `init` if you have state**. Use `void` for `TState` if stateless.
1. **Use `ctx.tokenize()`**. Don't bring your own tokenizer.
1. **Respect the `budget` parameter in `recall()`**. Trim your output to fit.
1. **Handle errors in external calls**. The timeout policy is a safety net, not your primary error handling.
1. **Use JSON-serializable state**. No `Map`, `Set`, `Date` objects, or circular references.
1. **Version your state** if you plan to evolve the schema. See §11.2.
1. **Clean up in `dispose()`**. Close connections, cancel subscriptions.
1. **Test with the layer disabled**. Your agent should work (degraded) without any single layer.

## Appendix B: Differences from v1

| v1 Design                                 | v2 Spec                                                     | Rationale                                |
|-------------------------------------------|-------------------------------------------------------------|------------------------------------------|
| `position: number` with magic values      | `slot: number` with named constants (`Slot.WORKING_MEMORY`) | Reduces collisions, improves readability |
| Message history as a MemoryLayer          | Excluded — handled by Projector                             | Didn't fit the abstraction (§8)          |
| `state: TState | null` everywhere         | `state: TState` (non-null after init)                       | Eliminates null-check boilerplate        |
| `budget: number | 'auto'`                 | `BudgetConfig` with min/max ranges                          | Expressive enough for real use cases     |
| `ctx.setRenderingHint()`                  | Removed                                                     | Leaked implementation details            |
| `ctx.getLayerState()` / `setLayerState()` | State passed as params, returned as results                 | Prevents cross-layer state access        |
| `ctx.storage` on every hook               | `ScopedStorage` in init only, captured via closure          | Enforces scope, reduces API surface      |
| No error handling                         | Full error policy per hook (§6)                             | Production requirement                   |
| No timeouts                               | Configurable timeouts per hook (§6.2)                       | Prevents runaway layers                  |
| No tracing                                | Structured trace spans (§7)                                 | Debugging requirement                    |
| `Promise.all` for store                   | `Promise.allSettled` for store                              | One failing layer shouldn't break others |
| `Map<string, Entity>` in entity memory    | `Record<string, Entity>`                                    | JSON serialization compatibility (§11.1) |
| Dual-threshold observational memory       | Single threshold + compaction                               | Simpler model, bounded growth            |
| Swarm memory with drain-in-store          | Persistent subscription in init, cleanup in dispose         | Fixes race condition                     |
| Scope as documentation                    | Scope enforced via `ScopedStorage` (§5)                     | Prevents cross-scope contamination       |
| Unspecified `Context`                     | Narrow, read-only `ExecutionContext` (§10)                  | Explicit API surface                     |
| No validation                             | Construction-time validation (§16)                          | Fail fast on config errors               |
| Self-reported token counts trusted        | Runtime verification with 10% tolerance (§4.4)             | Budget integrity                         |
| `Persistence` interface on `spawn`        | `durableTaskState()` memory layer (§13.5)                   | All persistence is a memory concern      |
