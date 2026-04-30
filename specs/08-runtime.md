# AgentHarness Interface

> **Depends On:** `01-step-type` (Step), `07-context-and-event-log` (Context, Item, LLMResponse), `06-channels` (Channel, ExternalChannel), `11-memory-layer-system` (MemoryLayer, StorageAdapter), `10-observability` (Span)
> **Exports:** `AgentHarness`, `AgentConfig`, `FsAdapter`, `FsStats`, `createLocalFsAdapter`, `ShellAdapter`, `ShellExecOptions`, `ShellExecResult`, `createLocalShellAdapter`, `setHarness()`, `setTraceExporter()`

---

## Filesystem Abstraction

The `FsAdapter` interface abstracts all filesystem operations used by the agent harness, tools, memory layers, and skill discovery. This enables sandboxed, virtualized, or remote filesystem backends without changing agent code.

```typescript
interface FsStats {
  size: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isFile(): boolean;
}

interface FsAdapter {
  readFile(path: string): Promise<Buffer>;
  readFileText(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  appendFile(path: string, content: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  access(path: string, mode?: number): Promise<void>;
  stat(path: string): Promise<FsStats>;
  lstat(path: string): Promise<FsStats>;
  readdir(path: string): Promise<string[]>;
}
```

`createLocalFsAdapter()` returns the default implementation backed by Node.js `fs/promises`. The agent harness uses this when no custom adapter is provided.

`appendFile` is required to support append-only audit/event logs without read-then-write race windows. On POSIX, the local adapter opens the file with `O_APPEND`, which guarantees atomic placement at end-of-file for sub-`PIPE_BUF` writes (4 KiB on Linux/macOS) — concurrent writers see no interleaving as long as each call's payload stays under that ceiling.

`rename` enables the write-temp-then-rename pattern for publishing new versions of mutable JSON files atomically, so readers never observe a half-written state. `rm` supports recursive directory removal (e.g., hard-deleting a task directory).

---

## Shell Abstraction

The `ShellAdapter` interface abstracts all shell command execution used by the agent harness, tools, memory layers, and skill processing. This enables sandboxed or emulated shell backends (e.g., `just-bash`) without changing agent code.

```typescript
interface ShellExecOptions {
  cwd: string;
  env?: Record<string, string>;
  timeout?: number;
  stdin?: string;
  signal?: AbortSignal;
  onData?: (data: Buffer) => void;
}

interface ShellExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface ShellAdapter {
  exec(command: string, options: ShellExecOptions): Promise<ShellExecResult>;
}
```

`createLocalShellAdapter()` returns the default implementation that spawns real OS shell processes via `Bun.spawn`. The `@noetic/cli` package also provides `createEmulatedShellAdapter(fs)` backed by `just-bash`, which bridges to the `FsAdapter` so emulated commands see the same files as the framework.

The adapter is threaded through the same path as `FsAdapter`: `AgentHarness.shell` → `Context.shell` → `ToolExecutionContext.shell` → `ExecutionContext.shell`.

---

## The `AgentHarness` Interface

The agent harness is the engine. It's behind an interface with methods covering execution, session-scoped stream accessors, context management, channels, durability, memory layer lifecycle, cancellation, and tracing.

```typescript
interface AgentHarness<TParams extends Record<string, unknown> = Record<string, unknown>> {
  // Agent configuration
  readonly config: AgentConfig<TParams>;

  // Filesystem abstraction
  readonly fs: FsAdapter;

  // Shell abstraction
  readonly shell: ShellAdapter;

  // Primary execution — enqueues input on the session identified by
  // options.threadId and returns once the message is accepted. The session
  // runner processes queued messages and emits events on the session
  // broadcaster.
  execute(input: ExecuteInput, options?: ExecuteOptions): Promise<void>;

  // Session-scoped accessors. Each session is keyed by threadId (defaulting
  // to a single built-in thread). Accessors may be subscribed BEFORE execute()
  // is called; they stay alive across turns.
  getAgentResponse(scope?: SessionScope): Promise<HarnessResponse>;
  getItemStream(scope?: SessionScope): AsyncIterable<StreamingItem>;
  getTextStream(scope?: SessionScope): AsyncIterable<string>;
  getReasoningStream(scope?: SessionScope): AsyncIterable<string>;
  getFullStream(scope?: SessionScope): AsyncIterable<StreamEvent>;

  // Cancel the in-flight turn. Queued messages are preserved.
  abort(scope?: SessionScope & { reason?: string }): Promise<void>;

  // Session observability.
  getStatus(scope?: SessionScope): HarnessStatus;
  getQueueSize(scope?: SessionScope): number;

  // Core execution
  run<I, O>(step: Step<I, O>, input: I, ctx: Context): Promise<O>;

  // Detached (concurrent) execution
  detachedSpawn<I, O>(
    step: Step<I, O>,
    input: I,
    parentCtx: Context,
    overrides?: { threadId?: string; resourceId?: string; cwdInit?: string },
  ): DetachedHandle<O>;

  // Context management
  createContext(opts?: {
    parent?: Context;
    items?: Item[];
    state?: unknown;
    threadId?: string;
    resourceId?: string;
    memory?: MemoryLayer[];
    cwdInit?: string;             // override cwdState.cwd for this context
  }): Context;

  // Shared cwd state seeded into root contexts created by this harness
  readonly rootCwdState: CwdState;
  setRootCwd(nextCwd: string): void;  // host (e.g. TUI) reports a `! cd`

  // Channel operations (the agent harness owns the backing store)
  send<T>(channel: Channel<T>, value: T, ctx: Context): void;
  recv<T>(channel: Channel<T>, ctx: Context, opts?: { timeout?: number }): Promise<T>;
  tryRecv<T>(channel: Channel<T>, ctx: Context): T | null;

  // External channel handles
  getChannelHandle<T>(channel: ExternalChannel<T>, executionId: string): ChannelHandle<T>;

  // Memory layer lifecycle (see 11-memory-layer-system for hook semantics)
  initLayers(layers: MemoryLayer[], ctx: Context, storage: StorageAdapter): Promise<void>;
  recallLayers(layers: MemoryLayer[], input: string, ctx: Context): Promise<RecallLayerOutput[]>;
  previewRequestItems(scope?: SessionScope): Promise<ReadonlyArray<Item>>;
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

## Sessions and the Message Queue

`execute()` enqueues a message on a **session** keyed by `options.threadId` (or a default thread when omitted). Each session owns:

- a FIFO `MessageQueue`,
- a long-lived `EventBroadcaster` that relays SDK and framework events across all turns,
- an `itemLog` snapshot that carries conversation history from turn to turn.

Before the first turn runs, the harness walks the step tree to collect all tools from LLM steps, merges them with layer-provided tools, and deduplicates by name. This **unified tool set** is stored on the turn's execution context and sent with every LLM call for prompt cache efficiency. Individual steps restrict the model to a subset via the Open Responses `tool_choice: { type: "allowed_tools" }` parameter.

A session's runner starts turns lazily whenever the queue goes non-empty while the runner is idle. Each turn:

1. Drains the queue (combining all queued messages into one turn's input).
2. Emits `{name}:turn_started` with the drained message IDs.
3. Invokes the initial step (which ultimately calls `callModel`).
4. Emits `{name}:turn_completed` (or `{name}:turn_aborted` on failure/cancellation).
5. Returns to idle. If the queue became non-empty during the turn, the next turn begins immediately.

### Response Shape

```typescript
interface HarnessResponse {
  readonly items: ReadonlyArray<Item>;
  readonly usage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  readonly cost?: number;
  readonly text: string;
  readonly lastLayerUsage?: LastLayerUsage;
}

type StreamingItem = Item & { readonly isComplete: boolean };
```

### Stream Accessors

| Method | Returns | Description |
|--------|---------|-------------|
| `getAgentResponse(scope?)` | `Promise<HarnessResponse>` | Resolves once the session drains its queue and returns to idle. |
| `getTextStream(scope?)` | `AsyncIterable<string>` | Text deltas from the model, across all turns in the session. |
| `getReasoningStream(scope?)` | `AsyncIterable<string>` | Reasoning token deltas (reasoning models). |
| `getItemStream(scope?)` | `AsyncIterable<StreamingItem>` | Cumulative item snapshots. Replace, do not append. |
| `getFullStream(scope?)` | `AsyncIterable<StreamEvent>` | All raw events (SDK + framework) for the session. |

Stream accessors MAY be subscribed before any `execute()` call; the underlying `EventBroadcaster` replays buffered events so late subscribers observe turn history within the buffer window.

### Delivery Modes

Each queued message carries a `DeliveryMode`:

| Mode | Behaviour |
|------|-----------|
| `next-turn` (default) | Message runs as a new turn once the current turn completes. Safe and predictable. |
| `between-rounds` | Message is injected as an additional user item before the next tool-round LLM call within the currently generating turn. If no turn is active, behaves like `next-turn`. Mirrors Claude Code's inbox-attachment pattern. |
| `interrupt` | Cancels the in-flight turn (if any), places the message at the head of the queue, and restarts. |

`AgentConfig.defaultDeliveryMode` (default `next-turn`) applies to messages that don't specify a mode. Callers may override per-call via `ExecuteOptions.deliveryMode`.

### Stream Idle Timeout

The harness runs a per-round watchdog over each provider call's SSE stream. If no stream event arrives for `streamIdleTimeoutMs` (default `120000`, set via `AgentHarnessOpts.streamIdleTimeoutMs`; pass `0` to disable), the round is aborted, `{name}:llm_call_stalled` is emitted, and the surrounding turn fails with `turn_aborted { reason: "llm stream idle timeout after <N>ms" }`. This prevents silent hangs when a provider drops the connection without sending a terminal event.

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
| `{name}:turn_started` | Emitted when the session runner starts a turn. Data: `{ turnId, messageIds }` |
| `{name}:turn_completed` | Emitted when a turn completes. Data: `{ turnId, durationMs }` |
| `{name}:turn_aborted` | Emitted when a turn is aborted or errors. Data: `{ turnId, reason }` |
| `{name}:inbox_injected` | Emitted between tool rounds when queued `between-rounds` messages are injected into the prompt. Data: `{ round, count, messageIds }` |
| `{name}:step_started` | Emitted before each step executes. Data: `{ stepId, kind }` |
| `{name}:step_completed` | Emitted after each step completes. Data: `{ stepId, kind }` |
| `{name}:tool_round_started` | Emitted before a tool execution round. Data: `{ round, toolCount }` |
| `{name}:tool_call_started` | Emitted before each tool call. Data: `{ name, callId }` |
| `{name}:tool_call_completed` | Emitted after each tool call. Data: `{ name, callId, error }` |
| `{name}:tool_round_completed` | Emitted after all tool calls in a round. Data: `{ round, toolCount }` |
| `{name}:llm_call_started` | Emitted before each provider call in the tool-round loop. Data: `{ round, messageCount, toolCount }` |
| `{name}:llm_call_first_event` | Emitted when the first SDK event for the call arrives. Useful for measuring time-to-first-token. Only emitted when a broadcaster is attached to the context. Data: `{ round }` |
| `{name}:llm_call_completed` | Emitted after the provider's response is fully received. Data: `{ round, itemCount }` |
| `{name}:llm_call_stalled` | Emitted when the stream-idle watchdog fires (see `streamIdleTimeoutMs`). The turn then aborts. Data: `{ round, idleTimeoutMs }` |
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

When `execute()` is called on a harness without an `initialStep`, it rejects with `NoeticConfigError` code `NO_STEP_CONFIGURED`. When a turn fails mid-stream, `getAgentResponse()` surfaces the error and the session remains usable for subsequent turns.

### ExecuteOptions

```typescript
interface ExecuteOptions {
  threadId?: string;
  resourceId?: string;
  state?: unknown;
  memory?: MemoryLayer[];
  /** Per-call override of the harness default. */
  deliveryMode?: DeliveryMode;
}

interface SessionScope {
  threadId?: string;
}

type HarnessStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'generating'; readonly startedAt: number; readonly turnId: string }
  | { readonly kind: 'aborting'; readonly turnId: string };

type DeliveryMode = 'next-turn' | 'between-rounds' | 'interrupt';
```

---

## Key Design Points

- **`send`/`recv`/`tryRecv` on the agent harness** means the agent harness controls channel storage. `AgentHarness` uses a `Map`. `DurableAgentHarness` uses a message broker. The `Context` methods are thin wrappers: `ctx.send(ch, v)` calls `harness.send(ch, v, ctx)`. `ctx.tryRecv(ch)` calls `harness.tryRecv(ch, ctx)`.
- **`getChannelHandle`** returns a `ChannelHandle<T>` for external code to write into a running execution. The handle is typed, lifecycle-aware, and scoped to the root execution. External handles route to the correct execution via `executionId`. `AgentHarness` uses in-process handles; `DurableAgentHarness` translates to durable signals (e.g., Temporal signals, Inngest events).
- **Memory layer methods** manage the full lifecycle defined in `11-memory-layer-system`. `initLayers` runs `init()` sequentially. `recallLayers` runs `recall()` in slot order and returns `Item[]`. `storeLayers` runs `store()` concurrently via `Promise.allSettled` and receives `LLMResponse` (with items + usage). `disposeLayers` runs `dispose()` in reverse order. Error handling follows the per-hook policy.
- **`previewRequestItems(scope?)`** returns the `Item[]` that would be sent to the model on the next turn for `scope.threadId` (or the default thread): the session's accumulated history with harness-level memory-layer recall outputs prepended via `assembleView`. Read-mostly: `recallLayers` writes layer-state snapshots to `layerStateStore` exactly as a real turn would, so successive previews remain consistent with what the next real turn produces. Does not allocate a session for unknown thread ids — returns an empty history in that case.
- **`beforeToolCall(layers, toolName, toolArgs, ctx)`** runs each layer's `beforeToolCall` hook sequentially in slot order before a tool is executed. Returns a `SteeringDecision` — `Allow` proceeds normally, `Deny` short-circuits and blocks the tool call, `Guide` returns guidance text to the model. Short-circuits on the first `Deny`. When multiple layers return `Guide`, their guidance is concatenated.
- **`afterModelCall(layers, response, ctx)`** runs each layer's `afterModelCall` hook sequentially in slot order immediately after the LLM responds. Returns a `SteeringDecision` — `Allow` proceeds normally, `Deny` throws `steering_denied`, `Guide` injects guidance as a developer message and retries the model call (up to 3 times). Short-circuits on the first `Deny`.
- **`fs`** exposes the `FsAdapter` that the harness was constructed with (or the default `createLocalFsAdapter()`). All filesystem operations — CLI tools (read, write, edit, ls, grep, find), skill discovery, and memory layers — use `ctx.harness.fs` rather than importing `fs/promises` directly. This enables sandboxed or virtualized filesystems (e.g., in-memory FS for testing, remote FS for cloud execution). `Context` exposes a `readonly fs: FsAdapter` getter that delegates to the harness. `ToolExecutionContext` and memory `ExecutionContext` also expose `readonly fs: FsAdapter`.
- **`config`** exposes the `AgentConfig<TParams>` that the harness was constructed with. Steps and tools access harness params via `ctx.harness.config.params`.
- **`memory` on AgentConfig** are default memory layers applied to every context created via `createContext()`. When `createContext` is called with its own `memory` option, the per-call layers take precedence (full override, not merge). When neither is specified, the context has no default layers. This provides a convenient way to set up memory for the entire agent without passing layers to every call.
- **`detachedSpawn`** launches a child step concurrently without blocking the caller. Creates a child `Context` with `parent: parentCtx`, starts execution, and returns a `DetachedHandle` immediately. The handle tracks status (`running` / `completed` / `failed`), exposes the result, and supports `await(timeout?)` for blocking on completion. Pairs with the loop inbox channel (see `05-loop-and-until`) for async sub-agent notification patterns. Optional `overrides.threadId` / `overrides.resourceId` decouple the child's session-scoped item log from the parent's — useful for background sub-agents whose accumulated items should NOT replay in the parent's next turn.
- **`checkpoint`/`restore`** enable durable execution. `AgentHarness` implements them as no-ops. `DurableAgentHarness` serializes state (including memory layer state) to its backing store.
- **`cancel`** with propagation. The agent harness knows the execution tree (via parent/child context references) and walks it to cancel children. Cancelled executions still run `onComplete` and `dispose` on their memory layers.
- **`createSpan`** lets the agent harness control the tracing backend.

### Shared cwd

`AgentHarness` holds a long-lived `rootCwdState: CwdState`. Every root context (those created without a `parent`) shares the same `CwdState` reference, so successive `run()` calls observe each other's `cd`s. Spawned and forked children get a snapshot (POSIX-fork semantics) — child mutations do not leak to the parent. Worktree-isolated children are seeded via `createContext({ cwdInit: worktreePath })` or `detachedSpawn(..., { cwdInit })`.

The TUI calls `setRootCwd(nextCwd)` when the user issues a `!cd`, so the next agent turn's tools see the new cwd. The agent's Bash tool intercepts plain `cd` and mutates `cwdState` directly via `setToolCwd` — for the root context, this is the same object as `rootCwdState`, so `cd` round-trips into the TUI's prompt display on the next turn settle.

`AgentHarnessOpts` accepts an optional `initialCwd?: string`; when omitted, `rootCwdState` is seeded with `process.cwd()`.

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

  /** Filesystem adapter. Defaults to createLocalFsAdapter(). */
  fs?: FsAdapter;

  /** Shell adapter. Defaults to createLocalShellAdapter(). */
  shell?: ShellAdapter;

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
