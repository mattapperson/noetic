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
  recallLayers(layers: MemoryLayer[], input: string, ctx: Context): Promise<LayerOutput[]>;
  storeLayers(layers: MemoryLayer[], response: LLMResponse, ctx: Context): Promise<void>;
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
}

interface LayerOutput {
  slot: number;
  items: Item[];
}

interface ChannelHandle<T> {
  send(value: T): void;
  readonly closed: boolean;
  readonly channel: Channel<T>;
}
```

---

## Key Design Points

- **`send`/`recv`/`tryRecv` on the runtime** means the runtime controls channel storage. `InMemoryRuntime` uses a `Map`. `DurableRuntime` uses a message broker. The `Context` methods are thin wrappers: `ctx.send(ch, v)` calls `runtime.send(ch, v, ctx)`. `ctx.tryRecv(ch)` calls `runtime.tryRecv(ch, ctx)`.
- **`getChannelHandle`** returns a `ChannelHandle<T>` for external code to write into a running execution. The handle is typed, lifecycle-aware, and scoped to the root execution. External handles route to the correct execution via `executionId`. `InMemoryRuntime` uses in-process handles; `DurableRuntime` translates to durable signals (e.g., Temporal signals, Inngest events).
- **Memory layer methods** manage the full lifecycle defined in `11-memory-layer-system`. `initLayers` runs `init()` sequentially. `recallLayers` runs `recall()` in slot order and returns `Item[]`. `storeLayers` runs `store()` concurrently via `Promise.allSettled` and receives `LLMResponse` (with items + usage). `disposeLayers` runs `dispose()` in reverse order. Error handling follows the per-hook policy.
- **`assembleView`** is the Projector — it calls `recallLayers`, allocates token budgets, and assembles system prompt item + layer output items + conversation history items into the View as `Item[]`. This is what `executeLLM` calls internally before sending items to the model.
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
| `InMemoryRuntime`    | Testing, simple scripts, CLI tools                              | In-process handles |
| `DurableRuntime`     | Production — backed by Temporal, Inngest, or custom event store | Translates to durable signals |
| `DistributedRuntime` | Multi-node — A2A, worker pools, cloud functions                 | Translates to network messages |

```typescript
import { setRuntime, InMemoryRuntime } from '@orchid/core';

setRuntime(new InMemoryRuntime());
```

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
