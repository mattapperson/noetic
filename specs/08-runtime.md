# Runtime Interface

> **Depends On:** `01-step-type` (Step), `07-context-and-event-log` (Context, Item, LLMResponse), `06-channels` (Channel, ExternalChannel), `11-memory-layer-system` (MemoryLayer, StorageAdapter), `10-observability` (Span)
> **Exports:** `Runtime`, `AgentConfig`, `setRuntime()`, `setTraceExporter()`

---

## The `Runtime` Interface

The runtime is the engine. It's behind an interface with methods covering execution, context management, channels, durability, memory layer lifecycle, cancellation, and tracing.

```typescript
interface Runtime {
  // Core execution
  execute<I, O>(step: Step<I, O>, input: I, ctx: Context): Promise<O>;

  // Detached (concurrent) execution
  detachedSpawn<I, O>(step: Step<I, O>, input: I, parentCtx: Context): DetachedHandle<O>;

  // Context management
  createContext(opts?: {
    parent?: Context;
    items?: Item[];
    state?: unknown;
    threadId?: string;
    resourceId?: string;
  }): Context;

  // Channel operations (the runtime owns the backing store)
  send<T>(channel: Channel<T>, value: T, ctx: Context): void;
  recv<T>(channel: Channel<T>, ctx: Context, opts?: { timeout?: number }): Promise<T>;
  tryRecv<T>(channel: Channel<T>, ctx: Context): T | null;

  // External channel handles
  getChannelHandle<T>(channel: ExternalChannel<T>, executionId: string): ChannelHandle<T>;

  // Memory layer lifecycle (see 11-memory-layer-system for hook semantics)
  initLayers(layers: MemoryLayer[], ctx: Context, storage: StorageAdapter): Promise<void>;
  recallLayers(layers: MemoryLayer[], input: string, ctx: Context): Promise<RecallLayerOutput[]>;
  storeLayers(layers: MemoryLayer[], response: LLMResponse, ctx: Context): Promise<void>;
  beforeToolCall(layers: MemoryLayer[], toolName: string, toolArgs: unknown, ctx: Context): Promise<SteeringDecision>;
  afterModelCall(layers: MemoryLayer[], response: LLMResponse, ctx: Context): Promise<SteeringDecision>;
  disposeLayers(layers: MemoryLayer[], ctx: Context): Promise<void>;

  // View assembly (the Projector)
  assembleView(agent: AgentConfig, input: string, ctx: Context): Promise<Item[]>;

  // Durability (no-ops in InMemoryRuntime)
  checkpoint(ctx: Context): Promise<void>;
  restore(executionId: string): Promise<Context | null>;

  // Lifecycle
  cancel(ctx: Context, reason?: string): Promise<void>;

  // Observability (see 10-observability)
  createSpan(name: string, parent: Span | null): Span;

  // Layer state access (used by ToolExecutionContext.memory)
  getLayerState<T>(executionId: string, layerId: string): T | undefined;
  setLayerState<T>(executionId: string, layerId: string, state: T): void;
}

interface RecallLayerOutput {
  layerId: string;
  items: Item[];
  tokenCount: number;
}

interface ChannelHandle<T> {
  send(value: T): void;
  readonly closed: boolean;
  readonly channel: Channel<T>;
}

const DetachedStatus = {
  Running: 'running',
  Completed: 'completed',
  Failed: 'failed',
} as const;
type DetachedStatus = (typeof DetachedStatus)[keyof typeof DetachedStatus];

interface DetachedHandle<O> {
  readonly id: string;
  readonly status: DetachedStatus;
  readonly result: O | undefined;
  readonly error: string | undefined;
  await(timeout?: number): Promise<O>;
}
```

---

## Key Design Points

- **`send`/`recv`/`tryRecv` on the runtime** means the runtime controls channel storage. `InMemoryRuntime` uses a `Map`. `DurableRuntime` uses a message broker. The `Context` methods are thin wrappers: `ctx.send(ch, v)` calls `runtime.send(ch, v, ctx)`. `ctx.tryRecv(ch)` calls `runtime.tryRecv(ch, ctx)`.
- **`getChannelHandle`** returns a `ChannelHandle<T>` for external code to write into a running execution. The handle is typed, lifecycle-aware, and scoped to the root execution. External handles route to the correct execution via `executionId`. `InMemoryRuntime` uses in-process handles; `DurableRuntime` translates to durable signals (e.g., Temporal signals, Inngest events).
- **Memory layer methods** manage the full lifecycle defined in `11-memory-layer-system`. `initLayers` runs `init()` sequentially. `recallLayers` runs `recall()` in slot order and returns `Item[]`. `storeLayers` runs `store()` concurrently via `Promise.allSettled` and receives `LLMResponse` (with items + usage). `disposeLayers` runs `dispose()` in reverse order. Error handling follows the per-hook policy.
- **`beforeToolCall(layers, toolName, toolArgs, ctx)`** runs each layer's `beforeToolCall` hook sequentially in slot order before a tool is executed. Returns a `SteeringDecision` — `Allow` proceeds normally, `Deny` short-circuits and blocks the tool call, `Guide` returns guidance text to the model. Short-circuits on the first `Deny`. When multiple layers return `Guide`, their guidance is concatenated.
- **`afterModelCall(layers, response, ctx)`** runs each layer's `afterModelCall` hook sequentially in slot order immediately after the LLM responds. Returns a `SteeringDecision` — `Allow` proceeds normally, `Deny` throws `steering_denied`, `Guide` injects guidance as a developer message and retries the model call (up to 3 times). Short-circuits on the first `Deny`.
- **`assembleView`** is the Projector — it calls `recallLayers`, allocates token budgets, and assembles system prompt item + layer output items + conversation history items into the View as `Item[]`. This is what `executeLLM` calls internally before sending items to the model.
- **`detachedSpawn`** launches a child step concurrently without blocking the caller. Creates a child `Context` with `parent: parentCtx`, starts execution, and returns a `DetachedHandle` immediately. The handle tracks status (`running` / `completed` / `failed`), exposes the result, and supports `await(timeout?)` for blocking on completion. Pairs with the loop inbox channel (see `05-loop-and-until`) for async sub-agent notification patterns.
- **`checkpoint`/`restore`** enable durable execution. `InMemoryRuntime` implements them as no-ops. `DurableRuntime` serializes state (including memory layer state) to its backing store.
- **`cancel`** with propagation. The runtime knows the execution tree (via parent/child context references) and walks it to cancel children. Cancelled executions still run `onComplete` and `dispose` on their memory layers.
- **`createSpan`** lets the runtime control the tracing backend.

### What's NOT on the Runtime

- **`executeFork`** — fork execution is handled by the core `execute` switch. The `fork` variant calls `execute` on each path internally.
- **`summarize`** — summarization is just an LLM call. The `spawn` executor calls `execute(step.llm({ id: 'summarize', ... }), ...)` internally.

---

## Runtime Backends

| Backend              | When to Use                                                     | Channel Handles |
|----------------------|-----------------------------------------------------------------|-----------------|
| `InMemoryRuntime`    | Testing, simple scripts, CLI tools. Auto-detects `callModel` from `OPENROUTER_API_KEY` when none is provided. | In-process handles |
| `DurableRuntime`     | Production — backed by Temporal, Inngest, or custom event store | Translates to durable signals |
| `DistributedRuntime` | Multi-node — A2A, worker pools, cloud functions                 | Translates to network messages |

```typescript
import { setRuntime, InMemoryRuntime } from '@noetic/core';

setRuntime(new InMemoryRuntime());
```

---

## Runtime Registration

`setRuntime()` registers the global singleton runtime for the current process. There is exactly one active runtime per process at any time.

```typescript
function setRuntime(runtime: Runtime): void;
function getRuntime(): Runtime; // throws NoeticConfigError if none set
```

### Singleton Semantics

1. Calling `setRuntime()` after `execute()` has already been called is a `NoeticConfigError` with `code: RUNTIME_ALREADY_IN_USE`. Set the runtime before any execution begins.
2. Calling `setRuntime()` a second time replaces the previous runtime. This is intentional for test isolation (see below) — it is not an error.
3. Calling `execute()` without a prior `setRuntime()` throws `NoeticConfigError` with `code: NO_RUNTIME_SET` and a hint pointing to the setup docs.

### Module Load Order

`setRuntime()` MUST be called at the top of the application entry point, before any module that calls `execute()` is imported or evaluated. In ESM environments, dynamic imports may evaluate lazily — do not rely on import order to ensure the runtime is set before execution begins.

Recommended pattern:

```ts
// entry.ts — first file evaluated
import { setRuntime, InMemoryRuntime } from '@noetic/core';
setRuntime(new InMemoryRuntime());

// All other imports come after
import { runAgent } from './agent';
await runAgent();
```

### Test Isolation

Each test file MUST call `setRuntime()` in a `beforeEach` block. Without this, runtime state leaks between tests and between test files when they share the same process.

```ts
import { setRuntime, InMemoryRuntime } from '@noetic/core';

beforeEach(() => {
  setRuntime(new InMemoryRuntime());
});
```

### Serverless / Stateless Environments

In serverless functions (AWS Lambda, Cloudflare Workers, etc.), the runtime is re-instantiated per cold start. Call `setRuntime()` at module scope so it runs once per instance, not once per invocation:

```ts
// Runs once per cold start
setRuntime(new InMemoryRuntime({ callModel: createOpenRouterCallModel() }));

export const handler = async (event) => {
  return execute(agentStep, event, runtime.createContext());
};
```

In-memory channel storage and non-durable runtimes do not persist across invocations. Use `DurableRuntime` if cross-invocation state is required.

---

## `AgentConfig`

The top-level configuration for an agent, integrating steps, tools, memory layers, and projection policy.

```typescript
interface AgentConfig {
  name: string;
  description: string;
  model: string;
  instructions: string | (() => string | Promise<string>);
  tools?: Tool[];
  outputSchema?: ZodType;

  /** Memory layers. Array order is the tiebreaker when layers share a slot. */
  memory?: MemoryLayer[];

  /** Storage backend for memory persistence. See 11-memory-layer-system. */
  storage?: StorageAdapter;

  /** View assembly configuration. See 11-memory-layer-system. */
  projection?: ProjectionPolicy;

  /** Agent-level lifecycle hooks (separate from memory hooks). */
  hooks?: AgentHooks;
}
```
