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

### promptEngineeringLayer

Core behavioral guidelines with tool usage tracking and error-based adaptation. Part of the CLI's enhanced prompt engineering system (`@noetic/cli`).

```typescript
function promptEngineeringLayer(): MemoryLayer<PromptEngineeringState>
```

| Property | Value |
|----------|-------|
| **id** | `prompt-engineering` |
| **slot** | `Slot.PROCEDURAL` (250) |
| **scope** | `execution` |
| **budget** | `{ min: 200, max: 1000 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn` |

Recall injects communication efficiency rules, tool-usage reminders based on frequency, and error-recovery guidance when recent errors exist. Store tracks tool call frequencies and detects error signatures in tool results. Spanw clones patterns and clears error history.

### communicationStyleLayer

Adaptive communication patterns (concise/normal/verbose) based on user message analysis. Part of the CLI's enhanced prompt engineering system (`@noetic/cli`).

```typescript
function communicationStyleLayer(): MemoryLayer<CommunicationStyleState>
```

| Property | Value |
|----------|-------|
| **id** | `communication-style` |
| **slot** | `Slot.PROCEDURAL` (250) |
| **scope** | `execution` |
| **budget** | `{ min: 150, max: 500 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn` |

Recall renders style-specific communication guidelines. Store analyzes user messages for question markers, technical keywords, and preference indicators, then adapts the style accordingly. Spanw clones style and preferences, resets metrics.

### environmentContextLayer

Dynamic environment detection providing platform, git, Node.js, shell, and package-manager context. Part of the CLI's enhanced prompt engineering system (`@noetic/cli`).

```typescript
interface EnvironmentContextConfig {
  config: AgentConfig;
  shell: ShellAdapter;
}

function environmentContextLayer(config: EnvironmentContextConfig): MemoryLayer<EnvironmentContextState>
```

| Property | Value |
|----------|-------|
| **id** | `environment-context` |
| **slot** | `Slot.OBSERVATIONS` (200) |
| **scope** | `execution` |
| **budget** | `{ min: 200, max: 800 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn` |

Init probes the environment via the shell adapter (git, node, shell type, package manager, available commands) in parallel with individual timeouts. Recall formats into a structured context block. Store is pass-through (environment treated as static). Spanw clones context with updated timestamp.

### toolGuidanceLayer

Context-aware tool usage instructions with preference hierarchy and mode awareness. Part of the CLI's enhanced prompt engineering system (`@noetic/cli`).

```typescript
interface ToolGuidanceConfig {
  tools: ReadonlyArray<Tool>;
  mode?: 'normal' | 'planning';
}

function toolGuidanceLayer(config: ToolGuidanceConfig): MemoryLayer<ToolGuidanceState>
```

| Property | Value |
|----------|-------|
| **id** | `tool-guidance` |
| **slot** | `Slot.PROCEDURAL` (250) |
| **scope** | `execution` |
| **budget** | `{ min: 300, max: 1200 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn` |

Recall emits a tool preference hierarchy (e.g. "Use Read tool, NOT cat/head/tail"), file operation guidelines, and mode-specific guidance. In planning mode, includes plan tool restrictions. If agent delegation tools are available, adds delegation guidelines. Spanw clones tool set and mode, resets failure history.

### planningModeLayer

Specialized guidance for plan-mode operations with FlowSchema integration and phase tracking. Part of the CLI's enhanced prompt engineering system (`@noetic/cli`).

```typescript
interface PlanningModeConfig {
  availableTools: ReadonlyArray<Tool>;
  currentMode: 'normal' | 'planning';
}

function planningModeLayer(config: PlanningModeConfig): MemoryLayer<PlanningModeState>
```

| Property | Value |
|----------|-------|
| **id** | `planning-mode` |
| **slot** | `Slot.PROCEDURAL` (250) |
| **scope** | `execution` |
| **budget** | `{ min: 400, max: 1500 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn` |

Recall returns null when not active. When active, injects FlowSchema node type guidelines (llm, subagent, fork, spawn, sequence), PRD authoring best practices with a plan.md template, plan-mode tool restrictions, phase-specific objectives (exploration/authoring/review), and exploration progress. Store counts Read calls to auto-transition phases. Spanw clones state, resets progress.

### skillsLayer (CLI Enhanced)

Progressive skill disclosure with integrated behavioral guidelines and inline command processing. Part of `@noetic/cli`.

```typescript
interface SkillsLayerConfig {
  cwd: string;
}

function skillsLayer(
  skills: SkillDefinition[],
  config: SkillsLayerConfig,
): MemoryLayer<SkillsLayerState>
```

| Property | Value |
|----------|-------|
| **id** | `skills-memory` |
| **slot** | `Slot.PROCEDURAL` (250) |
| **scope** | `execution` |
| **budget** | `{ min: 300, max: 2000 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn` |

Recall lists model-invocable skills as `<available_skills>` when none are activated. Upon activation, injects behavioral guidelines and full skill instructions. Store detects `activateSkill` calls, processes inline shell commands (`!`), and caches results (LRU, max 50). Spanw clones cache to child.

### toolMemoryLayer

Generates layers from `ToolMemoryDeclaration` on tools. Tools sharing the same `memory.id` share state. Defaults to `'execution'` scope.

```typescript
toolMemoryLayer(tools: Tool[], opts?: { slot? })
```

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
  mkdir(dir: string): Promise<void>;
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
```

### Delivery Modes

| Mode | Behaviour |
|------|-----------|
| `next-turn` (default) | Queue and run after the current turn completes. |
| `between-rounds` | Inject as a user item before the next tool-round LLM call within the active turn. |
| `interrupt` | Abort the in-flight turn, place message at head of queue, restart. |

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

// Background execution
const handle = harness.detachedSpawn(step, input, ctx);
await handle.await();

// Channels
harness.send(channel, value, ctx);
const msg = await harness.recv(channel, ctx);
const msg2 = harness.tryRecv(channel, ctx);
```

## Slot Constants

```typescript
const Slot = {
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
