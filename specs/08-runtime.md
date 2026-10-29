# AgentHarness Interface

> **Depends On:** `01-step-type` (Step), `07-context-and-event-log` (Context, Item, LLMResponse), `06-channels` (Channel, ExternalChannel), `11-context-layer-system` (ContextLayer, StorageAdapter), `10-observability` (Span)
> **Exports:** `AgentHarness`, `AgentConfig`, `FsAdapter`, `FsStats`, `createLocalFsAdapter`, `ShellAdapter`, `ShellExecOptions`, `ShellExecResult`, `createLocalShellAdapter`, `SubprocessAdapter`, `SubprocessSpec`, `SubprocessHandle`, `SubprocessExitInfo`, `SubprocessCapabilities`, `SubprocessIpcChannel`, `SubprocessServer`, `SubprocessKillSignal`, `createLocalSubprocessAdapter`

---

## Filesystem Abstraction

The `FsAdapter` interface abstracts all filesystem operations used by the agent harness, tools, context layers, and skill discovery. This enables sandboxed, virtualized, or remote filesystem backends without changing agent code.

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

`createInMemoryFsAdapter(seed?)` is the harness default — a process-local, POSIX-like in-memory tree, optionally seeded with initial file contents. Hosts that need real disk access pass an adapter explicitly: `@noetic-tools/platform-node` provides `createLocalFsAdapter()`, backed by Node.js `fs/promises`.

`appendFile` is required to support append-only audit/event logs without read-then-write race windows. On POSIX, the local adapter opens the file with `O_APPEND`, which guarantees atomic placement at end-of-file for sub-`PIPE_BUF` writes (4 KiB on Linux/macOS) — concurrent writers see no interleaving as long as each call's payload stays under that ceiling.

`rename` enables the write-temp-then-rename pattern for publishing new versions of mutable JSON files atomically, so readers never observe a half-written state. `rm` supports recursive directory removal (e.g., hard-deleting a task directory).

---

## Shell Abstraction

The `ShellAdapter` interface abstracts all shell command execution used by the agent harness, tools, context layers, and skill processing. This enables sandboxed or emulated shell backends (e.g., `just-bash`) without changing agent code.

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

`createInMemoryShellAdapter()` is the harness default. It executes nothing — every `exec` returns exit code `127` with an explanatory stderr — so a portable harness surfaces a missing shell instead of silently depending on a host process. Hosts that need real execution pass an adapter explicitly: `@noetic-tools/platform-node` provides `createLocalShellAdapter(opts?)`, which spawns OS shell processes via `Bun.spawn`. Any other backend — a Worker or container bridge, or an emulated shell wired to the same `FsAdapter` so emulated commands see the same files as the framework — is a host-supplied implementation of this one-method contract; core ships no emulated adapter.

The adapter is threaded through the same path as `FsAdapter`: `AgentHarness.shell` → `Context.shell` → `ToolExecutionContext.shell` → `ExecutionContext.shell`.

### rtk Output Filtering

The local shell adapter can wrap each command through [`rtk rewrite`](https://github.com/rtk-ai/rtk) before exec to filter and summarize output for token efficiency. `rtk` is a Rust CLI proxy that recognizes common dev commands (git, npm, ls, cargo, …) and rewrites their output into compact, model-friendly forms.

Wrapping is per-command and best-effort: each `exec` shells out to `rtk rewrite "<cmd>"`. If `rtk` knows the command (exit 0 with a rewritten string), the rewrite is run via `sh -c`. If `rtk` returns exit 1 or empty output (unknown command, timeout, spawn failure), the raw command runs unchanged.

```typescript
createLocalShellAdapter();                   // default: raw sh -c, no rtk
createLocalShellAdapter({ useRtk: true });   // opt in: wrap via rtk rewrite
```

The returned adapter exposes `rtkAvailable`, `rtkPath`, and `useRtk` for introspection so callers can fail fast on missing rtk instead of silently degrading.

`@noetic-tools/cli` opts in by default via the `shell` namespace in `noetic.config.ts` and fails fast at startup with install instructions when `rtk` is missing:

```typescript
export default {
  shell: { useRtk: true }, // CLI default
};
```

Other embedders of `@noetic-tools/core` keep the raw shell semantics unless they explicitly enable rtk.

---

## Virtual Filesystem Backends

`FsAdapter` and `ShellAdapter` are contracts, not backends. Harnesses may plug in any implementation that satisfies them — including ones that present a *unified* filesystem composed of multiple heterogeneous resources (local disk, RAM, S3, GitHub, Slack, Redis, SSH, …) mounted at POSIX-style paths. Core itself ships only in-memory adapters; concrete backends live in the platform packages (`25-platform-packages`) or in consumer-supplied adapter implementations.

---

## Subprocess Abstraction

The `SubprocessAdapter` interface abstracts long-lived child-process lifecycle and inter-process RPC. Tools, context layers, and CLI features that need to spawn helper processes (agent-ci runs, daemons, sub-agents, RPC services) call through this adapter rather than `node:child_process` or `node:net` directly. This enables the harness to run inside non-POSIX runtimes (Cloudflare Worker isolates, Durable Objects, remote workers) where a "subprocess" maps to a service binding or a separately-deployed worker.

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

/** `settled` resolves with the handle in its final status the moment the child finishes. */
interface SpawnedSubprocess {
  handle: SubprocessHandle;
  settled: Promise<SubprocessHandle>;
}

/**
 * An adapter holds a handle only while its child runs. When the child
 * finishes, the adapter resolves `settled` and forgets the handle: `get`,
 * `stop`, `pause`, and `resume` then treat the id as unknown.
 */
interface SubprocessAdapter {
  spawn(request: SubprocessRequest): Promise<SpawnedSubprocess>;
  /** A running handle, or null once it has finished or when unknown. */
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

`adapter.spawn(request)` is the single entry point. `request.kind === 'process'` launches an OS child; `request.kind === 'step'` dispatches a registered Noetic step.

A process request that carries `stdin` is a **run-to-result** call, the shape a JSON workflow `runCode` node sends (`26-json-workflow-runtime`). The local adapter pipes the child's stdio, writes `stdin` and closes it, and settles on `close` (after stdout has drained, so output larger than a pipe buffer arrives whole). Exit code 0 completes the handle with stdout as `metadata.result`. Any other code fails it, with the end of stderr (up to 2,000 characters) in `metadata.error.message`. A child that exits without reading its input is not an error. A process request without `stdin` runs with its stdio ignored and settles on `exit`, for long-lived children whose output nobody collects. The pipes belong to the adapter's process, so a run-to-result child does not outlive its host: reattaching to one after a restart finds it gone. The in-memory adapter always runs step requests in-process; the local adapter spawns `bun run <step-bootstrap>` with `NOETIC_REGISTRY_ENTRY` pointing at the user's entry module, passes the serialised input over stdin, and captures the result from stdout. The bootstrap's contract lives at `packages/core/src/adapters/node/step-bootstrap.ts`.

### Handle Metadata Contract

`SubprocessHandle.metadata` is a plain object adapters populate during the handle's lifecycle. Well-known keys:

| Key | Set when | Contract |
|---|---|---|
| `result` | Step request completes successfully | Awaited step return value; consumers unwrap. |
| `error` | Step or process request fails | `SerializedError` payload; `DetachedHandle.await()` rehydrates into `NoeticError` where possible. |
| `executionId` | Step request | Echoed from `StepSubprocessRequest.executionId` so hosts can correlate the handle with `harness.restore(executionId)`. |

Callers may attach arbitrary additional keys via `request.metadata`; the adapter preserves them on the returned handle. The tasks runner uses this to tag planner / implementer handles with `taskRole`, `taskId`, and (for implementer) `featureId` so `findLiveTaskHandle({adapter, taskId, taskRole})` can resolve a live handle without a separate sidecar file.

### Durability Contract (`reattach`, `listLive`)

`reattach(handleId)` and `listLive()` are adapter-level durability hooks. An adapter configured with a durable `StorageAdapter` persists handle manifests on `spawn()` and consults them on reattach/list; a zero-config adapter returns empty results. The host boot flow (`reattachLiveChildren(harness)` in `@noetic-tools/cli`) calls `harness.subprocess.listLive()` first and then `harness.restore(executionId)` per live handle. See `23-durable-execution` for the full model.

---

## The `AgentHarness` Interface

The agent harness is the engine. It's behind an interface with methods covering execution, session-scoped stream accessors, context management, channels, durability, context layer lifecycle, cancellation, and tracing.

```typescript
// TItem: the custom items `agentGraph` declares (its `'~customItems'` brand, spec 34);
// `never` when it declares none, which leaves every result type as it is without them.
interface AgentHarness<TParams extends Record<string, unknown> = Record<string, unknown>, TItem extends CustomItem = never> {
  // Agent configuration
  readonly config: AgentConfig<TParams>;

  // Filesystem abstraction
  readonly fs: FsAdapter;

  // Shell abstraction
  readonly shell: ShellAdapter;

  /**
   * Subprocess abstraction. Always present (non-optional internally).
   * Defaults to createInMemorySubprocessAdapter() when the harness is
   * constructed without an explicit `subprocess` option. All StepRunCode
   * and StepSpawn dispatches route through this adapter unless the step
   * or detachedSpawn override supplies one; see 04-spawn for precedence.
   */
  readonly subprocess: SubprocessAdapter;

  /**
   * Typed wrapper over the harness's StorageAdapter used by checkpoint()
   * / restore(). Defaults to a store over `environment.storage.adapter`
   * when one is given. When absent, checkpoint/restore are no-ops and the
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

  // Cancel the in-flight turn. Queued messages are preserved. With `drainMs`
  // the turn drains first and resolves with the drain's report (see Graceful Stop).
  abort(scope?: SessionScope & CancelOptions): Promise<DrainReport | undefined>;

  // Observability: a `run()` execution by its root context's id, or a session.
  getStatus(scope: ExecutionScope): ExecutionStatus;
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
    rollUpUsage?: boolean;        // charge usage to `parent` as it is spent (default true; see 07 Usage Accounting)
    items?: Item[];
    state?: unknown;
    threadId?: string;
    resourceId?: string;
    context?: ContextLayer[];
    cwdInit?: string;             // override cwdState.cwd for this context
  }): Context;

  // Shared cwd state seeded into root contexts created by this harness
  readonly rootCwdState: CwdState;
  setRootCwd(nextCwd: string): void;  // host (e.g. TUI) reports a `! cd`

  // Channel operations (the agent harness owns the backing store)
  send<T>(channel: Channel<T>, value: NoInfer<T>, ctx: Context): Promise<void>;
  recv<T>(channel: Channel<T>, ctx: Context, opts?: { timeout?: number }): Promise<T>;
  tryRecv<T>(channel: Channel<T>, ctx: Context): T | null;

  // External channel handles
  getChannelHandle<T>(channel: ExternalChannel<T>, executionId: string): ChannelHandle<T>;
  getChannelStream<T>(channel: ExternalChannel<T>, executionId: string): AsyncIterable<T>;

  // Context layer lifecycle (see 11-context-layer-system for hook semantics)
  initLayers(layers: ContextLayer[], ctx: Context, storage: StorageAdapter): Promise<void>;
  recallLayers(layers: ContextLayer[], input: string, ctx: Context): Promise<RecallLayerOutput[]>;
  previewRequestItems(scope?: SessionScope): Promise<ReadonlyArray<Item>>;
  storeLayers(layers: ContextLayer[], response: LLMResponse, ctx: Context): Promise<void>;
  beforeToolCall(layers: ContextLayer[], toolName: string, toolArgs: unknown, ctx: Context): Promise<SteeringDecision>;
  afterModelCall(layers: ContextLayer[], response: LLMResponse, ctx: Context): Promise<SteeringDecision>;
  disposeLayers(layers: ContextLayer[], ctx: Context): Promise<void>;

  // Durability
  /**
   * Snapshot the execution state (frontier, layer states, cwd, channels,
   * state, usage, and the run's item-log baseline) through the
   * checkpointStore. Fires automatically at run start, after every step
   * anywhere in the tree, after runAppendPipeline(), and at the end of a
   * run that finished. Captures for one execution are serialised.
   * Keyed by ctx.id (the executionId); idempotent — successive snapshots
   * overwrite. No-op when checkpointStore is absent. A failed save is
   * logged via console.warn and swallowed; a failing checkpoint never
   * aborts an otherwise-successful step. See 23-durable-execution.
   */
  checkpoint(ctx: Context): Promise<void>;

  /**
   * Rebuild a Context from a previously-persisted snapshot and step ledger,
   * standing where the interrupted run began. Returns null when neither
   * exists. Surfaces NoeticConfigError with
   * code 'CHECKPOINT_SCHEMA_MISMATCH' when the snapshot's schemaVersion
   * is unrecognised — the caller discards via checkpointStore.clear()
   * and restarts with a fresh execution. The restored Context carries
   * the original executionId so downstream readers observe continuity
   * across a host restart.
   */
  restore(executionId: string, opts?: RestoreContextOptions): Promise<Context | null>;

  // Paid dispatches (see 23-durable-execution § Paid dispatches). Every paid
  // provider call is recorded before it is sent; one cut off by a crash, cancel,
  // or steer stays pending until its bill is known. Empty without durable storage.
  pendingSpend(executionId?: string): Promise<PendingSpend[]>;
  // Price pending calls through the provider's generation lookup, polling up to
  // patienceMs (default 60s). Runs on its own after restore() and whenever a call
  // is cut off.
  reconcileSpend(opts?: { executionId?: string; patienceMs?: number }): Promise<SpendSettlement[]>;
  // Settle a call that can never be priced at an amount the host asserts.
  writeOffSpend(id: string, opts: { assumedCost: number }): Promise<SpendSettlement | undefined>;

  // Lifecycle. A string is the reason alone; `{ drainMs }` drains first and
  // resolves with the drain's report (see Graceful Stop).
  cancel(ctx: Context, options?: string | CancelOptions): Promise<DrainReport | undefined>;

  // Observability (see 10-observability)
  createSpan(name: string, parent: Span | null): Span;

  // Layer state access (used by ToolExecutionContext.context)
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

## Connections, Subscriptions and Triggers

Alongside the four platform adapters, `environment.connections` holds the
harness's named connections — MCP-backed surfaces such as devices, browsers and
chat workspaces, and in-process triggers — and `environment.webhooks` the
receiver their events may arrive through. `subscriptions` declares which
connection events start or join a turn, and `harness.emit(name, event)` pushes
an event into a trigger from host code. Providers connect in
`harness.start()`, which the first `execute()` or `run()` calls implicitly;
construction stays synchronous. `harness.getConnectionStatus(name?)` reports
each instance's state. Connections differ from adapters in one way that
decides where a surface belongs: the runtime never calls a connection, only the
model, steps and workflows do. See `35-connections`.

## Sessions and the Message Queue

`execute()` enqueues a message on a **session** keyed by `options.threadId` (or a default thread when omitted). Each session owns:

- a FIFO `MessageQueue`,
- a long-lived `EventBroadcaster` that relays SDK and framework events across all turns,
- an `itemLog` snapshot that carries conversation history from turn to turn.

Before the first turn runs, the harness walks the step tree to collect all tools from callModel steps, merges them with layer-provided tools, and deduplicates by name. This **unified tool set** is stored on the turn's execution context as the pool every `callModel` step draws from. Every LLM call sends the full set, so the tool prefix stays prompt-cache stable across steps; a step's `tools` narrows the model to an allowed subset with `tool_choice: { type: "allowed_tools" }`, and the harness tool loop refuses calls to any other tool (see `02-step-variants` § Unified Tool Set). `run(step, input, ctx)` does the same lazily: when an embedder drives a step directly on a bare `createContext()` context, `run` populates that context's unified tool set (the step's tools plus the harness tools) if it is not already set, so directly-driven steps — and any sub-agents they spawn — see the harness toolset. `run` also runs the configured context layers' `init()` hooks once per context (keyed by `ctx.id`) before executing, so a harness built with `contextLayers` + a storage adapter rehydrates prior layer state, recalls it, and persists updates on the bare `run()` path — the same guarantee the session/`execute()` path gives. The init is idempotent: nested or repeated `run()` calls and the session turn path never re-init (which would clobber accumulated in-layer state by re-hydrating from storage); a deliberate `disposeLayers(ctx)` clears the guard so a later `run()` re-hydrates.

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
| `getAgentResponse(scope?)` | `Promise<HarnessResponse<Item \| CustomItemOf<TItem>>>` | Resolves once the session drains its queue and returns to idle. `items` holds final items: standard ones plus the graph's declared custom items (`34-custom-items`). |
| `getTextStream(scope?)` | `AsyncIterable<string>` | Text deltas from the model, across all turns in the session. |
| `getReasoningStream(scope?)` | `AsyncIterable<string>` | Reasoning token deltas (reasoning models). |
| `getItemStream(scope?)` | `AsyncIterable<StreamingItem>` | Cumulative item snapshots. Replace, do not append. Carries the full session log: model output streams progressively from SDK events; framework-authored items (turn inputs, inbox injections, tool results, items a step emits) arrive already complete via `item_appended`. A declared custom item streams like a model reply: each `custom_item_event` as an in-progress entry (`isComplete: false`), then its final item, under one `id`. Typed `StreamingItem \| CustomStreamingItem<TItem>`. |
| `getFullStream(scope?)` | `AsyncIterable<StreamEvent \| CustomItemStreamEvent<TItem>>` | All raw events (SDK + framework) for the session, custom item events included. |

Stream accessors MAY be subscribed before any `execute()` call; the underlying `EventBroadcaster` replays buffered events so late subscribers observe turn history within the buffer window.

### Delivery Modes

Each queued message carries a `DeliveryMode`:

| Mode | Behaviour |
|------|-----------|
| `next-turn` (default) | Message runs as a new turn once the current turn completes. Safe and predictable. |
| `between-rounds` | A steer. Added to the conversation before the next model call of the running turn, including the first. If no turn is active, behaves like `next-turn`. Mirrors Claude Code's inbox-attachment pattern. |
| `next-item` | A steer. Applied as soon as the model finishes the output item it is writing: the stream stops at that item boundary, the finished items are kept, finished tool calls run, and the next round sees the message. Mirrors the Responses API's `response.steer`. If no turn is active, behaves like `next-turn`. |
| `interrupt` | Cancels the in-flight turn (if any), keeps the items the turn finished, places the message at the head of the queue, and restarts from the merged history. |

`AgentConfig.defaultDeliveryMode` (default `next-turn`) applies to messages that don't specify a mode. Callers may override per-call via `ExecuteOptions.deliveryMode`.

An `interrupt` keeps every item from rounds that completed before the cut. A tool call left without an output is answered with `"Cancelled before it ran."` so the restarted turn's history stays valid input. The half-streamed item is lost. A plain `abort()` keeps nothing from the turn.

### Steers

A **steer** is a `between-rounds` or `next-item` message: one meant for the turn that is running. It is offered to the context layers at three **steer points** inside a model call:

| Point | When | `between-rounds` default | `next-item` default | Applying here |
|-------|------|------|------|------|
| `item_done` | The stream finished an output item | `defer` | `apply` | Stops the stream; the round ends with the finished items |
| `before_tool_call` | A client tool call is about to run | `defer` | `defer` | Skips this call and the rest of the round; each skipped call is answered `"Skipped: a new message arrived before this tool call ran."` |
| `before_round` | A model call is about to start | `apply` | `apply` | Adds the steer to this call's input |

Layers change the outcome with the `onSteer` hook (see `11-context-layer-system`): `apply`, `defer` (offer again at the next point), or `drop`. A steer applied at any point is held until the next model call, then added to the conversation in the order the model sees it, after passing through the `onItemAppend` pipeline. Applied steers are part of the call's response items, so they reach the item log with the rest of the round.

When an applied steer's layers ask for `recall`, the model call ends at the round boundary where the steer is applied, before the next model request. Its response carries `recall: true`. The `callModel` step records it, runs recall again with the steer's text as the query, assembles a new view, and continues the call on it. Anchored layer output stays pinned, so the new render arrives as a supersede update after the steer.

A stream stopped by a steer reports no usage for that round; the provider sends usage only with a finished response. When a steer is staged while the model writes its final answer, the call runs one more round so the model answers the steer itself. A `between-rounds` steer that arrives during the final answer stays queued and runs as the next turn.

Steers reach model calls on the session's own context. A spawned child takes them only when spawned with `steers: 'forward'` (see `04-spawn`); `inParallel` paths and other spawns leave them queued until control returns.

With durability on, a steer sent into a running turn is kept in the thread's session record until the turn ends, so a turn resumed on a new harness still applies it (see `23a-step-level-resume` § Sessions).

### Graceful Stop

`cancel(ctx, { drainMs })` and `abort({ drainMs })` stop an execution gently, for a host that is shutting down:

1. **Nothing new starts.** Beneath the drained context, every step boundary, model round and tool call waits instead of starting. Calls already in flight carry on.
2. **In-flight model calls finish, up to `drainMs`.** A `callModel` round or `decide` call counts as in flight from dispatch until its caller next reaches a step boundary, round or tool call, or its step ends. So a finished call is charged to the context and, when it was a step's last, the step is recorded in the ledger before anything is cancelled.
3. **Then it cancels as without `drainMs`.** The drain ends as soon as nothing is in flight (`settled`), at the deadline (`deadline`), or when the tree is stopped another way (`stopped`). Held steps then throw `cancelled`. Calls still running are cut off through the same abort path a plain cancel uses: with durable storage, each keeps its dispatch record pending, with its generation id when its response headers arrived, and is priced in the background like any other cut-off call (`23-durable-execution` § Paid dispatches).

A second `cancel` or `abort` on the drained context during the drain stops it at once. The drained session reports `{ kind: 'draining', turnId, deadline }` from `getStatus()` until the cancel begins. A drained `run()` execution reports `{ kind: 'draining', deadline }` from `getStatus({ executionId })`, then `aborting` until its run returns; between runs it reads `idle`, and while a run is in flight, `generating`. Only a root context's outermost `run()` counts as an execution: a child context has no status of its own.

Both stops resolve with the drain's **report**, once the cancel that follows it is done: `{ executionId, reason, durationMs, finished, cutOff }`, the data of `drain_finished`. A second stop that cuts the drain short resolves with the same report. A stop with no drain, whether plain or on a context already cancelled, resolves `undefined`.

Each call in a report is a `DrainCall`: `{ kind: 'model_round' | 'decide', model, executionId, round?, dispatchId?, generationId?, cost?, usage? }`, where `executionId` is the id of the context that made it. A model round carries `dispatchId`, its dispatch record's id, when the harness keeps records, and `generationId` once its response headers arrived, so a host can match each `cutOff` call to its entry in `pendingSpend()`. A `finished` call the provider billed carries its `cost` (USD) and `usage` (`RoundUsage`), exactly as charged to its context, so a host can account a drained call the way it accounts a returned one, even when the drained step ended `cancelled` and never published `lastStepMeta`. That includes a round the loop rejected and asked again (a terminal status or no output), listed under the same `round` as its retry, and a call that failed after it was billed. A round is finished as soon as its response is counted, even if its event stream is still open when the deadline lands. A call the provider refused, or whose stream a steer cut before its response, has neither.

Two framework events report the drain on the context's broadcaster:

| Event | Data |
|-------|------|
| `{name}:drain_started` | `{ executionId, deadline, inFlight }` |
| `{name}:drain_finished` | `{ executionId, reason: 'settled' \| 'deadline' \| 'stopped', durationMs, finished, cutOff }` |

### Stream Idle Timeout

The harness runs a per-round watchdog over each provider call's SSE stream. The idle timeout is fixed at 120 seconds — long enough that slow models are never falsely aborted, short enough that a stalled SSE becomes a visible error rather than a silent hang. The watchdog re-arms on every stream event; if no event arrives within the window, the round is aborted, `{name}:model_call_stalled` is emitted, and the surrounding turn fails with `turn_aborted { reason: "model stream idle timeout after <N>ms" }`. This prevents silent hangs when a provider drops the connection without sending a terminal event.

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
| `{name}:item_appended` | Emitted whenever a framework-authored item enters the session log — turn input messages (after `turn_started`), between-rounds inbox injections, tool result items, and the items a step with `emitItems` adds when it finishes, or streams again on replay under `emitItemsOnReplay` (`01-step-type` § Emitting items). Data: `{ item }`. Backs `getItemStream` for everything the SDK stream cannot carry, so it is emitted unconditionally — never filtered by `step.emit`. |
| `{name}:custom_item_event` | One event of a declared custom item, as a step yields it (`34-custom-items`). Data: `{ id, type, event }`; `id` is the one its final item takes. Emitted unconditionally, like `item_appended`. |
| `{name}:turn_completed` | Emitted when a turn completes. Data: `{ turnId, durationMs }` |
| `{name}:turn_aborted` | Emitted when a turn is aborted or errors. Data: `{ turnId, reason }` |
| `{name}:steer_accepted` | Emitted when a steer is queued while a turn runs. Always precedes the `inbox_injected` that applies it. Data: `{ messageId, turnId, deliveryMode }` |
| `{name}:steer_pending` | Emitted once per steer when it is deferred at `before_tool_call`, waiting for tool calls to finish. Data: `{ messageId, waitingOn: callId[] }` |
| `{name}:steer_dropped` | Emitted when a layer drops a steer. No turn will answer it. Data: `{ messageId, point }` |
| `{name}:inbox_injected` | Emitted when applied steers are added before a model call. Data: `{ round, count, messageIds }` |
| `{name}:model_call_steered` | Emitted when a steer stops a round's stream at an item boundary. Data: `{ round, itemCount }` |
| `{name}:step_started` | Emitted before each step executes. Data: `{ stepId, kind }` |
| `{name}:step_completed` | Emitted after each step completes. Data: `{ stepId, kind }` |
| `{name}:tool_round_started` | Emitted before a tool execution round. Data: `{ round, toolCount }` |
| `{name}:tool_call_started` | Emitted before each tool call. Data: `{ name, callId }` |
| `{name}:tool_call_completed` | Emitted after each tool call. Data: `{ name, callId, error }` |
| `{name}:tool_round_completed` | Emitted after all tool calls in a round. Data: `{ round, toolCount }` |
| `{name}:model_call_started` | Emitted before each provider call in the tool-round loop. Data: `{ round, messageCount, toolCount }` |
| `{name}:model_call_first_event` | Emitted when the first SDK event for the call arrives. Useful for measuring time-to-first-token. Only emitted when a broadcaster is attached to the context. Data: `{ round }` |
| `{name}:model_call_completed` | Emitted after the provider's response is fully received. Data: `{ round, itemCount }` |
| `{name}:model_call_stalled` | Emitted when the stream-idle watchdog fires (fixed 120s idle window). The turn then aborts. Data: `{ round, idleTimeoutMs }` |
| `{name}:stream_pipe_error` | Emitted when SDK stream piping fails. Data: `{ error }` |
| `{name}:spend_pending` | Emitted when a paid call is left with no settled bill, or `restore()` finds one (`23-durable-execution` § Paid dispatches). Data: `{ id, kind, model, generationId?, ceiling?, unbounded? }`, or `{ id, unreadable: true, unbounded: true }` for a record that no longer reads |
| `{name}:spend_settled` | Emitted when a pending paid call is settled or written off. Data: `{ id, cost, writtenOff? }` |
| `{name}:drain_started` | Emitted when a graceful stop begins (see Graceful Stop). Data: `{ executionId, deadline, inFlight }` |
| `{name}:drain_finished` | Emitted when a graceful stop ends, just before the cancel. Data: `{ executionId, reason, durationMs, finished, cutOff }` |

### Streaming Scope

Events from the entire step composition tree flow through `HarnessResult`. All callModel steps encountered during execution (including within loops, conditionals, inParallel paths, and spawns) emit SDK stream events. Non-callModel steps emit framework lifecycle events only.

### Event Emission Control

callModel steps support an optional `emit` field to control framework event emission:

```typescript
callModel({ id: 'quiet', model: '...', emit: false });           // suppress all
callModel({ id: 'selective', model: '...', emit: (type) => type === 'step_started' }); // filter
```

- **`true`** (default): all framework events emitted.
- **`false`**: no framework events (`step_started`, `step_completed`, `tool_round_*`, `tool_call_*`) for this step.
- **Filter function**: `(eventType: string, data: Record<string, unknown>) => boolean` — called per event, return `true` to emit.

The `emit` option propagates through `CallModelRequest` to `callModel()`, controlling tool round/call events as well.

### Bounded Buffer

The internal `EventBroadcaster` buffer is capped at 10,000 events. When the buffer exceeds this limit, oldest events are trimmed and active iterator cursors are adjusted. Once all consumers have departed, new events are discarded to prevent unbounded memory growth. Late subscribers receive only the retained window.

### Error Handling

When `execute()` is called on a harness without an `agentGraph`, it rejects with `NoeticConfigError` code `NO_STEP_CONFIGURED`. When a turn fails mid-stream, `getAgentResponse()` surfaces the error and the session remains usable for subsequent turns.

### ExecuteOptions

```typescript
interface ExecuteOptions {
  threadId?: string;
  resourceId?: string;
  state?: unknown;
  context?: ContextLayer[];
  /** Per-call override of the harness default. */
  deliveryMode?: DeliveryMode;
}

interface SessionScope {
  threadId?: string;
}

type HarnessStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'generating'; readonly startedAt: number; readonly turnId: string }
  | { readonly kind: 'draining'; readonly turnId: string; readonly deadline: number }
  | { readonly kind: 'aborting'; readonly turnId: string };

interface ExecutionScope {
  executionId: string;   // a root context's id
}

type ExecutionStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'generating'; readonly startedAt: number }
  | { readonly kind: 'draining'; readonly deadline: number }
  | { readonly kind: 'aborting' };

interface CancelOptions {
  readonly reason?: string;
  /** Drain for up to this many ms before cancelling (see Graceful Stop). */
  readonly drainMs?: number;
}

interface DrainCall {
  readonly kind: 'model_round' | 'decide';
  readonly model: string;
  readonly executionId: string;
  readonly round?: number;
  readonly dispatchId?: string;
  readonly generationId?: string;
  readonly cost?: number;       // finished calls with a bill, as charged
  readonly usage?: RoundUsage;  // set exactly when `cost` is
}

interface DrainReport {
  readonly executionId: string;
  readonly reason: 'settled' | 'deadline' | 'stopped';
  readonly durationMs: number;
  readonly finished: ReadonlyArray<DrainCall>;
  readonly cutOff: ReadonlyArray<DrainCall>;
}

type DeliveryMode = 'next-turn' | 'between-rounds' | 'next-item' | 'interrupt';
```

---

## Key Design Points

- **`send`/`recv`/`tryRecv` on the agent harness** means the agent harness controls channel storage. `AgentHarness` keeps channel state in an in-process store keyed by channel name. The `Context` methods are thin wrappers: `ctx.send(ch, v)` calls `harness.send(ch, v, ctx)`. `ctx.tryRecv(ch)` calls `harness.tryRecv(ch, ctx)`.
- **`getChannelHandle`** returns a `ChannelHandle<T>` for external code to write into a running execution. The handle is typed, lifecycle-aware, and scoped to the root execution. External handles route to the correct execution via `executionId`. `AgentHarness` issues in-process handles.
- **`getChannelStream`** is the read-side counterpart: an `AsyncIterable<T>` over values the agent sends on an external channel. Delivery is channel-scoped; `executionId` bounds only the subscription's lifetime (it ends when that root execution completes, and a never-run id yields a harness-lifetime stream). Per-mode delivery and lifecycle semantics are specified in `06-channels` (External Subscriptions).
- **Context layer methods** manage the full lifecycle defined in `11-context-layer-system`. `initLayers` runs `init()` sequentially. `recallLayers` runs `recall()` in slot order and returns `Item[]`. `storeLayers` runs `store()` concurrently via `Promise.allSettled` and receives `LLMResponse` (with items + usage). `disposeLayers` runs `dispose()` in reverse order. Error handling follows the per-hook policy.
- **`previewRequestItems(scope?)`** returns the `Item[]` that would be sent to the model on the next turn for `scope.threadId` (or the default thread): the session's accumulated history with harness-level context-layer recall outputs prepended via `assembleView`. Runs layer `init` on a throwaway preview context first — the same hydration the next real turn would perform, re-loading thread/resource-scoped state from storage — because the recall lifecycle skips init-bearing layers that were never initialized. The preview execution's layer-state entries are flushed and dropped afterwards, so repeated previews neither grow the store nor leak into real turns. Does not allocate a session for unknown thread ids — returns an empty history in that case.
- **`beforeToolCall(layers, toolName, toolArgs, ctx)`** runs each layer's `beforeToolCall` hook sequentially in slot order before a tool is executed. Returns a `SteeringDecision` — `Allow` proceeds normally, `Deny` short-circuits and blocks the tool call, `Guide` returns guidance text to the model. Short-circuits on the first `Deny`. When multiple layers return `Guide`, their guidance is concatenated.
- **`afterModelCall(layers, response, ctx)`** runs each layer's `afterModelCall` hook sequentially in slot order immediately after the LLM responds. Returns a `SteeringDecision` — `Allow` proceeds normally, `Deny` throws `steering_denied`, `Guide` injects guidance as a developer message and retries the model call (up to 3 times). Short-circuits on the first `Deny`.
- **`fs`** exposes the `FsAdapter` that the harness was constructed with via `environment.fs` (or the default in-memory adapter). All filesystem operations — CLI tools (read, write, edit, ls, grep, find), skill discovery, and context layers — use `ctx.harness.fs` rather than importing `fs/promises` directly. This enables sandboxed or virtualized filesystems (e.g., in-memory FS for testing, remote FS for cloud execution). `Context` exposes a `readonly fs: FsAdapter` getter that delegates to the harness. `ToolExecutionContext` and memory `ExecutionContext` also expose `readonly fs: FsAdapter`.
- **`config`** exposes the `AgentConfig<TParams>` that the harness was constructed with. Steps and tools access harness params via `ctx.harness.config.params`.
- **`contextLayers` on `AgentHarnessOpts`** are default context layers applied to every context created via `createContext()`. When `createContext` is called with its own `contextLayers` option, the per-call layers take precedence (full override, not merge). When neither is specified, the context has no default layers. This provides a convenient way to set up context for the entire agent without passing layers to every call.
- **`detachedSpawn`** launches a child step concurrently without blocking the caller. Creates a child `Context` with `parent: parentCtx`, starts execution, and returns a `DetachedHandle` immediately. The handle tracks status (`running` / `completed` / `failed`), exposes the result, and supports `await(timeout?)` for blocking on completion. Pairs with the loop inbox channel (see `05-loop-and-until`) for async sub-agent notification patterns. Optional `overrides.threadId` / `overrides.resourceId` decouple the child's session-scoped item log from the parent's — useful for background sub-agents whose accumulated items should NOT replay in the parent's next turn.
- **`checkpoint`/`restore`** are the first-class durable-execution surface. `AgentHarness` implements them against an injected `CheckpointStore` (which wraps the harness's `StorageAdapter`). When no store is configured both calls are no-ops, preserving zero-config ergonomics. A distributed backend plugs in by implementing `CheckpointStore`, not by subclassing the harness. The full lifecycle (snapshot boundaries, schema versioning, idempotency expectations, restart flow) is specified in `23-durable-execution`.
- **`cancel`** with propagation. The agent harness knows the execution tree (via parent/child context references) and walks it to cancel children. Cancelled executions still run `onComplete` and `dispose` on their context layers.
- **`createSpan`** lets the agent harness control the tracing backend.

### Shared cwd

`AgentHarness` holds a long-lived `rootCwdState: CwdState`. Every root context (those created without a `parent`) shares the same `CwdState` reference, so successive `run()` calls observe each other's `cd`s. `spawn` and `inParallel` children get a snapshot (POSIX-fork semantics) — child mutations do not leak to the parent. Worktree-isolated children are seeded via `createContext({ cwdInit: worktreePath })` or `detachedSpawn(..., { cwdInit })`.

The TUI calls `setRootCwd(nextCwd)` when the user issues a `!cd`, so the next agent turn's tools see the new cwd. The agent's Bash tool intercepts plain `cd` and mutates `cwdState` directly via `setToolCwd` — for the root context, this is the same object as `rootCwdState`, so `cd` round-trips into the TUI's prompt display on the next turn settle.

`AgentHarnessOpts` accepts an optional `initialCwd?: string`; when omitted, `rootCwdState` is seeded with `process.cwd()`.

### Harness-wide tools

`AgentHarnessOpts.tools?: Tool[]` seeds a tool pool that is merged with tools collected from `agentGraph` to form every context's `ctx.unifiedTools`. This is the supported way to supply tools when the workflow graph is fully static — i.e. when `callModel.tools` is a `(ctx) => ctx.unifiedTools.filter(...)` getter rather than an eager array. Function-form `step.tools` are invisible to `collectAllTools`, so anything needed at the harness level must come in through `tools`.

Dedupe is **name-based, first-wins**. The merge order is `[...stepCollectedTools, ...harnessTools]`, so when a tool name appears in both sets, the step-collected instance wins and the harness-level instance is dropped. This matches the precedence a user would expect when a specific step hard-codes a tool while the harness supplies a default pool.

Ordering at resolve time: an eager `step.tools` array still wins for its own call (used as the per-call allowed set); `unifiedTools` (populated from the merge above) is the superset sent to every LLM call.

### Tool approval

`AgentHarnessOpts.approveToolCall?: ToolApprover` is the harness approver for tools that declare `needsApproval`; the harness stores it as `config.approveToolCall`. Both tool-executing paths — the model-driven tool loop and `invokeTool` — ask it after the `beforeToolCall` layers allow a call and before `execute` runs. `allow` runs the call; any other action refuses it, and an approver that throws refuses it too. Without an approver, such calls run unapproved and the harness logs a warning once per tool name. The contract, gate order, and refusal shapes are specified in `02-step-variants` ("Approval").

```typescript
const harness = new AgentHarness({
  name: 'ops',
  params: {},
  approveToolCall: async ({ toolName, toolArgs, ctx }) => {
    await ctx.harness.send(approvalRequests, { toolName, toolArgs }, ctx);
    const approved = await ctx.harness.recv(approvalAnswers, ctx);
    return approved ? { action: 'allow' } : { action: 'deny', guidance: 'refused by operator' };
  },
});
```

### Item schema registry (extension-item validation)

The harness validates items at trust boundaries (model output parsing, session restore, tool-result decoration) through an `ItemSchemaRegistry` seeded from harness-level `itemSchemas`. Harness-level schemas are global by design. Tool and context-layer extension schemas are **additive and owner-scoped**:

- **Model output parsing** uses the harness registry extended with the round's context-layer and tool schemas. Items matching a known base type always pass even when extension schemas are registered.
- **Tool result items** are validated against the harness registry extended with **only the called tool's** `itemSchemas.toolResults` — one tool's schemas never reject a sibling tool's result items, and tools without schemas fall back to the base structural parse.
- Extension schemas are **gates, not normalizers**: on match the original item is returned unchanged, including fields the schema does not declare. Zod transforms and defaults in extension schemas are unsupported.
- Validation failures raise `NoeticError` kind `item_schema_mismatch` (see `09-error-model`).

### What's NOT on the AgentHarness

- **`assembleView`** — view assembly (the Projector) is a standalone function in `context/projector.ts`. It calls `recallLayers`, allocates token budgets, and assembles system prompt item + layer output items + conversation history items into the View as `Item[]`. This is what `executeLLM` calls internally before sending items to the model.
- **`executeFork`** — inParallel execution is handled by the core `run` switch. The `inParallel` variant calls `run` on each path internally.
- **`summarize`** — summarization is just an LLM call. The `spawn` executor calls `run(callModel({ id: 'summarize', ... }), ...)` internally.

---

## Durable Execution

The harness exposes four surfaces that together enable crash-recovery: `subprocess.listLive()` / `subprocess.reattach()` (rediscover running children), `checkpoint()` / `restore()` (save and replay parent execution state), and the `StorageAdapter` + `CheckpointStore` wiring that persists them.

### Checkpoint Lifecycle

Snapshots fire automatically at run start, after every completed step (an `inParallel` path or `spawn` child checkpoints its root), after `runAppendPipeline`, and at the end of a run that finished; captures for one execution are serialised. Any caller may also invoke `harness.checkpoint(ctx)` explicitly. Snapshots are keyed by `ctx.id` under `execution:<id>:snapshot` and overwrite one another.

Snapshot content (Zod-validated by `CheckpointSnapshotSchema`):

- `schemaVersion` — literal `3`; bumped on backward-incompatible change (v3 rejects v2 snapshots, whose item log is not a run baseline).
- `executionId`, `threadId`, `resourceId` — identity.
- `frontier` — `FrontierFrame { stepId, input, state? }` entries for the steps in flight.
- `layers` — `Record<layerId, state>` captured via `layerStateStore.get(executionId, layerId)`.
- `cwd` — `{ current, previous }`.
- `askUser` — pending ask-user requests (populated when the code-agent's `AskUserService` integrates with the store).
- `itemLog`, `occurrences` — the run baseline: the item log and dispatch counts when the run in flight began.
- `state`, `usage` — `ctx.state` (when JSON-encodable) and tokens/cost at capture.
- `channels` — stored channel state.
- `capturedAt` — ISO-8601 timestamp.

### Restore Contract

`harness.restore(executionId, opts?)` reads the snapshot and the step ledger and rebuilds a `Context` standing where the interrupted run began:

1. Replays layer state into `layerStateStore` and channel state into the channel store under the same executionId.
2. Re-parses `itemLog.items` via the harness's `ItemSchemaRegistry` (the same gate production traffic passes through).
3. Seeds a new context with the baseline item log, `threadId`, `resourceId`, `cwdInit`, `state` (unless `opts.state` is given), dispatch counts, and usage.
4. Holds the execution's pending paid calls on the context (`heldCost`) and starts reconciling them in the background (`23-durable-execution` § Paid dispatches).
5. Returns a `Context` whose `.id` is the original `executionId`, carrying the recovered step ledger. Running the same step on the same input replays every recorded step and continues live (`23a-step-level-resume`).

Returns `null` when neither a snapshot nor a ledger entry is recorded. Throws `NoeticConfigError` with `code: 'CHECKPOINT_SCHEMA_MISMATCH'` when the persisted schemaVersion is not the one the running runtime understands — callers discard via `harness.clearCheckpoint(executionId)` and restart the execution.

### Durability Guarantees

- **With a durable `StorageAdapter`** (e.g. `createFileStorage({root})`): full snapshot/restore and step-level resume across host restarts and harness instances — the checkpoint store defaults to one over the adapter. `harness.execute()` sessions keep their thread history and resume a re-delivered cut-off turn.
- **Without** (the default zero-config harness, or `durability: false`): `checkpoint()` is a no-op, `restore()` returns null, `listLive()` returns the empty set, `reattach()` returns null. All existing in-memory semantics are preserved bit-identically.
- **Schema versioning**: `CheckpointSnapshot.schemaVersion` is validated on load. Incompatible versions surface a typed error rather than a silently-corrupt restored context.
- **Checkpoint failures never abort a step.** A failing `store.save` is logged via `console.warn` and swallowed; the step's return value is unaffected.

### Limitations

- **LLM mid-stream**: a round cut off mid-stream is asked again on resume; finished rounds replay. Its bill is settled from its dispatch record, or held at its ceiling when it has no generation id.
- **Non-idempotent `runCode` bodies** may run twice if a crash lands between the body's side effect and its ledger append. Write bodies that are safe to re-execute, or gate with an external idempotency key.

See `23-durable-execution` for the full durable-execution model, including `SubprocessAdapter.reattach`/`listLive` semantics, the durable IPC outbound queue, protocol v2 frames, and the host-restart recovery flow.

## AgentHarness Backends

| Backend                    | When to Use                                                     | Durability | Channel Handles |
|----------------------------|-----------------------------------------------------------------|------------|-----------------|
| `AgentHarness<TParams>`     | Testing, simple scripts, CLI tools. Resolves the LLM provider from `callModelDefaults` (default `'noetic'`, keyed by `NOETIC_API_KEY`; `'openrouter'` reads `OPENROUTER_API_KEY`) — see `02-step-variants` § LLM Provider Configuration. | Ephemeral by default; full durable execution when constructed with a durable `StorageAdapter`. | In-process handles |

```typescript
import { AgentHarness, scratchpad } from '@noetic-tools/core';

const harness = new AgentHarness({
  name: 'my-agent',
  agentGraph: agent,
  params: { model: 'anthropic/claude-sonnet-4-20250514' },
  contextLayers: [scratchpad()],
});

await harness.execute('Summarise the open issues'); // a session turn through `agentGraph`
const report = await harness.run(reportStep, input, harness.createContext()); // one step tree
```

---

## Harness Ownership

There is no process-wide harness and no registration step. Code constructs an `AgentHarness` and calls its methods — `execute()` for session turns, `run()` for a step tree in a context it created. Everything a run depends on belongs to that instance: the provider defaults, context layers and their state, storage, the checkpoint store, adapters, and the `traceExporter` (see `10-observability`, which likewise takes its exporter per harness rather than from a global).

1. **Several harnesses per process.** Two harnesses in one process are independent: each has its own config, layer state, sessions, and trace backend. Nothing one does is visible to the other.
2. **Steps reach their harness through the context.** Every `Context` carries the harness that created it (`ctx.harness`, see `07-context-and-event-log`), and child contexts inherit it. Steps, tools, and layers never look a harness up globally, so module load order does not matter.
3. **No registration errors.** With no global to set, there is nothing to register twice and nothing to forget. A step that needs a harness and runs in a context without one — a `workflow` step outside a harness-created context — fails with `NoeticConfigError` `MISSING_HARNESS_CONTEXT` (see `02-step-variants`).

### Test Isolation

Construct a harness where the test needs it — per test, in `beforeEach`, or once per file. There is no global to reset between tests, and tests that build their own harnesses can run concurrently.

```ts
import { AgentHarness } from '@noetic-tools/core';

const makeHarness = () => new AgentHarness({ name: 'test', params: {} });

it('answers', async () => {
  const harness = makeHarness();
  const output = await harness.run(step, 'hi', harness.createContext());
  // ...
});
```

### Serverless / Stateless Environments

In serverless functions (AWS Lambda, Cloudflare Workers, etc.), construct the harness at module scope so it is built once per cold start, not once per invocation:

```ts
// Runs once per cold start
const harness = new AgentHarness({
  name: 'lambda-agent',
  params: {},
  callModelDefaults: { provider: 'openrouter' },
});

export const handler = async (event) => {
  return harness.run(agentStep, event, harness.createContext());
};
```

In-memory channel storage and a harness without a `CheckpointStore` do not persist across invocations. Construct `AgentHarness` with a durable `StorageAdapter` (`environment: { storage: { adapter } }` — the checkpoint store defaults to one over it) if cross-invocation state is required — see `23-durable-execution`.

---

## `AgentConfig`

The top-level configuration for an agent harness. `AgentConfig` is generic over `TParams`, an arbitrary key-value record that steps and tools access via `ctx.harness.config.params`. Domain-specific settings (model, instructions, tools, context layers) live in `params` rather than as top-level fields, keeping the harness config minimal and the params bag extensible without schema changes.

```typescript
interface AgentConfig<TParams extends Record<string, unknown> = Record<string, unknown>> {
  name: string;

  /** Storage backend for context persistence. See 11-context-layer-system. */
  storage?: StorageAdapter;

  /** Agent-level lifecycle hooks (separate from layer hooks). */
  hooks?: AgentHooks;

  /** Arbitrary key-value parameters accessible via ctx.harness.config.params. */
  params: TParams;

  /** Item schema extensions and validation strictness for emitted and returned items. */
  itemSchemas?: ItemSchemaConfig;

  /** Default projection policy for all LLM steps. Individual steps override via `step.projection`. */
  projection?: ProjectionPolicy;

  /** When true, every layer is recalled atomically regardless of its `recallMode`. */
  forceAtomicRecall?: boolean;

  /** Tuning for prompt-cache anchoring. */
  contextCache?: ContextCacheConfig;

  /**
   * Whether a resumed run streams again, as `item_appended`, the items its replayed
   * steps emitted through `emitItems`. Default `false`: replay rebuilds the log quietly.
   * See `01-step-type` § Emitting items.
   */
  emitItemsOnReplay?: boolean;

  /** Approves or refuses calls to tools that declare `needsApproval`. See "Tool approval". */
  approveToolCall?: ToolApprover;
}
```

The harness's own execution surfaces (filesystem, shell, subprocess, storage stores) are configured separately through `AgentHarnessOpts.environment` (`AgentEnvironmentConfig`), and default context layers through `AgentHarnessOpts.contextLayers`:

```typescript
interface AgentEnvironmentConfig {
  /** Storage configuration: adapter, durability stores, ledger retention. */
  storage?: {
    /** Key-value adapter backing context-layer persistence and the step ledger. Defaults to in-memory. */
    adapter?: StorageAdapter;
    /** Checkpoint store used by checkpoint()/restore(). Defaults to one over `adapter`. With neither, durability hooks are no-ops. */
    checkpointStore?: CheckpointStore;
    /** Layer-state store override. Defaults to an in-memory store. */
    layerStateStore?: LayerStateStore;
    /** Bounds on the step-completion ledger backing step-level resume. */
    stepLedgerRetention?: StepLedgerRetention;
  };
  /** Filesystem adapter. Defaults to an in-memory adapter. */
  fs?: FsAdapter;
  /** Shell adapter. Defaults to an in-memory adapter. */
  shell?: ShellAdapter;
  /** Subprocess adapter. Defaults to an in-memory, same-process adapter. */
  subprocess?: SubprocessAdapter;
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
