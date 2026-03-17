# Noetic API Reference

## Builder Functions

### step.run

Pure async computation. The runtime can retry freely and doesn't track token usage.

```typescript
step.run<I, O>({
  id: string;
  execute: (input: I, ctx: Context) => Promise<O>;
  retry?: RetryPolicy;
}): StepRun<I, O>
```

### step.llm

Model call with optional tools and structured output.

```typescript
step.llm<I, O>({
  id: string;
  model: string;
  system?: string;
  tools?: Tool[];
  output?: ZodType<O>;
  params?: ModelParams;
}): StepLLM<I, O>
```

The runtime assembles the View before calling the model: system message + memory layer items + conversation history. The `system` field becomes a `MessageItem` with `role: system`.

### step.tool

Direct tool execution (not via LLM selection).

```typescript
step.tool<I, O>({
  id: string;
  tool: Tool<ZodType<I>, ZodType<O>>;
  args?: Partial<I>;
}): StepTool<I, O>
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
spawn<I, O>({
  id: string;
  child: Step<I, O>;
  memory?: MemoryLayer[];
  timeout?: number;
}): StepSpawn<I, O>
```

### loop

Iteration with termination predicates.

```typescript
loop<I, O>({
  id: string;
  body: Step<I, O>;
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
  memory?: MemoryLayer[];
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

**Important:** When plans mix sequential and parallel execution (e.g., a fork inside a sequential chain), `executeStep` must be provided. Without it, only `run`-kind children can be executed in sequential nodes. When using the eval framework, the runtime's `execute` method serves as `executeStep`:

```typescript
// callModel auto-detected from OPENROUTER_API_KEY when omitted
const runtime = new InMemoryRuntime();
const compiled = compilePlan(plan, agents, undefined, runtime.execute.bind(runtime));
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

Generates layers from `ToolMemoryDeclaration` on tools. Tools sharing the same `memory.id` share state.

```typescript
toolMemoryLayer(tools: Tool[], opts?: { slot? })
```

## Runtime

```typescript
const runtime = new InMemoryRuntime();
const ctx = runtime.createContext({ threadId?, resourceId? });
const result = await runtime.execute(step, input, ctx);

// Background execution
const handle = runtime.detachedSpawn(step, input, ctx);
await handle.await();

// Channels
runtime.send(channel, value, ctx);
const msg = await runtime.recv(channel, ctx);
const msg = runtime.tryRecv(channel, ctx);
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
  ctx: Context;           // Step execution context
  runtime: Runtime;       // Runtime instance (guaranteed non-undefined)
  memory: ToolMemory;     // Per-layer state accessor (get/set by layer id)
  assembledView: Item[];  // Current conversation view
  lastStepMeta: StepMeta | null;
}
```
