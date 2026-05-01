# Noetic API Reference

## Builder Functions

### step.run

Pure async computation. The runtime can retry freely and doesn't track token usage.

```typescript
step.run<TMemory = ContextMemory, I = unknown, O = unknown>({
  id: string;
  execute: (input: I, ctx: Context<TMemory>) => Promise<O>;
  retry?: RetryPolicy;
}): StepRun<TMemory, I, O>
```

### step.llm

Model call with optional tools and structured output.

```typescript
step.llm<TMemory = ContextMemory, I = unknown, O = unknown>({
  id: string;
  model: string;
  instructions?: string;
  tools?: Tool[];             // allowed tool subset (undefined = all, [] = none)
  output?: ZodType<O>;
  params?: ModelParams;
  emit?: boolean | ((eventType: string, data: Record<string, unknown>) => boolean);
}): StepLLM<TMemory, I, O>
```

`tools` specifies which tools the model may invoke for this step. Before execution, the harness collects all tools from every LLM step in the tree into a unified set. Every LLM call sends the full set (preserving prompt cache), while `tools` narrows the allowed subset via `tool_choice: { type: "allowed_tools" }`. Omit `tools` to allow all; set `tools: []` to disable tools for the step.

`emit` controls framework event emission (default `true`). Set `false` to suppress all, or pass a filter function.

The agent harness assembles the View before calling the model: system message + memory layer items + conversation history. The `instructions` field becomes an `InputMessageItem` with `role: system`.

### step.tool

Direct tool execution (not via LLM selection).

```typescript
step.tool<TMemory = ContextMemory, I = unknown, O = unknown>({
  id: string;
  tool: Tool<ZodType<I>, ZodType<O>>;
  args?: Partial<I>;
}): StepTool<TMemory, I, O>
```

### branch

Conditional routing. The `route` function returns a step to execute or `null` to pass through.

```typescript
branch<I, O>({
  id: string;
  route: (input: I, ctx: Context) => Step<I, O> | null;
}): StepBranch<I, O>
```

### fork

Parallel execution with three modes.

```typescript
// Race: first to complete wins
fork<I, O>({ id, mode: 'race', paths: () => Step[] })

// All: wait for all, merge results
fork<I, O>({ id, mode: 'all', paths: () => Step[], merge: (results) => O })

// Settle: wait for all (including failures), merge
fork<I, O>({ id, mode: 'settle', paths: () => Step[], merge: (results: SettleResult[]) => O })
```

Each fork path gets a deep clone of parent state. Mutations in one path don't affect siblings.

### spawn

Child execution with context boundary. Memory layers control what state crosses the boundary.

```typescript
spawn<TMemory = ContextMemory, I = unknown, O = unknown>({
  id: string;
  child: Step<TMemory, I, O>;
  memory?: MemoryConfig | MemoryLayer[];
  timeout?: number;
}): StepSpawn<TMemory, I, O>
```

### loop

Iteration with termination predicates.

```typescript
loop<I, O>({
  id: string;
  steps: ReadonlyArray<Step<I, O>>;
  until: Until;
  maxIterations?: number;
  inbox?: Channel<string>;
  parkTimeout?: number;
  prepareNext?: (output: O, verdict: Verdict, ctx: Context) => I;
}): StepLoop<I, O>
```

### every

Schedule a step on a fixed interval, optionally woken sooner by a channel message. The operator runs forever until the executing context is aborted; cancellation flows through `harness.abort` and interrupts the parking promise immediately.

```typescript
every<I, O>({
  id: string;
  step: Step<I, O>;
  ms: number;                          // period, start-to-start
  wakeOn?: Channel<unknown>;           // any message cuts the wait short
  onError?: 'continue' | 'fail';       // default 'continue'
  jitter?: number;                     // default 0; ms ± randomized
}): StepEvery<I, O>
```

`onError: 'continue'` (default) emits an `every.iteration.error` span event with the caught error attached, then re-loops — daemon-friendly. `onError: 'fail'` propagates and terminates the operator (and any enclosing `fork`). Returns `Step<I, void>` so it composes into `fork({ paths })` and `spawn({ child })` for orchestrating long-running scheduled work.

### tool

Typed tool factory with Zod validation.

```typescript
tool<I, O>({
  name: string;
  description: string;
  input: ZodType<I>;
  output: ZodType<O>;
  execute: (args: I, toolCtx: ToolExecutionContext) => Promise<O>;
  needsApproval?: boolean;
  memory?: ToolMemoryDeclaration;
}): Tool
```

### channel

Typed inter-step communication.

```typescript
channel<T>(name: string, {
  schema: ZodType<T>;
  mode: 'value' | 'queue' | 'topic';
  capacity?: number;
  external?: boolean;
}): Channel<T>
```

## Termination Predicates

```typescript
until.maxSteps(n)        // Stop after n iterations
until.maxCost(n)         // Stop when cumulative cost exceeds n
until.maxDuration(ms)    // Stop after ms milliseconds
until.noToolCalls()      // Stop when LLM doesn't call any tools
until.verified(fn)       // Stop when verification passes
until.never()            // Never stop (for `every` / forever-loops with external abort)
until.converged(opts)    // Stop when output stabilizes

// Combinators
any(...predicates)       // Stop when ANY predicate fires
all(...predicates)       // Stop when ALL predicates fire
```

## Patterns

### react

ReAct loop: LLM with tools, repeat until no tool calls.

```typescript
react({
  model: string;
  instructions?: string;
  tools: Tool[];
  maxSteps?: number;
  maxCost?: number;
  memory?: MemoryConfig | MemoryLayer[];
}): StepLoop | StepSpawn
```

When `memory` is provided, automatically wraps the loop in a `spawn` with those layers.

### ralphWiggum

Outer verify-and-retry loop wrapping inner ReAct. Each iteration gets a fresh context.

```typescript
ralphWiggum({
  model: string;
  instructions: string;
  tools: Tool[];
  verify: (output: unknown) => Promise<{ pass: boolean; feedback?: string }>;
  maxIterations?: number;
  innerMaxSteps?: number;
}): StepLoop
```

### interview

Host-callback-driven structured interview. The model emits a `z.discriminatedUnion('type', [questionEnv, completeEnv])` envelope each turn; the host renders questions via `askQuestion` and answers thread back as the next user message. Terminates on `complete` or `maxQuestions`.

```typescript
interview<Q, C>({
  systemPrompt: string;
  model: string;
  questionSchema: ZodType<Q>;
  completeSchema: ZodType<C>;
  askQuestion: (envelope: Q) => Promise<InterviewQuestionAnswer>;
  onComplete: (envelope: C) => Promise<void>;
  maxQuestions?: number;          // default 8
  formatAnswer?: (a: InterviewQuestionAnswer) => string;
}): Step<ContextMemory, string, InterviewResult<Q, C>>

type InterviewResult<Q, C> =
  | { status: 'complete'; envelope: C }
  | { status: 'maxQuestions'; lastQuestion?: Q };

interface InterviewQuestionAnswer {
  questionId: string;
  question: string;
  answer: string | string[];
  notes?: string;
}
```

`onComplete` fires once when the model emits the completion envelope. The returned step's output mirrors the final state for callers that prefer return-value style over the callback.

### compilePlan / adaptivePlan

Dynamic multi-agent task trees.

```typescript
compilePlan<O>(
  plan: PlanNode,
  agents: Record<string, (prompt: string) => Step>,
  constraints?: PlanConstraints,
  executeStep?: ExecuteStepFn,
): Step

adaptivePlan<O>({
  planner, agents, constraints, maxRevisions, executeStep?,
}): Step
```

**Important:** When plans mix sequential and parallel execution (e.g., a fork inside a sequential chain), `executeStep` must be provided. Without it, only `run`-kind children can be executed in sequential nodes. When using the eval framework, the agent harness's `run` method serves as `executeStep`:

```typescript
// callModel auto-detected from OPENROUTER_API_KEY when omitted
const harness = new AgentHarness({ name: 'planner', params: {} });
const compiled = compilePlan(plan, agents, undefined, harness.run.bind(harness));
```

## Memory Layers

### workingMemory

Thread/resource-scoped structured state, updated via `updateWorkingMemory` tool call.

```typescript
workingMemory({ scope?, schema?, template?, readOnly? })
```

### observationalMemory

Accumulates text, distills to observations when buffer exceeds threshold.

```typescript
observationalMemory({ bufferThreshold?, maxObservations?, scope?, observer? })
```

### durableTaskState

Persists file lists and checkpoints across executions.

```typescript
durableTaskState({ baseDir?, gitCommit?, schema?, serializer? })
```

### staticContent

Loads content at init, injects as tagged XML block in every recall.

```typescript
staticContent({ load: () => Promise<string>, tag?, id?, slot?, scope? })
```

### historyWindow

Caps the trailing items projected to the LLM each turn. Storage (`itemLog`, session JSON) is untouched — the cap is a read-side projection via the `projectHistory` hook. Defaults to `maxItems: 40`. Includes a minimum-exchange guarantee (always preserves at least one user + one assistant message) and strips orphan `function_call` / `function_call_output` at the slice boundary.

```typescript
historyWindow({ maxItems?: number })  // default 40
```

### toolMemoryLayer

Generates layers from `ToolMemoryDeclaration` on tools. Tools sharing the same `memory.id` share state. Defaults to `'execution'` scope.

```typescript
toolMemoryLayer(tools: Tool[], opts?: { slot? })
```

### createSteeringFileLayer (`@noetic/cli`)

Surfaces a per-task `steering.md` file to the agent run servicing that task. The harness factory mounts it unconditionally; activation is gated by the `NOETIC_TASK_DIR` env var that the task launcher sets when spawning agent-ci for a specific task. Non-task agent runs see no steering content.

```typescript
import { createSteeringFileLayer } from '@noetic/cli/src/memory/steering-file-layer.js';

const layer = createSteeringFileLayer();
// slot:  Slot.STEERING (90) — ahead of working memory and observations
// scope: 'execution'
// budget: { min: 0, max: 8000 }
```

Behaviour:

- When `process.env.NOETIC_TASK_DIR` is unset or empty, `recall()` returns `null` and the layer is dormant.
- When set, `recall()` reads `<NOETIC_TASK_DIR>/steering.md` via `ctx.fs.readFileText`. ENOENT and empty content both yield `null` (no steering content).
- A non-empty `steering.md` is wrapped in a `# Task Steering` heading and emitted as a developer-role block.

The layer carries no state (`state: null`); everything is resolved at recall time, so a steering file edited mid-session takes effect on the next recall. See `specs/21-tasks.md` for the full task-system contract.

### createFixFeedbackLayer (`@noetic/cli`)

Thread-scoped layer that carries the implementer's retry-feedback bundle (parent-task plan, description, accumulated assertion failures, attempt count) across iterations of the implementer↔validator retry loop.

```typescript
import { createFixFeedbackLayer } from '@noetic/cli/src/commands/builtins/tasks/memory/fix-feedback-layer.js';

const layer = createFixFeedbackLayer({
  initial: { plan, description, accumulatedIssues, attempt: 1 },
});
// slot:  Slot.WORKING_MEMORY (100)
// scope: 'thread'
// recall(): emits a developer-role "# Implementation context" block when state is non-empty.
// provides.update: layerFn that merges new feedback (plan/description/issues/attempt).
// onSpawn: clones parent state to the child so a sub-flow inherits the bundle.
```

The implementer-runner seeds this layer's `initial` from disk (parent task description + accumulated `assertionOutcomes` from prior validator runs in the feature's fix lineage), so each retry's react loop sees prior failures via `recall()` without depending on chat-history continuation.

### createPlannerAttemptLayer (`@noetic/cli`)

Resource-scoped layer that tracks per-task planner-attempt counts and persists them to `<projectRoot>/.noetic/tasks/_planner-attempts.json`. The autopilot's plan-pass reads the file directly to gate retry budget; the planner subprocess increments via `recordAttempt`.

```typescript
import { createPlannerAttemptLayer, MAX_PLANNER_ATTEMPTS } from '@noetic/cli/src/commands/builtins/tasks/memory/planner-attempt-layer.js';

const layer = createPlannerAttemptLayer({ projectRoot, maxAttempts? });
// slot:  Slot.REMINDER (80) — code-only, no recall surface
// scope: 'resource'
// provides.snapshot: layerData → { attempts, maxAttempts }
// provides.recordAttempt: layerFn → increment + persist
// provides.clearAttempts: layerFn → drop a task's counter
```

`MAX_PLANNER_ATTEMPTS` (default 3) caps re-spawns per task so a permanently-failing planner can't burn unbounded LLM tokens on the autopilot's 60-second tick.

### ToolMemoryDeclaration

Declared on a `Tool`'s `memory` property. The runtime auto-generates a `MemoryLayer` per unique `id`.

```typescript
interface ToolMemoryDeclaration<TState = unknown> {
  id?: string;                              // shared id (defaults to tool.name)
  init: () => TState;                       // factory for initial state
  recall: (state: TState) => string | null; // project into LLM context
}
```

Tools read/write state imperatively via `toolCtx.memory`:

```typescript
interface ToolMemory {
  get<T>(layerId: string): T | undefined;
  set<T>(layerId: string, state: T): void;
}
```

### findFunctionCall

Utility for function-call memory patterns. Searches items for the first `function_call` matching a name, returns parsed JSON arguments.

```typescript
import { findFunctionCall } from '@noetic/core';

const args = findFunctionCall(newItems, 'updateWorkingMemory');
// Returns Record<string, unknown> | null
```

Used in `store()` hooks to let the LLM update layer state via pseudo-tool calls (no registered tool schema required).

### steering

Intercepts tool calls and model responses via programmatic or LLM-evaluated rules. Maintains an activity ledger. Slot 90 (runs before all other layers).

```typescript
steering({
  rules: SteeringRule[];
  maxLedgerEntries?: number;  // default 100
  maxRetries?: number;        // default 3
  scope?: MemoryScope;        // default 'execution'
}): MemoryLayer<SteeringState>
// LLM-evaluated rules use callModel from the execution context (configured
// via AgentHarness's `llm` option or OPENROUTER_API_KEY). If no LLM provider
// is configured, LLM-evaluated rules throw NoeticConfigError (MISSING_CALL_MODEL).
```

**SteeringRule:**
```typescript
interface SteeringRule {
  id: string;
  name?: string;
  appliesTo: ('beforeToolCall' | 'afterModelCall')[];
  predicate?: (params: BeforeToolCallParams | AfterModelCallParams) => SteeringDecision;
  llmEval?: { mode: 'sync' | 'async'; prompt: string; model?: string };
}
```

**SteeringAction:** `Allow`, `Deny`, `Guide` — `Deny` short-circuits, `Guide` injects feedback.

**Lifecycle hooks:** `beforeToolCall` (intercept tools), `afterModelCall` (validate responses), `recall` (inject async feedback), `onSpawn` (clone ledger).

### planMemory

Manages PRD authoring and plan execution lifecycle. Enters a restricted "plan mode" where only read-only tools are allowed, the LLM writes a PRD and structures a PlanNode tree, then exits to execution.

```typescript
planMemory({
  scope?: MemoryScope;                    // default 'thread'
  additionalAllowedTools?: string[];      // extra tools allowed in plan mode
  maxPrdLength?: number;                  // default 50_000
  maxTreeDepth?: number;                  // default 5
}): MemoryLayer<PlanState>
```

**State:** `{ phase, prd, planTree, executionLog, version }`. Phase transitions: `idle → planning → executing → completed/failed`.

**Provides (auto-exposed as LLM tools):**
- `plan/enterPlanMode({ goal? })` — transitions idle → planning, optionally seeds PRD
- `plan/updatePrd({ content })` — replaces PRD content (planning phase only)
- `plan/setPlanTree(PlanNode)` — sets execution tree (validated against PlanNodeSchema)
- `plan/exitPlanMode({ action: 'execute' | 'cancel' })` — exits plan mode
- `status` (layerData) — `{ phase, hasPrd, hasPlanTree, version }`

**Lifecycle hooks:** `init` (load from storage), `recall` (phase-dependent context injection), `beforeToolCall` (restrict to read-only in planning), `onSpawn` (clone state), `onComplete` (record outcome).

## Layer Provides API

Layers expose typed data and functions via the `provides` field. Data becomes direct properties and functions become async methods on `ctx.memory['layerId']`. Functions are also automatically injected as LLM tools (namespaced `layerId/fnName`).

### memory()

Wraps a layer tuple for type-safe inference. Uses `const` type parameter to preserve literal types without `as const`.

```typescript
memory<const T extends readonly MemoryLayer[]>(layers: T): MemoryConfig<T>
```

### InferMemory\<T\>

Extracts the typed memory shape from a `MemoryConfig` (like `z.infer<>` for Zod).

```typescript
const mem = memory([workingMemory(), counterLayer()]);
type Mem = InferMemory<typeof mem>;
// Use as: step.run<Mem>({ execute: (input, ctx) => { ctx.memory.counter.value } })
```

### MemoryConfig

Typed wrapper preserving individual layer types for compile-time inference.

```typescript
interface MemoryConfig<TLayers extends readonly MemoryLayer[] = readonly MemoryLayer[]> {
  readonly layers: TLayers;
  readonly _shape: InferMemoryShape<TLayers>;  // phantom — never accessed at runtime
}
```

### layerData

Creates a read-only data projection from layer state.

```typescript
layerData<T, TState>({
  read: (state: TState) => T;
}): LayerDataDecl<T, TState>
```

### layerFn

Creates a callable function backed by layer state. Input is Zod-validated at runtime.

```typescript
layerFn<TInput, TOutput, TState>({
  description: string;
  input: ZodType<TInput>;
  output: ZodType<TOutput>;
  execute: (args: TInput, state: TState, ctx: ExecutionContext)
    => Promise<{ result: TOutput; state?: TState }>;
}): LayerFunctionDecl<TInput, TOutput, TState>
```

### ctx.memory

Layer provides keyed by layer ID. Data entries are live property reads; function entries are async callable methods.

```typescript
const mem = memory([workingMemory()]);
type Mem = InferMemory<typeof mem>;

step.run<Mem>({
  id: 'work',
  execute: async (input, ctx) => {
    ctx.memory['working-memory'].snapshot;        // WorkingMemoryState (live read)
    await ctx.memory['working-memory'].update({ k: 1 }); // calls layerFn, updates state
  },
});
```

### Automatic LLM tool injection

Layer functions in `provides` are automatically exposed as tools to any `step.llm` running in the same context. Tool names are `layerId/functionName` (e.g. `working-memory/update`).

## CwdState (shared cwd)

Every `Context` carries a mutable `cwdState: CwdState` that tools resolve relative paths against at execution time. The Bash tool intercepts plain `cd <path>` and mutates the shared state via `setToolCwd`; subsequent Read, Write, Edit, Ls, Grep, Find, lsp, and InteractiveTerminal calls see the new cwd. Spawned/forked children get a snapshot (POSIX-fork semantics).

```typescript
interface CwdState {
  cwd: string;            // absolute path
  previousCwd?: string;   // populated on cd; powers `cd -`
}

// Read live cwd from a tool's execute function. Pass the factory cwd as a
// fallback for partial test contexts.
function getToolCwd(ctx: Context | undefined, fallback?: string): string;

// Update the shared cwd. Caller must pass an absolute, validated path.
function setToolCwd(ctx: Context, nextCwd: string): { previousCwd: string; newCwd: string };

// Internal: temporarily retarget cwd so an immediately-following spawn
// snapshots the new value. Returns a restore callback. Used by worktree
// isolation in the sync agent-spawn path.
function retargetCwdForSpawn(ctx: Context, nextCwd: string): () => void;
```

`AgentHarness` exposes `rootCwdState` (the shared object seeded into root contexts) and `setRootCwd(nextCwd)` for hosts (e.g. the TUI) to report a user-issued `!cd`.

`AgentHarness` constructor accepts `initialCwd?: string` (default `process.cwd()`), and both `createContext({ cwdInit })` and `detachedSpawn(..., { cwdInit })` accept a per-context override used by worktree isolation.

The mutation policy's `sessionCwd` is anchored to the launch cwd and does NOT follow agent `cd` — `cd` is a UX convenience, not a sandbox-widening mechanism.

## FsAdapter

Filesystem abstraction used by the harness, tools, memory layers, and skill discovery. Defaults to `createLocalFsAdapter()` (Node.js `fs/promises`).

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
  writeFileBytes(path: string, content: Buffer): Promise<void>;  // binary-safe write
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

Pass a custom adapter to the harness:

```typescript
import { AgentHarness, createLocalFsAdapter } from '@noetic/core';

const harness = new AgentHarness({
  name: 'my-agent',
  params: {},
  fs: myCustomFsAdapter,  // optional, defaults to createLocalFsAdapter()
});
```

Access from tools and layers:

```typescript
// In a tool execute function:
tool({
  name: 'read-config',
  execute: async (args, toolCtx) => {
    const content = await toolCtx.fs.readFileText('/etc/config.json');
    return JSON.parse(content);
  },
});

// In a memory layer hook:
hooks: {
  async init({ ctx }) {
    const data = await ctx.fs.readFileText('./state.json');
    return { state: JSON.parse(data) };
  },
}

// From Context in a step:
step.run({
  id: 'load',
  execute: async (input, ctx) => {
    return ctx.fs.readFileText('./data.txt');
  },
});
```

## ShellAdapter

Shell execution abstraction used by the harness, tools, memory layers, and skill processing. Defaults to `createLocalShellAdapter()` (Bun.spawn). The `@noetic/cli` package also provides `createEmulatedShellAdapter(fs)` backed by `just-bash` for sandboxed environments.

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

Pass a custom adapter to the harness:

```typescript
import { AgentHarness, createLocalShellAdapter } from '@noetic/core';

const harness = new AgentHarness({
  name: 'my-agent',
  params: {},
  shell: myCustomShellAdapter,  // optional, defaults to createLocalShellAdapter()
});
```

Access from tools and layers:

```typescript
// In a tool execute function:
tool({
  name: 'run-lint',
  execute: async (args, toolCtx) => {
    const result = await toolCtx.shell.exec('eslint .', { cwd: '/app' });
    return result.stdout;
  },
});

// In a memory layer hook:
hooks: {
  async init({ ctx }) {
    const result = await ctx.shell.exec('git rev-parse HEAD', { cwd: '.' });
    return { state: { commitHash: result.stdout.trim() } };
  },
}
```

## AgentHarness

`AgentHarness` is generic over `TParams`. The `config` property exposes `AgentConfig<TParams>`, and steps/tools access params via `ctx.harness.config.params`. The `fs` property exposes the `FsAdapter` (defaults to `createLocalFsAdapter()`). The `shell` property exposes the `ShellAdapter` (defaults to `createLocalShellAdapter()`).

### Sessions and the Message Queue

Each `threadId` is a **session**: a long-lived broadcaster + message queue + item log carried across turns. `execute()` enqueues a message on the session identified by `options.threadId` (or a default thread) and returns `Promise<void>` once the message is accepted. Response is observed via session-scoped accessors.

```typescript
const harness = new AgentHarness({
  name: 'my-agent',
  initialStep: myStep,
  params: { model: 'anthropic/claude-sonnet-4-20250514' },
  defaultDeliveryMode: 'next-turn',
});

// Queue a message and wait for the response.
await harness.execute('Hello');
const response = await harness.getAgentResponse();

// Stream text deltas across every turn in the session.
for await (const delta of harness.getTextStream()) {
  process.stdout.write(delta);
}

// With options (per-thread routing + delivery mode override).
await harness.execute('Hello', {
  threadId: 'thread-1',
  resourceId: 'user-1',
  deliveryMode: 'between-rounds',
});

// Submit while the agent is generating — the message queues.
await harness.execute('follow-up', { threadId: 'thread-1' });

// Cancel the in-flight turn. Queued messages stay and drive the next turn.
await harness.abort({ threadId: 'thread-1', reason: 'user' });

// Preview the items that would be sent on the next turn — accumulated history
// plus harness-level memory layer recall outputs. Read-mostly debug helper for
// inspecting "what the model will see"; safe to call between turns.
const items = await harness.previewRequestItems({ threadId: 'thread-1' });
```

### Delivery Modes

| Mode | Behaviour |
|------|-----------|
| `next-turn` (default) | Queue and run after the current turn completes. |
| `between-rounds` | Inject as a user item before the next tool-round LLM call within the active turn. |
| `interrupt` | Abort the in-flight turn, place message at head of queue, restart. |

### Stream Idle Timeout

`AgentHarnessOpts.streamIdleTimeoutMs` (default `120_000`; set `0` or negative to disable) aborts an in-flight provider call if its SSE stream emits no events for that many milliseconds. On timeout, the harness emits `{name}:llm_call_stalled` and the surrounding turn fails with `turn_aborted { reason: "llm stream idle timeout after <N>ms" }`. Use a smaller value for snappier recovery in interactive UIs, a larger value for long-running batch runs with slow models.

### Session Accessors

| Method | Description |
|--------|-------------|
| `getAgentResponse(scope?)` | Resolves once the session drains its queue. |
| `getItemStream(scope?)` | Cumulative item snapshots across every turn. |
| `getTextStream(scope?)` / `getReasoningStream(scope?)` | Text / reasoning deltas. |
| `getFullStream(scope?)` | Raw SDK + framework events. |
| `abort(scope?)` | Cancel in-flight turn; queued messages preserved. |
| `getStatus(scope?)` | `{ kind: 'idle' \| 'generating' \| 'aborting' }`. |
| `getQueueSize(scope?)` | Count of queued messages. |

Subscribe to streams before the first `execute()` if you want to observe the very first turn — the session broadcaster replays buffered events to late subscribers within its buffer window.

### Low-Level API

```typescript
// Manual context creation + run() (bypasses the session queue)
const ctx = harness.createContext({ threadId: 'thread-1' });
const runResult = await harness.run(step, input, ctx);

// Background execution (inherits parent's threadId by default)
const handle = harness.detachedSpawn(step, input, ctx);
await handle.await();

// Background execution with isolated session log (does NOT pollute parent's
// `session.accumulatedItems` — use for long-running sub-agents)
const isolatedHandle = harness.detachedSpawn(step, input, ctx, {
  threadId: 'background-task-1',
});

// Channels
harness.send(channel, value, ctx);
const msg = await harness.recv(channel, ctx);
const msg2 = harness.tryRecv(channel, ctx);
```

## Slot Constants

```typescript
const Slot = {
  REMINDER: 80,
  STEERING: 90,
  WORKING_MEMORY: 100,
  ENTITY: 150,
  OBSERVATIONS: 200,
  PROCEDURAL: 250,
  EPISODIC: 300,
  RAG: 350,
  SEMANTIC_RECALL: 400,
} as const;
```

**`Slot.REMINDER` (80)** is reserved for layers that inject `<system-reminder>`-wrapped developer messages (turn-counter-throttled nags, plan-mode reminders, error-recovery hints). Reminder-slot layers maintain their own state and emit before any steering guidance.

## Cross-layer state reads

`ExecutionContext.readLayerState<T>(layerId)` returns a sibling layer's current state (or `undefined`). Used when a layer needs to inspect another layer's progress — e.g. the CLI reminder layer reads `plan-memory` to know whether plan mode is active:

```typescript
const plan = ctx.readLayerState<{ session?: { mode?: string } }>('plan-memory');
if (plan?.session?.mode === 'planning') {
  // emit a plan-mode reminder
}
```

Treat returned values as read-only.

## CLI-specific memory layers

These are shipped by `@noetic/cli` on top of the core framework:

### `reminderLayer(opts)`

```typescript
import { reminderLayer, createReminderRegistry, BUILTIN_TRIGGERS } from '@noetic/cli';

const registry = createReminderRegistry();
for (const t of BUILTIN_TRIGGERS) registry.register(t);
registry.register({
  id: 'my-custom',
  minTurnsBetweenReminders: 10,
  timing: 'recall',
  shouldFire: ({ state }) => state.toolUsageCounts.get('Bash')! > 15 ? 'heavy Bash usage — consider dedicated tools' : null,
});

const layer = reminderLayer({ registry });
```

Emits `<system-reminder>`-wrapped developer messages based on registered triggers. `timing: 'recall'` fires on next turn; `timing: 'immediate'` fires via `onItemAppend` for faster reactivity.

### `agentMdLayer(opts)`

```typescript
import { agentMdLayer, loadAgentInstructions } from '@noetic/cli';

const instructions = await loadAgentInstructions({ cwd, fs });
const layer = agentMdLayer({ loader: () => Promise.resolve(instructions) });
```

Surfaces `AGENT.md`, `.agent/rules/*.md`, and ancestor/user-global instruction files. Supports `@path.md` imports and skills-style `!command` inline execution (user-origin always; project-origin gated by `config.trustProjectEmbeddedCommands`). See `specs/12a-cli-memory-layers.md` for full discovery order.

## CLI-specific tools

These are shipped by `@noetic/cli` on top of the core framework.

### `taskTools(opts)` — Task management

The `task_*` tool prefix gives agents 1:1 parity with the `noetic tasks <verb>` CLI. Tools are registered by the harness factory and are **default-on**; opt out via `tools.tasks: false` in `noetic.config.ts`. A read-only variant exposes only `task_show`, `task_list`, and `task_logs` — used in planning mode and other contexts where the agent must observe but not mutate.

```typescript
import { taskTools } from '@noetic/cli/src/commands/builtins/tasks/tools.js';
import type { TaskStoreContext } from '@noetic/cli/src/commands/builtins/tasks/fs-store.js';

const ctx: TaskStoreContext = { fs, projectRoot };

// Full task surface (mutators + queries).
const tools = taskTools({ ctx });

// Read-only — only task_show, task_list, task_logs.
const ro = taskTools({ ctx, readOnly: true });
```

All tools resolve tasks by their `T-<10 chars>` id and return JSON-shaped objects. Each tool delegates to the same handler the CLI verb uses, so behaviour is identical across surfaces. Storage layout, atomicity guarantees, and lifecycle semantics are spelled out in `specs/21-tasks.md`.

#### Identity & state types

```typescript
type TaskSource = 'manual' | 'worktree';
type TaskReviewStatus = 'not_started' | 'reviewing' | 'needs_changes' | 'approved';
type TaskLifecycleStatus = 'active' | 'merged' | 'cleanup-blocked' | 'removed';
type KanbanColumn =
  | 'triage' | 'in_progress' | 'needs_changes' | 'ready_to_merge'
  | 'done' | 'cleanup_blocked' | 'removed' | 'archived';
```

Hierarchy entities use the same `<prefix>-<10 chars>` shape with prefixes `ML` (milestone), `SL` (slice), `F` (feature), `A` (assertion), `V` (validator run), `FX` (fix lineage), `IV` (interview session).

#### Mutating tools

```typescript
// task_create — create a manual task. Optional description seeds description.md.
input:  { title: string; description?: string }
output: { task: Task }

// task_move — atomic kanban move. Computes the minimum patch across
// archivedAt / lifecycleStatus / reviewStatus.
input:  { taskId: string; column: KanbanColumn }
output: { task: Task }

// task_merge — try `wt merge <branch>`; fall back to `git merge` if `wt`
// is missing. Both paths emit task:reviewStatusChanged on success.
input:  { taskId: string; branch?: string }
output: { task: Task; via: 'wt' | 'git' }

// task_log / task_comment / task_steer — append to log.jsonl. `task_steer`
// also writes/appends steering.md (read by the steering memory layer when
// NOETIC_TASK_DIR points at this task).
input:  { taskId: string; message: string }
output: { entry: LogEntry }     // task_log, task_comment
output: { entry: LogEntry; steeringPath: string }  // task_steer

// task_attach — copy a file into <taskDir>/attachments/.
input:  { taskId: string; sourcePath: string }
output: { taskId: string; destinationPath: string }

// task_pause / task_unpause — toggle pause on the active agent-ci runner.
input:  { taskId: string }
output: { outcome: 'paused' | 'already_paused' | 'no_runner' | 'resumed' | 'already_running' }

// task_archive / task_unarchive — set/clear archivedAt.
input:  { taskId: string }
output: { task: Task }

// task_delete — hard-delete the task directory; emits task:archived
// before the rm -rf.
input:  { taskId: string }
output: { taskId: string; deleted: true }

// task_duplicate — copy task.json + description.md + attachments under a new id.
input:  { taskId: string; title?: string }
output: { task: Task }
```

#### Hierarchy tools

```typescript
// task_plan — run the live AI-driven interview to build a hierarchy.
// TUI-only; throws in headless contexts because the interview asks the
// user multiple-choice questions through AskUserService.
input:  { taskId: string; description?: string }
output: { taskId: string; hierarchy: TaskHierarchy }

// task_add_milestone — append a milestone.
input:  { taskId: string; title: string; verification: string; description?: string }
output: { milestone: Milestone }

// task_add_slice — append a slice under a milestone.
input:  { taskId: string; milestoneId: string; title: string; verification: string; description?: string }
output: { slice: Slice }

// task_add_feature — append a feature under a slice.
input:  { taskId: string; sliceId: string; title: string; acceptanceCriteria: string; description?: string }
output: { feature: Feature }

// task_add_assertion — append an assertion under a milestone, optionally
// covering specific feature ids.
input:  { taskId: string; milestoneId: string; title: string; assertion: string; featureIds?: string[] }
output: { assertion: Assertion }

// task_activate_slice — mark a slice 'active'; with triage:true, also
// triages every defined feature into a leaf task under the same parent.
input:  { taskId: string; sliceId: string; triage?: boolean }
output: { outcome: { sliceId: string; triagedFeatureIds: string[] } }

// task_autopilot — toggle the autopilot flag for a structured task.
input:  { taskId: string; enabled: boolean }
output: { task: Task }
```

#### Read-only tools

```typescript
// task_show — full record + recent log + hierarchy summary if present.
input:  { taskId: string; logTail?: number }
output: { task: Task; recentLog: LogEntry[]; hierarchy: TaskHierarchy | null }

// task_list — filterable list. Without filters, returns active tasks for
// the current project; --all surfaces archived too.
input:  {
  column?: KanbanColumn;
  source?: TaskSource;
  all?: boolean;
}
output: { tasks: Task[] }

// task_logs — tail of the most recent log entries.
input:  { taskId: string; n?: number }   // default n=50
output: { entries: LogEntry[] }
```

The full set is 23 tools, mirroring the 23 mutating + read CLI verbs (everything except `--help`). See `specs/21-tasks.md` for the verb table and the complete `Task` / `Milestone` / `Slice` / `Feature` / `Assertion` / `ValidatorRun` / `FixLineage` / `InterviewSession` schemas.

## Memory Layer Hooks

### onItemAppend

Called when input items (user messages, tool outputs) are about to be appended to the ItemLog. Enables middleware-style item transformation and context re-rendering.

```typescript
interface OnItemAppendParams<TState> {
  items: Item[];         // Items to be appended (may be transformed by prior layers)
  log: ItemLog;          // Full log (read-only)
  ctx: ExecutionContext;
  state: TState;
}

interface OnItemAppendResult<TState> {
  items: Item[];           // Items to append (filter, transform, or inject)
  state?: TState;          // Updated layer state
  rerender?: boolean;      // Request context re-render
  timing?: 'immediate' | 'batched';  // When to apply re-render
  scope?: RerenderScope;   // Which layers to re-recall
}

type RerenderScope = 'self' | 'slot-after' | 'all';  // default: 'slot-after'
```

**Pipeline behavior:** Items flow through layers in slot order. Each layer receives the output of the previous layer. Returning an empty array stops the pipeline.

**Re-render triggers:** When `rerender: true`, the harness re-runs `recall()` for affected layers based on `scope`:
- `'self'`: Only the triggering layer
- `'slot-after'`: Triggering layer and all higher-slot layers (default)
- `'all'`: All layers

**Layer configuration:**
```typescript
interface MemoryLayer<TState> {
  // ... other fields
  rerenderTiming?: 'immediate' | 'batched';  // default for this layer's re-renders
}
```

**Example: Content filtering**
```typescript
const contentFilter = {
  id: 'filter',
  slot: Slot.STEERING - 10,
  scope: 'execution',
  hooks: {
    async init() { return { state: null }; },
    async onItemAppend({ items }) {
      return {
        items: items.map(item => ({
          ...item,
          content: redactSensitive(item.content),
        })),
      };
    },
  },
} satisfies MemoryLayer<null>;
```

**Example: Keyword-triggered context injection**
```typescript
const keywordWatcher = {
  id: 'keyword-watcher',
  slot: Slot.STEERING + 5,
  scope: 'execution',
  rerenderTiming: 'immediate',
  hooks: {
    async init() { return { state: { docs: [] } }; },
    async onItemAppend({ items, state }) {
      const keywords = extractKeywords(items);
      if (keywords.length === 0) return { items };
      
      const docs = await fetchRelevantDocs(keywords);
      return {
        items,  // pass through unchanged
        state: { docs },
        rerender: true,
        scope: 'self',
      };
    },
    async recall({ state }) {
      return {
        items: state.docs.map(d => createMessage(d.content, 'developer')),
        tokenCount: estimateTokens(state.docs),
      };
    },
  },
} satisfies MemoryLayer<{ docs: Doc[] }>;
```

## Per-Layer Context Usage (`ctx.lastLayerUsage`)

After every successful `callModel`, the runtime records a snapshot of how the context window decomposed across its contributors and stores it on `ctx.lastLayerUsage`. The same snapshot is mirrored on `HarnessResponse.lastLayerUsage` for callers that have already released the `Context`.

```typescript
interface LayerUsageEntry {
  readonly layerId: string;
  readonly tokenCount: number;
  readonly items: ReadonlyArray<Item>;
}

interface LastLayerUsage {
  readonly executionId: string;
  readonly modelId: string;
  readonly layers: ReadonlyArray<LayerUsageEntry>; // sorted by layerId
  readonly systemPromptTokens: number;
  readonly toolsTokens: number;
  readonly historyTokens: number;
  readonly totalUsedTokens: number;
}
```

- `layers[i].tokenCount` comes from each memory layer's own `recall()` `tokenCount`.
- The other three buckets are estimated via the framework's 4-chars-per-token heuristic.
- Use this to power introspection UIs (e.g., the CLI `/context` command). The snapshot is overwritten on the next call — export to your span if you need historical retention.

## ToolExecutionContext

Available inside tool `execute` functions:

```typescript
interface ToolExecutionContext {
  ctx: Context;                 // Step execution context (ctx.harness also available)
  harness: AgentHarness;        // AgentHarness instance (guaranteed non-undefined)
  fs: FsAdapter;                // Filesystem adapter (from harness)
  shell: ShellAdapter;          // Shell adapter (from harness)
  memory: ToolMemory;           // Per-layer state accessor (get/set by layer id)
  assembledView: Item[];        // Current conversation view
  lastStepMeta: StepMeta | null;
}
// Access harness params: toolCtx.harness.config.params
// Or via context: toolCtx.ctx.harness.config.params
// Filesystem: toolCtx.fs.readFileText('/path')
```

## CLI Plugin Hooks

Plugins loaded by `@noetic/cli` implement the `NoeticPlugin` interface
(`packages/cli/src/plugins/types.ts`). The hooks below aggregate contributions
from every loaded plugin alongside the CLI's built-ins.

### `lspServers?(ctx): ReadonlyArray<LspServerContribution>`

Register additional language servers beyond the four builtins (TypeScript/JavaScript,
Python, Go, Swift). Contributions share the same extension index as the
builtins — a plugin can **override** a builtin by reusing its `id`, or **add**
a new language by claiming a novel extension.

```typescript
import type { LspServerContribution } from '@noetic/cli';

export default {
  name: 'my-rust-lsp',
  version: '1.0.0',
  lspServers: () => [
    {
      id: 'rust-analyzer',
      extensions: ['.rs'],
      rootMarkers: ['Cargo.toml', 'rust-project.json'],
      launch: {
        strategy: 'githubRelease',
        owner: 'rust-lang',
        repo: 'rust-analyzer',
        asset: (platform, arch) =>
          `rust-analyzer-${arch}-${platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu'}.gz`,
        args: [],
      },
    },
  ],
} satisfies NoeticPlugin;
```

**`LaunchSpec` strategies** (pick one per contribution):

| strategy | use for | spawn behavior |
|---|---|---|
| `path` | toolchain-distributed binaries (gopls, sourcekit-lsp, rust-analyzer installed via rustup) | `which <bin>`; errors with `installHint` if absent |
| `bunx` | npm-distributed servers (typescript-language-server, pyright-langserver) | `bunx <bin> <args>` — zero-install |
| `githubRelease` | standalone prebuilt binaries | download from GitHub release, cache in `~/.noetic/lsp/<id>/<version>/`. Gated by `NOETIC_DISABLE_LSP_DOWNLOAD=1` |

**Conflict policy**: same `id` → plugin overrides builtin. Different `id` but
overlapping extension → first-registered wins (builtins register before
plugins). The single model-facing tool (`lsp`) stays constant — the operation
list, schemas, and output format never change across contributions.
