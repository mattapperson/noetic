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
  system?: string;
  tools?: Tool[];
  output?: ZodType<O>;
  params?: ModelParams;
}): StepLLM<TMemory, I, O>
```

The agent harness assembles the View before calling the model: system message + memory layer items + conversation history. The `system` field becomes a `MessageItem` with `role: system`.

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
  system?: string;
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
  system: string;
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

## AgentHarness

`AgentHarness` is generic over `TParams`. The `config` property exposes `AgentConfig<TParams>`, and steps/tools access params via `ctx.harness.config.params`.

```typescript
// High-level API: execute() returns HarnessResult with streaming accessors
const harness = new AgentHarness({
  name: 'my-agent',
  initialStep: myStep,
  params: { model: 'anthropic/claude-sonnet-4-20250514' },
});

// Get final text (simplest usage)
const text = await harness.execute('Hello').getText();

// Get full response with items, usage, cost
const response = await harness.execute('Hello').getResponse();

// Stream text deltas as they arrive
for await (const delta of harness.execute('Hello').getTextStream()) {
  process.stdout.write(delta);
}

// Stream all events (SDK + framework)
for await (const event of harness.execute('Hello').getFullStream()) {
  console.log(event.source, event.type);
}

// With options
const result = harness.execute('Hello', {
  threadId: 'thread-1',
  resourceId: 'user-1',
});

// Item inputs
const text2 = await harness.execute(messageItem).getText();
const text3 = await harness.execute([item1, item2]).getText();

// Low-level API: manual context creation + run()
const ctx = harness.createContext({ threadId: 'thread-1' });
const runResult = await harness.run(step, input, ctx);

// Background execution
const handle = harness.detachedSpawn(step, input, ctx);
await handle.await();

// Channels
harness.send(channel, value, ctx);
const msg = await harness.recv(channel, ctx);
const msg = harness.tryRecv(channel, ctx);
```

## Slot Constants

```typescript
const Slot = {
  WORKING_MEMORY: 100,
  ENTITY: 150,
  OBSERVATIONS: 200,
  PROCEDURAL: 250,
  EPISODIC: 300,
  RAG: 350,
  SEMANTIC_RECALL: 400,
} as const;
```

## ToolExecutionContext

Available inside tool `execute` functions:

```typescript
interface ToolExecutionContext {
  ctx: Context;                 // Step execution context (ctx.harness also available)
  harness: AgentHarness;        // AgentHarness instance (guaranteed non-undefined)
  memory: ToolMemory;           // Per-layer state accessor (get/set by layer id)
  assembledView: Item[];        // Current conversation view
  lastStepMeta: StepMeta | null;
}
// Access harness params: toolCtx.harness.config.params
// Or via context: toolCtx.ctx.harness.config.params
```
