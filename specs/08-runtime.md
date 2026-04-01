# AgentHarness Interface

> **Depends On:** `01-step-type` (Step), `07-context-and-event-log` (Context, Item, LLMResponse), `06-channels` (Channel, ExternalChannel), `11-memory-layer-system` (MemoryLayer, StorageAdapter), `10-observability` (Span)
> **Exports:** `AgentHarness`, `AgentConfig`, `setHarness()`, `setTraceExporter()`

---

## The `AgentHarness` Interface

The agent harness is the engine. It's behind an interface with methods covering execution, context management, channels, durability, memory layer lifecycle, cancellation, and tracing.

```typescript
interface AgentHarness<TParams extends Record<string, unknown> = Record<string, unknown>> {
  // Agent configuration
  readonly config: AgentConfig<TParams>;

  // Primary execution — returns a HarnessResult with streaming accessors
  execute(input: ExecuteInput, options?: ExecuteOptions): HarnessResult;

  // Core execution
  run<I, O>(step: Step<I, O>, input: I, ctx: Context): Promise<O>;

  // Detached (concurrent) execution
  detachedSpawn<I, O>(step: Step<I, O>, input: I, parentCtx: Context): DetachedHandle<O>;

  // Context management
  createContext(opts?: {
    parent?: Context;
    items?: Item[];
    state?: unknown;
    threadId?: string;
    resourceId?: string;
    memory?: MemoryLayer[];
  }): Context;

  // Channel operations (the agent harness owns the backing store)
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

  // Durability (no-ops in AgentHarness)
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

## HarnessResult

`execute()` returns a `HarnessResult` synchronously. Before execution starts, the harness walks the step tree to collect all tools from all LLM steps, merges them with layer-provided tools, and deduplicates by name. This **unified tool set** is stored on the execution context and sent with every LLM call for prompt cache efficiency. Individual steps restrict the model to a subset via the Open Responses `tool_choice: { type: "allowed_tools" }` parameter. Execution then starts eagerly in the background. The result provides six accessors for consuming output in different modes.

```typescript
interface HarnessResult {
  getText(): Promise<string>;
  getResponse(): Promise<HarnessResponse>;
  getTextStream(): AsyncIterable<string>;
  getReasoningStream(): AsyncIterable<string>;
  getItemStream(): AsyncIterable<StreamingItem>;
  getFullStream(): AsyncIterable<StreamEvent>;
}

interface HarnessResponse {
  readonly items: ReadonlyArray<Item>;
  readonly usage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  readonly cost?: number;
  readonly text: string;
}

type StreamingItem = Item & { readonly isComplete: boolean };
```

### Stream Accessors

| Method | Returns | Description |
|--------|---------|-------------|
| `getText()` | `Promise<string>` | Complete text after execution finishes |
| `getResponse()` | `Promise<HarnessResponse>` | Full response with items, usage, cost |
| `getTextStream()` | `AsyncIterable<string>` | Text deltas as they arrive from the model |
| `getReasoningStream()` | `AsyncIterable<string>` | Reasoning token deltas (reasoning models) |
| `getItemStream()` | `AsyncIterable<StreamingItem>` | Cumulative item snapshots with `isComplete` flag. Replace, do not append. |
| `getFullStream()` | `AsyncIterable<StreamEvent>` | All raw events (SDK + framework) |

### StreamEvent

Events have a `source` discriminant: `'sdk'` for raw OpenResponses SSE events, `'framework'` for Noetic lifecycle events. Framework events use the harness `config.name` as prefix (e.g., `myagent:step_started`).

```typescript
type StreamEvent = SdkStreamEvent | FrameworkStreamEvent;

interface SdkStreamEvent {
  readonly source: 'sdk';
  readonly type: string;  // OpenResponses event type, e.g. 'response.output_text.delta'
  readonly data: Record<string, unknown>;
  readonly outputIndex?: number;
  readonly contentIndex?: number;
}

interface FrameworkStreamEvent {
  readonly source: 'framework';
  readonly type: `${string}:${string}`;  // e.g. 'myagent:step_started'
  readonly data: Record<string, unknown>;
}
```

### Framework Events

| Event | Description |
|-------|-------------|
| `{name}:step_started` | Emitted before each step executes. Data: `{ stepId, kind }` |
| `{name}:step_completed` | Emitted after each step completes. Data: `{ stepId, kind }` |
| `{name}:tool_round_started` | Emitted before a tool execution round. Data: `{ round, toolCount }` |
| `{name}:tool_call_started` | Emitted before each tool call. Data: `{ name, callId }` |
| `{name}:tool_call_completed` | Emitted after each tool call. Data: `{ name, callId, error }` |
| `{name}:tool_round_completed` | Emitted after all tool calls in a round. Data: `{ round, toolCount }` |
| `{name}:stream_pipe_error` | Emitted when SDK stream piping fails. Data: `{ error }` |

### Streaming Scope

Events from the entire step composition tree flow through `HarnessResult`. All LLM steps encountered during execution (including within loops, branches, forks, and spawns) emit SDK stream events. Non-LLM steps emit framework lifecycle events only.

### Event Emission Control

LLM steps support an optional `emit` field to control framework event emission:

```typescript
step.llm({ id: 'quiet', model: '...', emit: false });           // suppress all
step.llm({ id: 'selective', model: '...', emit: (type) => type === 'step_started' }); // filter
```

- **`true`** (default): all framework events emitted.
- **`false`**: no framework events (`step_started`, `step_completed`, `tool_round_*`, `tool_call_*`) for this step.
- **Filter function**: `(eventType: string, data: Record<string, unknown>) => boolean` — called per event, return `true` to emit.

The `emit` option propagates through `CallModelRequest` to `callModel()`, controlling tool round/call events as well.

### Bounded Buffer

The internal `EventBroadcaster` buffer is capped at 10,000 events. When the buffer exceeds this limit, oldest events are trimmed and active iterator cursors are adjusted. Once all consumers have departed, new events are discarded to prevent unbounded memory growth. Late subscribers receive only the retained window.

### Error Handling

When `execute()` is called without an `initialStep`, all accessors reject with `NoeticConfigError` code `NO_STEP_CONFIGURED`. When execution fails mid-stream, the error propagates to all active stream consumers.

---

## Key Design Points

- **`send`/`recv`/`tryRecv` on the agent harness** means the agent harness controls channel storage. `AgentHarness` uses a `Map`. `DurableAgentHarness` uses a message broker. The `Context` methods are thin wrappers: `ctx.send(ch, v)` calls `harness.send(ch, v, ctx)`. `ctx.tryRecv(ch)` calls `harness.tryRecv(ch, ctx)`.
- **`getChannelHandle`** returns a `ChannelHandle<T>` for external code to write into a running execution. The handle is typed, lifecycle-aware, and scoped to the root execution. External handles route to the correct execution via `executionId`. `AgentHarness` uses in-process handles; `DurableAgentHarness` translates to durable signals (e.g., Temporal signals, Inngest events).
- **Memory layer methods** manage the full lifecycle defined in `11-memory-layer-system`. `initLayers` runs `init()` sequentially. `recallLayers` runs `recall()` in slot order and returns `Item[]`. `storeLayers` runs `store()` concurrently via `Promise.allSettled` and receives `LLMResponse` (with items + usage). `disposeLayers` runs `dispose()` in reverse order. Error handling follows the per-hook policy.
- **`beforeToolCall(layers, toolName, toolArgs, ctx)`** runs each layer's `beforeToolCall` hook sequentially in slot order before a tool is executed. Returns a `SteeringDecision` — `Allow` proceeds normally, `Deny` short-circuits and blocks the tool call, `Guide` returns guidance text to the model. Short-circuits on the first `Deny`. When multiple layers return `Guide`, their guidance is concatenated.
- **`afterModelCall(layers, response, ctx)`** runs each layer's `afterModelCall` hook sequentially in slot order immediately after the LLM responds. Returns a `SteeringDecision` — `Allow` proceeds normally, `Deny` throws `steering_denied`, `Guide` injects guidance as a developer message and retries the model call (up to 3 times). Short-circuits on the first `Deny`.
- **`config`** exposes the `AgentConfig<TParams>` that the harness was constructed with. Steps and tools access harness params via `ctx.harness.config.params`.
- **`memory` on AgentConfig** are default memory layers applied to every context created via `createContext()`. When `createContext` is called with its own `memory` option, the per-call layers take precedence (full override, not merge). When neither is specified, the context has no default layers. This provides a convenient way to set up memory for the entire agent without passing layers to every call.
- **`detachedSpawn`** launches a child step concurrently without blocking the caller. Creates a child `Context` with `parent: parentCtx`, starts execution, and returns a `DetachedHandle` immediately. The handle tracks status (`running` / `completed` / `failed`), exposes the result, and supports `await(timeout?)` for blocking on completion. Pairs with the loop inbox channel (see `05-loop-and-until`) for async sub-agent notification patterns.
- **`checkpoint`/`restore`** enable durable execution. `AgentHarness` implements them as no-ops. `DurableAgentHarness` serializes state (including memory layer state) to its backing store.
- **`cancel`** with propagation. The agent harness knows the execution tree (via parent/child context references) and walks it to cancel children. Cancelled executions still run `onComplete` and `dispose` on their memory layers.
- **`createSpan`** lets the agent harness control the tracing backend.

### What's NOT on the AgentHarness

- **`assembleView`** — view assembly (the Projector) is a standalone function in `memory/projector.ts`. It calls `recallLayers`, allocates token budgets, and assembles system prompt item + layer output items + conversation history items into the View as `Item[]`. This is what `executeLLM` calls internally before sending items to the model.
- **`executeFork`** — fork execution is handled by the core `run` switch. The `fork` variant calls `run` on each path internally.
- **`summarize`** — summarization is just an LLM call. The `spawn` executor calls `run(step.llm({ id: 'summarize', ... }), ...)` internally.

---

## AgentHarness Backends

| Backend                    | When to Use                                                     | Channel Handles |
|----------------------------|-----------------------------------------------------------------|-----------------|
| `AgentHarness<TParams>`     | Testing, simple scripts, CLI tools. Auto-resolves LLM provider from `OPENROUTER_API_KEY` or `llm` config. | In-process handles |
| `DurableAgentHarness`      | Production — backed by Temporal, Inngest, or custom event store | Translates to durable signals |
| `DistributedAgentHarness`  | Multi-node — A2A, worker pools, cloud functions                 | Translates to network messages |

```typescript
import { setHarness, AgentHarness } from '@noetic/core';
import { workingMemory, semanticRecall } from '@noetic/core';

setHarness(new AgentHarness({
  name: 'my-agent',
  params: { model: 'anthropic/claude-sonnet-4-20250514' },
  memory: [workingMemory(), semanticRecall({ embedder })],
}));
```

---

## AgentHarness Registration

`setHarness()` registers the global singleton agent harness for the current process. There is exactly one active agent harness per process at any time.

```typescript
function setHarness(harness: AgentHarness): void;
function getHarness(): AgentHarness; // throws NoeticConfigError if none set
```

### Singleton Semantics

1. Calling `setHarness()` when a harness is already registered is a `NoeticConfigError` with `code: HARNESS_ALREADY_REGISTERED`. The agent harness cannot be replaced or reconfigured after it is set.
2. Calling `run()` without a prior `setHarness()` throws `NoeticConfigError` with `code: NO_HARNESS_SET` and a hint pointing to the setup docs.

### Module Load Order

`setHarness()` MUST be called at the top of the application entry point, before any module that calls `run()` is imported or evaluated. In ESM environments, dynamic imports may evaluate lazily — do not rely on import order to ensure the agent harness is set before execution begins.

Recommended pattern:

```ts
// entry.ts — first file evaluated
import { setHarness, AgentHarness } from '@noetic/core';
setHarness(new AgentHarness({
  name: 'my-agent',
  params: { model: 'anthropic/claude-sonnet-4-20250514' },
}));

// All other imports come after
import { runAgent } from './agent';
await runAgent();
```

### Test Isolation

Bun runs each test file in a fresh module environment. Call `setHarness()` at module scope (top of the test file) — it will execute once per file and will not conflict across files.

```ts
import { setHarness, AgentHarness } from '@noetic/core';

setHarness(new AgentHarness({ name: 'test', params: {} }));

// tests follow...
```

Do not call `setHarness()` inside `beforeEach` — the agent harness is immutable once registered, and calling it a second time within the same module is an error.

### Serverless / Stateless Environments

In serverless functions (AWS Lambda, Cloudflare Workers, etc.), the agent harness is re-instantiated per cold start. Call `setHarness()` at module scope so it runs once per instance, not once per invocation:

```ts
// Runs once per cold start
setHarness(new AgentHarness({
  name: 'lambda-agent',
  params: {},
  llm: { provider: 'openrouter' },
}));

export const handler = async (event) => {
  return run(agentStep, event, harness.createContext());
};
```

In-memory channel storage and non-durable agent harnesses do not persist across invocations. Use `DurableAgentHarness` if cross-invocation state is required.

---

## `AgentConfig`

The top-level configuration for an agent harness. `AgentConfig` is generic over `TParams`, an arbitrary key-value record that steps and tools access via `ctx.harness.config.params`. Domain-specific settings (model, instructions, tools, memory layers) live in `params` rather than as top-level fields, keeping the harness config minimal and the params bag extensible without schema changes.

```typescript
interface AgentConfig<TParams extends Record<string, unknown> = Record<string, unknown>> {
  name: string;

  /** Storage backend for memory persistence. See 11-memory-layer-system. */
  storage?: StorageAdapter;

  /** Agent-level lifecycle hooks (separate from memory hooks). */
  hooks?: AgentHooks;

  /** Default memory layers applied to every context created via createContext() / execute(). */
  memory?: MemoryLayer[];

  /** Arbitrary key-value parameters accessible via ctx.harness.config.params. */
  params: TParams;
}
```
