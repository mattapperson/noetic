# AgentHarness Interface

> **Depends On:** `01-step-type` (Step), `07-context-and-event-log` (Context, Item, LLMResponse), `06-channels` (Channel, ExternalChannel), `11-memory-layer-system` (MemoryLayer, StorageAdapter), `10-observability` (Span)
> **Exports:** `AgentHarness`, `AgentConfig`, `FsAdapter`, `FsStats`, `createLocalFsAdapter`, `ShellAdapter`, `ShellExecOptions`, `ShellExecResult`, `createLocalShellAdapter`, `SubprocessAdapter`, `SubprocessSpec`, `SubprocessHandle`, `SubprocessExitInfo`, `SubprocessCapabilities`, `SubprocessIpcChannel`, `SubprocessServer`, `SubprocessKillSignal`, `createLocalSubprocessAdapter`, `setHarness()`, `setTraceExporter()`

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

`createLocalShellAdapter(opts?)` returns the default implementation that spawns real OS shell processes via `Bun.spawn`. The `@noetic/cli` package also provides `createEmulatedShellAdapter(fs)` backed by `just-bash`, which bridges to the `FsAdapter` so emulated commands see the same files as the framework.

The adapter is threaded through the same path as `FsAdapter`: `AgentHarness.shell` → `Context.shell` → `ToolExecutionContext.shell` → `ExecutionContext.shell`.

### rtk Output Filtering

The local shell adapter can wrap each command through [`rtk rewrite`](https://github.com/rtk-ai/rtk) before exec to filter and summarize output for token efficiency. `rtk` is a Rust CLI proxy that recognizes common dev commands (git, npm, ls, cargo, …) and rewrites their output into compact, model-friendly forms.

Wrapping is per-command and best-effort: each `exec` shells out to `rtk rewrite "<cmd>"`. If `rtk` knows the command (exit 0 with a rewritten string), the rewrite is run via `sh -c`. If `rtk` returns exit 1 or empty output (unknown command, timeout, spawn failure), the raw command runs unchanged.

```typescript
createLocalShellAdapter();                   // default: raw sh -c, no rtk
createLocalShellAdapter({ useRtk: true });   // opt in: wrap via rtk rewrite
```

The returned adapter exposes `rtkAvailable`, `rtkPath`, and `useRtk` for introspection so callers can fail fast on missing rtk instead of silently degrading.

`@noetic/cli` opts in by default via the `shell` namespace in `noetic.config.ts` and fails fast at startup with install instructions when `rtk` is missing:

```typescript
export default {
  shell: { useRtk: true }, // CLI default
};
```

Other embedders of `@noetic-tools/core` keep the raw shell semantics unless they explicitly enable rtk.

---

## Virtual Filesystem Backends

`FsAdapter` and `ShellAdapter` are contracts, not backends. Harnesses may plug in any implementation that satisfies them — including ones that present a *unified* filesystem composed of multiple heterogeneous resources (local disk, RAM, S3, GitHub, Slack, Redis, SSH, …) mounted at POSIX-style paths.

`createMirageAdapters({ workspace })` is the built-in factory for this mode. It is exported by `@noetic/mirage` — a runtime-neutral peer package that types against Mirage's structural `Workspace` contract and declares all three `@struktoai/mirage-*` packages as optional peer dependencies. Core itself ships only in-memory adapters and has no Mirage dependency. Consumers construct a concrete `Workspace` from `@struktoai/mirage-node` (Node) or `@struktoai/mirage-browser` (browser / edge) and pass it to `createMirageAdapters`, which returns a paired `FsAdapter` + `ShellAdapter` over it. Every existing file tool (Read, Write, Edit, Grep, Find, Ls) and the Bash tool just work — bash pipelines can even traverse mount boundaries (`cat /s3/x.csv | grep foo | head > /local/out.txt`) because Mirage's in-process executor resolves each stage against the correct backend. Full semantics, mount layout, error codes, and scope live in `24-mirage-resources`.

---

## Subprocess Abstraction

The `SubprocessAdapter` interface abstracts long-lived child-process lifecycle and inter-process RPC. Tools, memory layers, and CLI features that need to spawn helper processes (agent-ci runs, daemons, sub-agents, RPC services) call through this adapter rather than `node:child_process` or `node:net` directly. This enables the harness to run inside non-POSIX runtimes (Cloudflare Worker isolates, Durable Objects, remote workers) where a "subprocess" maps to a service binding or a separately-deployed worker.

The interface speaks in opaque ids and capability flags rather than POSIX-specific concepts (pid, signals) so non-POSIX backends are first-class.

```typescript
type SubprocessStatus =
  | 'starting'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'stale';

interface SerializedError {
  message: string;
  name?: string;
  stack?: string;
  noeticError?: unknown;     // structured NoeticError payload when present
}

/** Launch an OS-level child process. */
interface ProcessSubprocessRequest {
  kind?: 'process';          // default when omitted — preserves backward compatibility
  command: string;
  args?: ReadonlyArray<string>;
  cwd?: string;
  env?: Record<string, string | undefined>;
  detached?: boolean;
  stdin?: string;
  metadata?: Record<string, unknown>;
}

/** Dispatch a registered Noetic step. */
interface StepSubprocessRequest {
  kind: 'step';
  stepId: string;
  serializedInput: unknown;
  executionId: string;
  overrides: {
    threadId?: string;
    resourceId?: string;
    cwdInit?: string;
  };
  metadata?: Record<string, unknown>;
}

type SubprocessRequest = ProcessSubprocessRequest | StepSubprocessRequest;

interface SubprocessHandleMetadata extends Record<string, unknown> {
  result?: unknown;           // awaited step result on successful completion
  error?: SerializedError;    // serialised error on failure
  executionId?: string;       // echoed from StepSubprocessRequest
}

interface SubprocessHandle {
  id: string;
  status: SubprocessStatus;
  startedAt: string;
  updatedAt?: string;
  metadata?: SubprocessHandleMetadata;
}

type SubprocessControlResult =
  | { kind: 'ok'; handle: SubprocessHandle }
  | { kind: 'unsupported'; handle: SubprocessHandle; message: string }
  | { kind: 'not_found'; handleId: string };

interface SubprocessStopResult {
  kind: 'stopped' | 'not_found';
  handleId: string;
  handle?: SubprocessHandle;
}

interface SubprocessAdapter {
  spawn(request: SubprocessRequest): Promise<SubprocessHandle>;
  get(handleId: string): Promise<SubprocessHandle | null>;
  stop(handleId: string, reason?: string): Promise<SubprocessStopResult>;
  pause(handleId: string): Promise<SubprocessControlResult>;
  resume(handleId: string): Promise<SubprocessControlResult>;
  isAlive(handle: SubprocessHandle): Promise<boolean>;
  /**
   * Rebind to a handle persisted across a host restart. Returns null when no
   * manifest exists for the given id. Durability is an adapter-level
   * concern — the in-memory adapter returns null by default (handles are
   * ephemeral), while adapters configured with a durable StorageAdapter
   * consult their persisted manifest. See 23-durable-execution.
   */
  reattach(handleId: string): Promise<SubprocessHandle | null>;
  /**
   * Enumerate every handle the adapter currently treats as live. Used by host
   * recovery to rediscover running children on startup.
   */
  listLive(): Promise<ReadonlyArray<SubprocessHandle>>;
}
```

`createInMemorySubprocessAdapter(opts?)` is the default test double. It dispatches step requests through the in-process execute pipeline via a closure the interpreter attaches to the request, records the handle in memory, and settles synchronously on the microtask queue. Options:

- `storage?: StorageAdapter` — when supplied, the adapter persists handle manifests through the store so `listLive()` survives adapter re-creation within the process lifetime. `reattach()` is implemented as an idempotent replay of the persisted step request; "reattach" here is honestly a test-double semantic rather than a process resume, consistent with the adapter's role as the default in-process backend.
- `metadataInjector?: (request: SubprocessRequest) => Partial<SubprocessHandleMetadata>` — test ergonomics hook. The returned fields are merged onto `handle.metadata` before the caller sees it, so unit tests can stamp `taskRole`, `taskId`, etc. without mutating the request surface.

`createLocalSubprocessAdapter(opts?)` is the OS-child-process backend. Internals: `node:child_process.spawn` for process lifecycle, POSIX signals for pause/resume, `ps -p <pid> -o lstart=` for `pidStarttime` identity, and unix-domain sockets with length-prefixed JSON framing for typed IPC. Options:

- `storage?: StorageAdapter` — durable handle manifests. When set, every `spawn()` writes `{handleId, pid, pidStarttime, socketPath, cwd, stepId, serializedInput, executionId, metadata}` through the store; `reattach(handleId)` reads the manifest, verifies `pidStarttime` has not drifted (pid reuse), and returns a rehydrated handle; `listLive()` scans the manifest prefix and filters by liveness. Without storage, `listLive()` returns the empty set and `reattach()` returns null (no durability).
- `signaller?: ProcessSignaller` — injection seam for testing signal delivery.

The adapter is threaded through the harness: `AgentHarness.subprocess` → `Context.subprocess` → `ToolExecutionContext.subprocess` → `ExecutionContext.subprocess`.

### Request Dispatch

`adapter.spawn(request)` is the single entry point. `request.kind === 'process'` launches an OS child; `request.kind === 'step'` dispatches a registered Noetic step. The in-memory adapter always runs step requests in-process; the local adapter spawns `bun run <step-bootstrap>` with `NOETIC_REGISTRY_ENTRY` pointing at the user's entry module, passes the serialised input over stdin, and captures the result from stdout. The bootstrap's contract lives at `packages/core/src/adapters/node/step-bootstrap.ts`.

### Handle Metadata Contract

`SubprocessHandle.metadata` is a plain object adapters populate during the handle's lifecycle. Well-known keys:

| Key | Set when | Contract |
|---|---|---|
| `result` | Step request completes successfully | Awaited step return value; consumers unwrap. |
| `error` | Step or process request fails | `SerializedError` payload; `DetachedHandle.await()` rehydrates into `NoeticError` where possible. |
| `executionId` | Step request | Echoed from `StepSubprocessRequest.executionId` so hosts can correlate the handle with `harness.restore(executionId)`. |

Callers may attach arbitrary additional keys via `request.metadata`; the adapter preserves them on the returned handle. The tasks runner uses this to tag planner / implementer handles with `taskRole`, `taskId`, and (for implementer) `featureId` so `findLiveTaskHandle({adapter, taskId, taskRole})` can resolve a live handle without a separate sidecar file.

### Durability Contract (`reattach`, `listLive`)

`reattach(handleId)` and `listLive()` are adapter-level durability hooks. An adapter configured with a durable `StorageAdapter` persists handle manifests on `spawn()` and consults them on reattach/list; a zero-config adapter returns empty results. The host boot flow (`reattachLiveChildren(harness)` in `@noetic/cli`) calls `harness.subprocess.listLive()` first and then `harness.restore(executionId)` per live handle. See `23-durable-execution` for the full model.

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

  /**
   * Subprocess abstraction. Always present (non-optional internally).
   * Defaults to createInMemorySubprocessAdapter() when the harness is
   * constructed without an explicit `subprocess` option. All StepRun
   * and StepSpawn dispatches route through this adapter unless the step
   * or detachedSpawn override supplies one; see 04-spawn for precedence.
   */
  readonly subprocess: SubprocessAdapter;

  /**
   * Typed wrapper over the harness's StorageAdapter used by checkpoint()
   * / restore(). When absent, checkpoint/restore are no-ops and the
   * harness has no durable-execution guarantees. See 23-durable-execution.
   */
  readonly checkpointStore?: CheckpointStore;

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
    overrides?: {
      threadId?: string;
      resourceId?: string;
      cwdInit?: string;
      /**
       * Per-call subprocess adapter override. Takes precedence over both
       * step.subprocess and harness.subprocess. Pass a custom adapter to
       * dispatch this specific spawn through a different runtime (an
       * out-of-process adapter for real isolation, or a test double that
       * records the request).
       */
      subprocess?: SubprocessAdapter;
    },
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

  // Durability
  /**
   * Snapshot the execution state (frontier, layer states, cwd, ask-user queue,
   * item log) through the checkpointStore. Fires automatically at:
   *   1. End of every execute() that mutated the item log.
   *   2. After detachedSpawn() settles (success or failure).
   *   3. After ask-user enqueue.
   *   4. After runAppendPipeline().
   * Keyed by ctx.id (the executionId); idempotent — successive snapshots
   * overwrite. No-op when checkpointStore is absent. A failed save is
   * logged via console.warn and swallowed; a failing checkpoint never
   * aborts an otherwise-successful step. See 23-durable-execution.
   */
  checkpoint(ctx: Context): Promise<void>;

  /**
   * Rebuild a Context from a previously-persisted snapshot. Returns null
   * when no snapshot exists. Surfaces NoeticConfigError with
   * code 'CHECKPOINT_SCHEMA_MISMATCH' when the snapshot's schemaVersion
   * is unrecognised — the caller discards via checkpointStore.clear()
   * and restarts with a fresh execution. The restored Context carries
   * the original executionId so downstream readers observe continuity
   * across a host restart.
   */
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
- **`checkpoint`/`restore`** are the first-class durable-execution surface. `AgentHarness` implements them against an injected `CheckpointStore` (which wraps the harness's `StorageAdapter`). When no store is configured both calls are no-ops, preserving zero-config ergonomics. `DurableAgentHarness` uses the same contract with a distributed backend. The full lifecycle (snapshot boundaries, schema versioning, idempotency expectations, restart flow) is specified in `23-durable-execution`.
- **`cancel`** with propagation. The agent harness knows the execution tree (via parent/child context references) and walks it to cancel children. Cancelled executions still run `onComplete` and `dispose` on their memory layers.
- **`createSpan`** lets the agent harness control the tracing backend.

### Shared cwd

`AgentHarness` holds a long-lived `rootCwdState: CwdState`. Every root context (those created without a `parent`) shares the same `CwdState` reference, so successive `run()` calls observe each other's `cd`s. Spawned and forked children get a snapshot (POSIX-fork semantics) — child mutations do not leak to the parent. Worktree-isolated children are seeded via `createContext({ cwdInit: worktreePath })` or `detachedSpawn(..., { cwdInit })`.

The TUI calls `setRootCwd(nextCwd)` when the user issues a `!cd`, so the next agent turn's tools see the new cwd. The agent's Bash tool intercepts plain `cd` and mutates `cwdState` directly via `setToolCwd` — for the root context, this is the same object as `rootCwdState`, so `cd` round-trips into the TUI's prompt display on the next turn settle.

`AgentHarnessOpts` accepts an optional `initialCwd?: string`; when omitted, `rootCwdState` is seeded with `process.cwd()`.

### Harness-wide tools

`AgentHarnessOpts.tools?: Tool[]` seeds a tool pool that is merged with tools collected from `initialStep` to form every context's `ctx.unifiedTools`. This is the supported way to supply tools when the workflow graph is fully static — i.e. when `step.llm.tools` is a `(ctx) => ctx.unifiedTools.filter(...)` getter rather than an eager array. Function-form `step.tools` are invisible to `collectAllTools`, so anything needed at the harness level must come in through `tools`.

Dedupe is **name-based, first-wins**. The merge order is `[...stepCollectedTools, ...harnessTools]`, so when a tool name appears in both sets, the step-collected instance wins and the harness-level instance is dropped. This matches the precedence a user would expect when a specific step hard-codes a tool while the harness supplies a default pool.

Ordering at resolve time: an eager `step.tools` array still wins for its own call (used as the per-call allowed set); `unifiedTools` (populated from the merge above) is the superset sent to every LLM call.

### What's NOT on the AgentHarness

- **`assembleView`** — view assembly (the Projector) is a standalone function in `memory/projector.ts`. It calls `recallLayers`, allocates token budgets, and assembles system prompt item + layer output items + conversation history items into the View as `Item[]`. This is what `executeLLM` calls internally before sending items to the model.
- **`executeFork`** — fork execution is handled by the core `run` switch. The `fork` variant calls `run` on each path internally.
- **`summarize`** — summarization is just an LLM call. The `spawn` executor calls `run(step.llm({ id: 'summarize', ... }), ...)` internally.

---

## Durable Execution

The harness exposes four surfaces that together enable crash-recovery: `subprocess.listLive()` / `subprocess.reattach()` (rediscover running children), `checkpoint()` / `restore()` (save and replay parent execution state), and the `StorageAdapter` + `CheckpointStore` wiring that persists them.

### Checkpoint Lifecycle

Snapshots fire automatically at four boundaries:

1. **Post-`execute()`** — after each step completes and any item-log mutations have landed.
2. **Post-`detachedSpawn()`** — when a child is sent and the adapter's handle is returned.
3. **Ask-user enqueue** — when a pending prompt is persisted waiting for user input.
4. **Post-`runAppendPipeline`** — layer state can mutate as items are appended; the snapshot follows.

Any caller may also invoke `harness.checkpoint(ctx)` explicitly. Snapshots are keyed by `ctx.id` (the execution id) under `execution:<id>:snapshot` within the store's key namespace, and are idempotent — successive snapshots for the same execution overwrite prior data.

Snapshot content (Zod-validated by `CheckpointSnapshotSchema`):

- `schemaVersion` — literal `1` today; bumped on backward-incompatible change.
- `executionId`, `threadId`, `resourceId` — identity.
- `frontier` — stack of `FrontierFrame { stepId, input, state? }` entries (the execution frontier).
- `layers` — `Record<layerId, state>` captured via `layerStateStore.get(executionId, layerId)`.
- `cwd` — `{ current, previous }`.
- `askUser` — pending ask-user requests (populated when the code-agent's `AskUserService` integrates with the store).
- `itemLog` — `{ items: Item[] }`, the full item log.
- `capturedAt` — ISO-8601 timestamp.

### Restore Contract

`harness.restore(executionId)` reads the snapshot and rebuilds a `Context`:

1. Replays layer state into `layerStateStore` under the same executionId so memory projectors observe continuity.
2. Re-parses `itemLog.items` via the harness's `ItemSchemaRegistry` (the same gate production traffic passes through).
3. Seeds a new context with `threadId`, `resourceId`, and `cwdInit` from the snapshot.
4. Returns a `Context` whose `.id` is overridden to the original `executionId` so downstream readers correlate across the restart.

Returns `null` when no snapshot is recorded. Throws `NoeticConfigError` with `code: 'CHECKPOINT_SCHEMA_MISMATCH'` when the persisted schemaVersion is not the one the running runtime understands — callers discard via `checkpointStore.clear(executionId)` and restart the execution.

### Durability Guarantees

- **With a durable `StorageAdapter` + `CheckpointStore`** (e.g. `createFileStorage({root})` + `createCheckpointStore({storage})`): full snapshot/restore across host restarts.
- **Without** (the default zero-config harness): `checkpoint()` is a no-op, `restore()` returns null, `listLive()` returns the empty set, `reattach()` returns null. All existing in-memory semantics are preserved bit-identically.
- **Schema versioning**: `CheckpointSnapshot.schemaVersion` is validated on load. Incompatible versions surface a typed error rather than a silently-corrupt restored context.
- **Checkpoint failures never abort a step.** A failing `store.save` is logged via `console.warn` and swallowed; the step's return value is unaffected.

### Limitations

- **LLM mid-stream** is re-issued on restart, not resumed. The item log's response-id dedupe guards against double-recording an identical response. See `07-context-and-event-log`.
- **Non-idempotent `step.run` bodies** may run twice if a crash lands between execution and the following checkpoint. Write bodies that are safe to re-execute, or gate with an external idempotency key.

See `23-durable-execution` for the full durable-execution model, including `SubprocessAdapter.reattach`/`listLive` semantics, the durable IPC outbound queue, protocol v2 frames, and the host-restart recovery flow.

## AgentHarness Backends

| Backend                    | When to Use                                                     | Durability | Channel Handles |
|----------------------------|-----------------------------------------------------------------|------------|-----------------|
| `AgentHarness<TParams>`     | Testing, simple scripts, CLI tools. Auto-resolves LLM provider from `OPENROUTER_API_KEY` or `llm` config. | Ephemeral by default; full durable execution when constructed with a durable `StorageAdapter` + `CheckpointStore`. | In-process handles |
| `DurableAgentHarness`      | Production — backed by Temporal, Inngest, or custom event store | Full durable execution via backing store | Translates to durable signals |
| `DistributedAgentHarness`  | Multi-node — A2A, worker pools, cloud functions                 | Delegates to the distributed backend | Translates to network messages |

```typescript
import { setHarness, AgentHarness } from '@noetic-tools/core';
import { workingMemory, semanticRecall } from '@noetic-tools/core';

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
import { setHarness, AgentHarness } from '@noetic-tools/core';
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
import { setHarness, AgentHarness } from '@noetic-tools/core';

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

  /** Subprocess adapter. Defaults to createLocalSubprocessAdapter(). */
  subprocess?: SubprocessAdapter;

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

---

## Per-Task IPC for Live Chat

A runner subprocess (planner, implementer, validator) exposes its harness over a unix-domain socket so external clients — primarily the TUI — can chat with the agent live, on the same `execute()` channel the in-process chat uses.

### Socket placement

```
<projectRoot>/.noetic/tasks/<taskId>/sockets/<role>-<runnerId>.sock
```

`role` is `planner` | `implementer` | `validator`. `runnerId` distinguishes concurrent runners of the same role (the implementer is per-feature, so `runnerId` is the feature id; for singletons it's the role itself). The runner records the bound path in its sidecar JSON (`_planner.json` / `_implementer.json`) under `socketPath` so clients discover the socket without scanning.

### Wire format

Newline-delimited JSON. One frame per line. Both ends validate the frame envelope with Zod; the inner `item` / `event` payloads pass through as `unknown` because the `Item` / `StreamEvent` unions are open-ended tagged unions whose extension shapes the protocol layer doesn't own.

Client → server frames: `subscribe`, `getHistory`, `send { messageId, text }`, `getStatus`, `abort`.

Server → client frames: `hello { protocolVersion, taskId, role, runnerId, threadId }`, `history { items }`, `item { item }`, `event { event }`, `status { status }`, `ack { messageId }`, `error { error }`, `bye`.

### Bridging

On `send`, the server calls `harness.execute(text, { threadId, messageId })` — exactly the same call shape the in-process chat uses. On every `harness.getItemStream()` emission whose `isComplete` flag is `true`, the server appends the underlying `Item` (with the framework-only `isComplete` field stripped) to `<taskDir>/chat.jsonl` and fans out the streaming snapshot to subscribed clients. Streaming partials are fanned out only — they're not persisted, since `seedSessionHistory` replays final items and resuming a partial isn't meaningful. Framework events from `harness.getFullStream()` fan out to subscribed clients but are never persisted. Persistence happens before fan-out so a crash between the two doesn't lose state the client never received.

### Resume

On runner startup, the IPC server reads `<taskDir>/chat.jsonl` and calls `harness.seedSessionHistory(threadId, items)` before any `execute()` is issued. Conversations therefore survive subprocess restarts: the next runner spawn replays prior items into the fresh session and the user's chat continues from where it left off.
