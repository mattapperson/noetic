# @orchid/core — A Unified TypeScript API for Agent Orchestration

Built from first principles. One type, seven variants.
Everything else is composition.

---

## Table of Contents

1. [Why Another API](#why-another-api)
2. [The Step Type](#the-step-type)
3. [Variant 1: `run` — Arbitrary Async Work](#variant-1-run--arbitrary-async-work)
4. [Variant 2: `llm` — Single LLM Call](#variant-2-llm--single-llm-call)
5. [Variant 3: `tool` — Single Tool Execution](#variant-3-tool--single-tool-execution)
6. [Variant 4: `branch` — Conditional Routing](#variant-4-branch--conditional-routing)
7. [Variant 5: `fork` — Parallel Execution](#variant-5-fork--parallel-execution)
8. [Variant 6: `spawn` — Child Execution with Context Boundary](#variant-6-spawn--child-execution-with-context-boundary)
9. [Variant 7: `loop` — Repeating Execution](#variant-7-loop--repeating-execution)
10. [Channels — Typed Data Flow](#channels--typed-data-flow)
11. [Termination Predicates — `until`](#termination-predicates--until)
12. [The Execution Context](#the-execution-context)
13. [The View: Memory Layers and Context Assembly](#the-view-memory-layers-and-context-assembly)
14. [The Runtime Interface](#the-runtime-interface)
15. [Error Model](#error-model)
16. [Observability](#observability)
17. [Pattern Derivations](#pattern-derivations)
    - [ReAct](#react)
    - [Ralph Wiggum Loop](#ralph-wiggum-loop)
    - [Task Trees with Plan Enforcement](#task-trees-with-plan-enforcement)
    - [Recursive LLM Decomposition](#recursive-llm-decomposition)
    - [Slate Thread Weaving](#slate-thread-weaving)
    - [A2A Protocol](#a2a-protocol)
18. [Dynamic Plans: Agent-Generated Execution](#dynamic-plans-agent-generated-execution)
19. [Design Decisions](#design-decisions)
20. [Build Sequence](#build-sequence)
21. [Full API Surface](#full-api-surface)

---

## Why Another API

Every existing TypeScript agent framework either provides too-high-level abstractions that can't express all patterns (Mastra, Vercel AI SDK), or provides a flexible-but-complex graph model that still misses key patterns (LangGraph). None of them treat context boundary management as a first-class concern, which means they can't naturally express Ralph Wiggum's fresh-context meta-loops or Slate's episodic thread weaving. And none of them provide a composable memory system where independently-authored memory layers (working memory, semantic recall, observations, episodic memory) participate in a well-defined lifecycle around each LLM call.

The insight: six patterns (ReAct, Ralph Wiggum, Task Trees, A2A, Recursive LLMs, Slate Thread Weaving) look different on the surface but decompose into combinations of the same small set of operations. These operations are derived from the intersection of:

- **Process calculi** — CSP channels, actor message passing
- **Durable execution** — Temporal's step/signal/child-workflow, Inngest's step.run/waitForEvent
- **LangGraph's Pregel engine** — supersteps, channels, message passing
- **Slate's architecture** — episodic memory, orchestrator/worker separation, thread-as-actor model

---

## The Step Type

`Step` is a discriminated union — one type with seven variants. The runtime pattern-matches on `kind`. Builder functions (`step.run(...)`, `fork(...)`, etc.) are constructors for the union variants.

```typescript
type Step<I, O> =
  | { kind: 'run';    id: string; execute: (input: I, ctx: Context) => Promise<O>; retry?: RetryPolicy }
  | { kind: 'llm';    id: string; model: string; system?: string; tools?: Tool[]; output?: ZodType<O>; params?: ModelParams }
  | { kind: 'tool';   id: string; tool: Tool; args?: unknown }
  | { kind: 'branch'; id: string; route: (input: I, ctx: Context) => Step<I, O> | null }
  | { kind: 'fork';   id: string; mode: 'all' | 'race' | 'settle'; paths: (input: I, ctx: Context) => Step<I, O>[]; merge?: MergeFn<O>; concurrency?: number }
  | { kind: 'spawn';  id: string; child: Step<I, O>; contextIn: ContextInStrategy; contextOut: ContextOutStrategy<O>; timeout?: number }
  | { kind: 'loop';   id: string; body: Step<I, O>; until: Until; prepareNext?: (output: O, verdict: Verdict, ctx: Context) => I; onError?: (error: OrchidError, ctx: Context) => 'retry' | 'skip' | 'abort' }
```

The runtime is a single recursive interpreter:

```typescript
async function execute<I, O>(step: Step<I, O>, input: I, ctx: Context): Promise<O> {
  switch (step.kind) {
    case 'run':    return executeRun(step, input, ctx);
    case 'llm':    return executeLLM(step, input, ctx);
    case 'tool':   return executeTool(step, input, ctx);
    case 'branch': return executeBranch(step, input, ctx);
    case 'fork':   return executeFork(step, input, ctx);
    case 'spawn':  return executeSpawn(step, input, ctx);
    case 'loop':   return executeLoop(step, input, ctx);
  }
}
```

This makes the "everything is a Step" claim true at the type level. The primitive count debate dissolves: one type, seven variants.

### The `O` Contract

`O` is always the business value — the thing the next step receives. Execution metadata (tool calls, token usage, cost) lives on the `Context`, not the return value.

```typescript
const result = await execute(analyze, codeSnippet, ctx);
// result is { bugs: Bug[], severity: Severity } — just O, nothing else.

// Metadata is on the context:
ctx.lastStepMeta; // { toolCalls: ToolCall[], usage: TokenUsage, cost: number }
```

This means `Step<I, O>` is an honest contract: input `I`, output `O`, always. This is analogous to how OpenTelemetry works — spans carry metadata, the function return carries the business value.

---

## Variant 1: `run` — Arbitrary Async Work

Pure computation. The runtime can retry freely, cache results, and doesn't need to track token usage.

```typescript
interface StepRunOpts<I, O> {
  id: string;
  execute: (input: I, ctx: Context) => Promise<O>;
  retry?: RetryPolicy;
}
```

```typescript
const fetchData = step.run({
  id: 'fetch-user-data',
  execute: async (userId: string, ctx) => {
    const response = await fetch(`/api/users/${userId}`);
    return response.json();
  },
  retry: { maxAttempts: 3, backoff: 'exponential', initialDelay: 1000 },
});
```

---

## Variant 2: `llm` — Single LLM Call

Costs tokens, needs model routing (OpenRouter, gateway, etc.), generates trace metadata with GenAI semantic conventions. Output may contain tool calls that drive the next iteration.

```typescript
interface StepLLMOpts<O> {
  id: string;
  model: string;              // e.g. 'anthropic/claude-sonnet-4-20250514'
  system?: string;
  tools?: Tool[];             // tools available for THIS call
  output?: ZodType<O>;        // structured output schema
  params?: ModelParams;       // temperature, topP, etc.
}
```

```typescript
const analyze = step.llm({
  id: 'analyze-code',
  model: 'anthropic/claude-sonnet-4-20250514',
  system: 'You are a code reviewer. Analyze the code for bugs.',
  tools: [searchTool, readFileTool],
  output: z.object({
    bugs: z.array(z.object({ line: z.number(), description: z.string() })),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
  }),
});
```

The return type is `O` — the parsed output (or `string` if no `output` schema is specified). Tool calls, token usage, and cost are execution metadata accumulated on the context:

```typescript
const result = await execute(analyze, codeSnippet, ctx);
// result is { bugs: Bug[], severity: Severity }

// Metadata on ctx.lastStepMeta:
// { toolCalls: ToolCall[], usage: { inputTokens: number; outputTokens: number }, cost: number }
```

### What the LLM Actually Sees: The View

An `llm` step does NOT simply send the `system` prompt and the raw input. The runtime assembles a **View** — the complete message array sent to the model — via the Memory Layer system (see [The View: Memory Layers and Context Assembly](#the-view-memory-layers-and-context-assembly)). Before each LLM call, the runtime:

1. Runs `recall()` on each memory layer (working memory, semantic recall, observations, etc.) to gather contextual content.
2. Assembles system prompt + memory layer outputs (ordered by slot) + conversation history into the View.
3. Sends the View to the model.
4. After the response, runs `store()` on each memory layer to persist learnings.

The `system` field on `StepLLMOpts` becomes the agent's base instructions within the View. Memory layers inject additional context (working memory state, relevant past experiences, retrieved knowledge) around it. This means the same `step.llm` call produces different Views depending on what the memory layers recall — the LLM's effective context is dynamic, not static.

---

## Variant 3: `tool` — Single Tool Execution

May have side effects, may need human approval before execution (preventive gating), and may need sandboxing.

```typescript
interface StepToolOpts<I, O> {
  id: string;
  tool: Tool<I, O>;
  args?: Partial<I>;  // can override LLM-provided args
}
```

### The Tool Type

```typescript
interface Tool<I extends ZodTypeAny = ZodTypeAny, O extends ZodTypeAny = ZodTypeAny> {
  name: string;
  description: string;
  input: I;
  output: O;
  execute: (args: z.infer<I>, ctx: Context) => Promise<z.infer<O>>;
  needsApproval?: boolean;  // preventive gating, not reactive throwing
}
```

### Why Three Execution Variants?

The runtime needs to treat them differently:

- **LLM steps** have cost implications, need model routing, produce telemetry with GenAI semantic conventions, and their output may contain tool calls that drive the next iteration.
- **Tool steps** may have side effects, may need human approval before execution, and may need sandboxing.
- **Run steps** are pure computation — the runtime can retry freely, cache results, and doesn't need to track token usage.

A single `step()` that inspects its arguments loses type safety and forces runtime introspection. Explicit variants mean the TypeScript compiler knows exactly what you're doing.

---

## Variant 4: `branch` — Conditional Routing

Inspects a value and selects which step to execute next. Returns the actual `Step`, not a string node name.

```typescript
interface BranchOpts<I, O> {
  id: string;
  route: (input: I, ctx: Context) => Step<I, O> | null;
}
```

```typescript
const routeByLanguage = branch<CodeFile, AnalysisResult>({
  id: 'route-by-language',
  route: (file, ctx) => {
    switch (file.language) {
      case 'typescript': return typescriptAnalyzer;
      case 'python':     return pythonAnalyzer;
      case 'rust':       return rustAnalyzer;
      default:           return genericAnalyzer;
    }
  },
});
```

LangGraph's conditional edges return string node names (`return "node_a"`), which TypeScript can't verify. Here, the router returns actual `Step` objects — TypeScript enforces that all branches return compatible output types.

Returning `null` is a no-op (skip this branch). This is useful in loops where some iterations don't need a particular branch.

---

## Variant 5: `fork` — Parallel Execution

Splits execution into parallel paths and merges results. Three modes mirror Promise semantics:

| Mode     | Behavior                               | Use Case                          |
|----------|----------------------------------------|-----------------------------------|
| `all`    | Wait for all paths, fail if any fails  | Task tree parallel children       |
| `race`   | Return first to complete, abort others | Competitive search, fastest model |
| `settle` | Wait for all, collect results + errors | Fault-tolerant batch processing   |

### Type-Safe Fork Options

The `merge` function is mandatory for `all` and `settle` modes — this eliminates `ForkResult` from the public API and ensures `fork` always produces `O`:

```typescript
type ForkOpts<I, O> =
  | { id: string; mode: 'race';   paths: (input: I, ctx: Context) => Step<I, O>[]; concurrency?: number }
  | { id: string; mode: 'all';    paths: (input: I, ctx: Context) => Step<I, O>[]; merge: (results: O[], ctx: Context) => O; concurrency?: number }
  | { id: string; mode: 'settle'; paths: (input: I, ctx: Context) => Step<I, O>[]; merge: (results: SettleResult<O>[], ctx: Context) => O; concurrency?: number }
```

```typescript
interface SettleResult<O> {
  stepId: string;
  status: 'fulfilled' | 'rejected';
  value?: O;
  error?: OrchidError;
}
```

### Dynamic Fan-Out

The `paths` parameter is a function, not a static array. This enables LangGraph-style `Send` without a separate API:

```typescript
const dynamicSearch = fork({
  id: 'parallel-search',
  mode: 'all',
  paths: (query, ctx) => {
    const engines = ['google', 'bing', 'arxiv', 'github'];
    return engines.map(engine =>
      step.run({
        id: `search-${engine}`,
        execute: async () => searchEngine(engine, query),
      })
    );
  },
  merge: (results, ctx) => deduplicateAndRank(results),
  concurrency: 3,
});
```

---

## Variant 6: `spawn` — Child Execution with Context Boundary

The most important variant. It's what makes Ralph Wiggum loops, recursive LLMs, and Slate thread weaving possible. Without it, you can't express "run this work with a different context window."

```typescript
interface SpawnOpts<I, O> {
  id: string;
  child: Step<I, O>;
  contextIn: ContextInStrategy;
  contextOut: ContextOutStrategy<O>;
  timeout?: number;
}
```

### The Two-Axis Design

Context strategy is split into two independent axes, each a discriminated union with explicit, configurable variants. These strategies control the **Event Log** (conversation history) that the child starts with. Memory layer state across the spawn boundary is controlled separately by each layer's `onSpawn` hook (see [MEMORY-LAYER-SPEC.md §9](./MEMORY-LAYER-SPEC.md#9-memory-across-spawn-boundaries)).

#### Axis 1: `contextIn` — What the child's Event Log starts with

```typescript
type ContextInStrategy =
  | { strategy: 'inherit' }                                                        // child sees parent's full Event Log
  | { strategy: 'fresh' }                                                          // child starts with empty Event Log
  | { strategy: 'subset'; select: (parentMessages: Message[], parentState: unknown) => Message[] }  // child gets filtered messages
  | { strategy: 'custom'; build: (input: unknown, parentCtx: Context) => Message[] }  // you build it explicitly
```

Note: `subset` operates on messages from the Event Log, not a partial `Context` object. The runtime builds a proper `Context` from the filtered messages.

#### How `contextIn` Interacts with Memory Layers

When `spawn()` creates a child execution, the runtime processes both axes:

1. **Event Log** is determined by `contextIn` (inherit, fresh, subset, custom).
2. **Memory layer state** is determined by each layer's `onSpawn` hook independently:
   - A layer can return `{ childState }` to provide initial state in the child.
   - A layer can return `null` to disable itself in the child.
   - A layer can inject messages into the child's initial Event Log via `{ childState, messages }`.

This separation means `contextIn: 'fresh'` gives the child an empty Event Log but memory layers still control whether their state (working memory, observations, etc.) crosses the boundary. For example, a `scope: 'resource'` working memory layer might share state across a fresh spawn because it represents user-level knowledge, while a `scope: 'execution'` layer would not.

Similarly, when the child completes, `contextOut` controls what the parent sees from the child's output, while each layer's `onReturn` hook independently merges child-side learnings back into parent state.

#### Axis 2: `contextOut` — What the child's output looks like to the parent

```typescript
type ContextOutStrategy<O> =
  | { strategy: 'full' }                                           // returns O (child's output)
  | { strategy: 'summary'; model?: string; prompt?: string }       // returns string (always)
  | { strategy: 'schema'; schema: ZodType<O> }                     // returns O (parsed)
```

`spawn` with `contextOut: 'summary'` forces `O = string`. TypeScript enforces this with overloads:

```typescript
function spawn<I, O>(opts: SpawnOpts<I, O> & { contextOut: { strategy: 'full' } }): Step<I, O>;
function spawn<I>(opts: SpawnOpts<I, string> & { contextOut: { strategy: 'summary'; model?: string; prompt?: string } }): Step<I, string>;
function spawn<I, O>(opts: SpawnOpts<I, O> & { contextOut: { strategy: 'schema'; schema: ZodType<O> } }): Step<I, O>;
```

### Context Strategy Compatibility Matrix

All 12 combinations of `contextIn` x `contextOut` are valid for Event Log strategies. Three deserve warnings. Memory layer state transfer is orthogonal — each layer's `onSpawn`/`onReturn` hooks apply regardless of the Event Log strategy chosen here.

|               | `full`                                                                                                    | `summary`                                                                                           | `schema`                                                                                            |
|---------------|-----------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| **`inherit`** | Standard delegation. Child continues parent conversation, returns everything.                             | Child continues parent conversation, returns compressed summary. Useful for limited context budgets. | Child continues parent conversation, returns typed extraction. Good for "extract X from this conversation." |
| **`fresh`**   | Ralph Wiggum. Child starts with empty Event Log, returns full output. All state persistence across the boundary is handled by memory layers — `onSpawn` controls what crosses, `StorageAdapter` handles durability. | Slate worker. Child starts with empty Event Log, returns episodic summary. Memory layers with `scope: 'resource'` or `scope: 'global'` share state via storage. | Fresh-start extraction. Child does independent work, returns typed result. Good for independent sub-tasks. |
| **`subset`**  | Focused delegation. Child sees filtered messages, returns everything. **Warning**: returned messages may reference context the parent doesn't have. | Focused with summary. Child sees filtered context, returns compressed result. Clean re-integration.  | Focused extraction. Child sees relevant context, returns typed result. Cleanest integration pattern. |
| **`custom`**  | Custom context, full return. You build the messages, get everything back. **Warning**: "everything" may be large and unstructured. | A2A / remote agent. You craft the prompt, get a compressed response.                                | A2A with typed contract. The most structured pattern. **Recommended** for cross-agent communication. |

### Summary Strategy

The `summary` strategy's prompt is explicit — you tell it exactly what to compress and what to drop:

```typescript
spawn({
  id: 'worker-thread',
  child: innerReactLoop,
  contextIn: { strategy: 'fresh' },
  contextOut: {
    strategy: 'summary',
    model: 'anthropic/claude-haiku-4-5-20251001',
    prompt: 'Summarize ONLY the successful actions taken and their results. '
          + 'Exclude failed attempts, retries, and intermediate reasoning. '
          + 'Format as a bullet list of (action -> outcome) pairs.',
  },
});
```

---

## Variant 7: `loop` — Repeating Execution

Combines a body step + termination predicate + optional input preparation into repeating execution.

```typescript
interface LoopOpts<I, O> {
  id: string;
  body: Step<I, O>;
  until: Until;
  prepareNext?: (output: O, verdict: Verdict, ctx: Context) => I;
  onError?: (error: OrchidError, ctx: Context) => 'retry' | 'skip' | 'abort';
}
```

`prepareNext` is how feedback flows from the `until` verdict back into the next iteration's input. For ReAct, it's not needed (the runtime accumulates messages). For Ralph Wiggum, it injects verification failure feedback:

```typescript
prepareNext: (output, verdict, ctx) => {
  if (verdict.feedback) {
    return `Previous attempt failed: ${verdict.feedback}\nTry a different approach.`;
  }
  return 'Continue working on the task.';
},
```

`onError` controls behavior when the loop body fails:

- `'retry'` — re-run the same iteration
- `'skip'` — move to the next iteration using the last successful output
- `'abort'` — propagate the error (default behavior if `onError` is not specified)

---

## Channels — Typed Data Flow

Channels are typed, named conduits for data between steps. They are standalone objects that TypeScript can type-check — no string IDs connecting things.

```typescript
interface Channel<T> {
  readonly name: string;
  readonly schema: ZodType<T>;
  readonly mode: 'value' | 'queue' | 'topic';
  readonly capacity?: number;  // queue mode only, default 1000
}
```

| Mode    | Behavior                               | Analogue                                |
|---------|----------------------------------------|-----------------------------------------|
| `value` | Last-write-wins                        | LangGraph `LastValue`, mutable variable |
| `queue` | FIFO buffer, readers block             | CSP channel, Go `chan`                  |
| `topic` | Pub/sub, all current readers get every message | LangGraph `Topic`, event bus     |

### Usage

```typescript
// Create typed channels
const findings = channel('findings', z.array(z.string()), 'topic');
const status = channel('status', z.enum(['running', 'done', 'error']), 'value');

// In a step: write to a channel
step.run({
  id: 'research',
  execute: async (query, ctx) => {
    const results = await search(query);
    ctx.send(findings, results);        // type-checked: must be string[]
    ctx.send(status, 'done');           // type-checked: must be 'running' | 'done' | 'error'
  },
});

// In another step: read from a channel
step.run({
  id: 'synthesize',
  execute: async (_, ctx) => {
    const allFindings = await ctx.recv(findings);  // typed as string[]
    return summarize(allFindings);
  },
});
```

The channel object IS the connection. If you pass the same `Channel<string[]>` to both a writer and a reader, TypeScript guarantees type compatibility at compile time.

### Channel Semantics

**Scope.** Channels are scoped to an execution tree. A channel created in a parent is accessible to all descendants unless a `spawn` boundary uses `contextIn: 'fresh'`. Fresh contexts get a new channel namespace. To pass a channel across a fresh boundary, use `contextIn: 'custom'` explicitly — this is the "you opted into this" escape hatch.

**Lifecycle.** Channels are created on first reference and garbage-collected when the execution tree completes. Queue channels buffer indefinitely within an execution (bounded by `capacity`, default 1000 messages). When the buffer is full, senders block (back-pressure). Topic channels are ephemeral — messages are delivered to currently-waiting receivers and dropped if no one is listening.

**Blocking model.** `recv` returns a `Promise` that resolves when data is available. This works because `recv` is only called inside `step.execute`, which is already async. The runtime manages a waiter queue:

```typescript
// Inside the runtime (simplified)
const channelState = new Map<string, {
  mode: 'value' | 'queue' | 'topic';
  buffer: unknown[];
  waiters: Array<{ resolve: (value: unknown) => void }>;
}>();

function send<T>(ch: Channel<T>, value: T): void {
  const state = channelState.get(ch.name);
  if (state.waiters.length > 0) {
    state.waiters.shift()!.resolve(value);
  } else if (state.mode === 'queue') {
    state.buffer.push(value);
  } else if (state.mode === 'value') {
    state.buffer = [value]; // last-write-wins
  }
  // topic: deliver to ALL waiters, drop if none
}

async function recv<T>(ch: Channel<T>): Promise<T> {
  const state = channelState.get(ch.name);
  if (state.buffer.length > 0) {
    return state.buffer.shift() as T;
  }
  return new Promise(resolve => state.waiters.push({ resolve }));
}
```

Within a `fork`, the runtime runs paths as concurrent promises (not sequential), so `send` in one path can wake `recv` in another.

**Topic mode is lossy.** Messages are not buffered if no receiver is waiting. This is intentional — topic channels are for real-time coordination, not reliable delivery. Use `queue` mode for reliable delivery.

---

## Termination Predicates — `until`

An `until` is a predicate that receives an execution `Snapshot` and returns a `Verdict`.

```typescript
interface Snapshot {
  stepCount: number;
  tokens: { input: number; output: number; total: number };
  elapsed: number;        // wall-clock ms
  cost: number;           // USD
  lastOutput: unknown;
  lastText: string;       // lastOutput as string
  history: unknown[];     // all outputs from this loop
  depth: number;          // spawn depth
}

interface Verdict {
  stop: boolean;
  reason?: string;
  feedback?: string;      // injected into next iteration's input
}

type Until = (snapshot: Snapshot) => Verdict | Promise<Verdict>;
```

### Why `Verdict` Instead of `boolean`?

1. **Observability**: the `reason` string shows up in traces. When debugging "why did my agent stop after 7 iterations?", you see `"Cost $4.82 exceeded budget $5.00"` instead of `true`.
2. **Feedback injection**: for verify-and-retry patterns (Ralph Wiggum), the verdict can include `feedback` that gets injected into the next iteration. The loop's `prepareNext` function receives the verdict.

### Composition

```typescript
// Stop when ANY predicate fires
const production = any(
  until.maxSteps(20),
  until.maxCost(5.00),
  until.maxDuration(5 * 60 * 1000),
);

// Stop when ALL predicates agree
const cautious = all(
  until.converged({ threshold: 0.95 }),
  until.maxSteps(3),  // need at least 3 iterations AND convergence
);
```

### Built-in Predicates

```typescript
const until = {
  maxSteps:       (n: number) => Until,
  maxCost:        (usd: number) => Until,
  maxDuration:    (ms: number) => Until,
  noToolCalls:    () => Until,                    // ReAct termination
  verified:       (fn: VerifyFn) => Until,        // Ralph Wiggum external check
  converged:      (opts: ConvergeOpts) => Until,  // recursive self-refinement
  outputContains: (marker: string) => Until,      // completion promise marker
  custom:         (fn: Until) => Until,           // escape hatch
};
```

Each is 3-5 lines. They're compositions of the `Until` type:

```typescript
const maxSteps = (n: number): Until => (snap) => ({
  stop: snap.stepCount >= n,
  reason: `Reached ${n} steps`,
});

const verified = (fn: VerifyFn): Until => async (snap) => {
  const result = await fn(snap.lastOutput);
  return {
    stop: result.pass,
    reason: result.pass ? 'Verification passed' : 'Verification failed',
    feedback: result.feedback,
  };
};
```

---

## The Execution Context

Every step runs inside a `Context`. It's the runtime's handle into the execution. The `Context` is NOT the content sent to the LLM — that is the **View**, assembled by the Projector from memory layers and conversation history (see next section). The `Context` is execution metadata and infrastructure.

```typescript
interface Context<TState = unknown> {
  readonly id: string;           // UUIDv7 (time-sortable)
  readonly stepCount: number;    // monotonically increasing
  readonly tokens: TokenUsage;   // accumulated across all LLM calls
  readonly elapsed: number;      // wall-clock ms
  readonly cost: number;         // USD
  state: TState;                 // mutable, typed per-execution
  readonly parent: Context | null;  // null at root
  readonly depth: number;        // spawn depth (root = 0)
  readonly span: Span;           // OpenTelemetry trace span

  // Identifiers for memory layer scope resolution
  readonly threadId: string;     // stable across calls in the same conversation
  readonly resourceId?: string;  // user, entity, or resource identifier

  // The Event Log — append-only record of all messages in this execution
  readonly eventLog: EventLog;

  // Last step execution metadata (tool calls, token usage, cost)
  readonly lastStepMeta: StepMeta | null;

  // Channel operations (thin wrappers over runtime.send/recv)
  recv<T>(channel: Channel<T>, opts?: { timeout?: number }): Promise<T>;
  send<T>(channel: Channel<T>, value: T): void;

  // Lifecycle
  checkpoint(): Promise<void>;
  complete<T>(value: T): void;
  abort(reason?: string): void;
}

interface StepMeta {
  toolCalls?: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
  cost?: number;
}
```

### Key Relationships

- **`parent`** enables spawn-tree traversal. The `depth` field enables recursive patterns with depth limits.
- **`span`** means every step is automatically traced without user instrumentation.
- **`threadId` / `resourceId`** are used by the runtime to resolve memory layer scope keys (see [MEMORY-LAYER-SPEC.md §5](./MEMORY-LAYER-SPEC.md#5-scope-enforcement)). A `scope: 'thread'` memory layer isolates state per `threadId`; a `scope: 'resource'` layer shares state across threads for the same `resourceId`.
- **`eventLog`** is the append-only record of conversation events. It is NOT directly sent to the LLM. The Projector renders it into the View alongside memory layer outputs, applying overflow policies (truncation, summarization, sliding window) when the log exceeds the token budget.

---

## The View: Memory Layers and Context Assembly

The **View** is the actual message array sent to the LLM. It is assembled fresh before every `step.llm` call by the Projector, which combines three sources:

```
┌─────────────────────────────────────────────────┐
│                    THE VIEW                      │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │ System Prompt (agent instructions)        │   │
│  ├──────────────────────────────────────────┤   │
│  │ Memory Layer Outputs (ordered by slot)    │   │
│  │   ├─ Working Memory      (slot 100)       │   │
│  │   ├─ Entity Memory        (slot 150)      │   │
│  │   ├─ Observations         (slot 200)      │   │
│  │   ├─ Episodic Memory      (slot 300)      │   │
│  │   ├─ RAG Knowledge Base   (slot 350)      │   │
│  │   └─ Semantic Recall      (slot 400)      │   │
│  ├──────────────────────────────────────────┤   │
│  │ Conversation History (from Event Log)     │   │
│  │   (truncated/summarized/windowed to fit)  │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

### Memory Layers

A `MemoryLayer` is a plugin that participates in the execution lifecycle to recall context before LLM calls and persist information after them. Memory layers are the sole extension point for injecting non-conversation content into the View. The full specification is in [MEMORY-LAYER-SPEC.md](./MEMORY-LAYER-SPEC.md).

Each memory layer declares:

- **`slot`** — where in the View its output appears (lower = closer to system prompt)
- **`scope`** — state isolation boundary (`'thread'`, `'resource'`, `'global'`, `'execution'`)
- **`budget`** — token allocation (fixed cap, min/max range, or `'auto'`)
- **`hooks`** — lifecycle callbacks that the runtime calls at defined points

### The LLM Call Lifecycle

When the runtime executes a `step.llm`, the full cycle is:

```
1. recall()    — Each memory layer recalls relevant content
                 (sequential, ordered by slot)

2. ASSEMBLE    — Projector builds the View:
                 system prompt + layer outputs + conversation history
                 Budget allocation ensures layers + history fit in
                 the model's context window

3. LLM CALL    — View is sent to the model

4. store()     — Each memory layer persists learnings from the response
                 (concurrent via Promise.allSettled)

5. EVENT LOG   — Response is appended to the Event Log
```

This cycle runs on every `step.llm` invocation. In a `loop`, it runs every iteration — meaning memory layers can accumulate, compress, and retrieve context across iterations without growing the raw conversation history.

### Why This Matters for Patterns

The memory layer system is what makes the vague concept of "context" concrete:

- **ReAct**: No memory layers needed for the basic pattern. The Event Log accumulates tool call results. But add `workingMemory()` and the agent can maintain structured state across iterations without prompt engineering.
- **Ralph Wiggum**: `contextIn: 'fresh'` gives the child an empty Event Log, but memory layers with `scope: 'resource'` persist across iterations via storage. A `durableTaskState()` memory layer handles task-level artifacts (files modified, git commits, progress checkpoints) while `observationalMemory()` handles cognitive state (what approaches failed, what the agent has learned).
- **Slate Thread Weaving**: Workers run with `contextIn: 'fresh'` + `contextOut: 'summary'`. The orchestrator's memory layers accumulate episode summaries from workers — this is how the orchestrator "remembers" what workers have done without replaying their full conversations.
- **Task Trees**: Each node can have different memory layer configurations via `enforced()`. A research node might have RAG enabled; a code-writing node might not.

### Conversation History is Not a Memory Layer

The Event Log's rendering into the View is handled by the Projector, not by a memory layer. Memory layers get allocated token budgets FROM a pool. Conversation history gets the REMAINDER. This asymmetry is fundamental — conversation history is the baseline that memory layers augment, not a peer they compete with. See [MEMORY-LAYER-SPEC.md §8](./MEMORY-LAYER-SPEC.md#8-conversation-history-is-not-a-memory-layer) for the full rationale.

### Memory Layers Across Spawn Boundaries

When `spawn()` creates a child execution, the runtime processes memory layers alongside the `contextIn`/`contextOut` strategies:

```
Parent calls spawn(opts)
│
├─ contextIn determines the child's initial Event Log
│
├─ For each memory layer (sequential, array order):
│   └─ onSpawn() → returns child state (or null to disable in child)
│
├─ Child execution runs with its own Event Log + memory layer states
│
├─ Child completes
│
├─ contextOut determines what the parent receives as the step output
│
└─ For each memory layer (sequential, array order):
    └─ onReturn() → merges child learnings back into parent state
```

This dual-path design means the Event Log strategy and memory layer strategy are independently configurable. A `fresh` Event Log with `inherit`-style memory layers is different from a `fresh` Event Log with all layers disabled in the child — the first gives the child a clean conversation but carries forward knowledge; the second is a true blank slate.

---

## The Runtime Interface

The runtime is the engine. It's behind an interface with methods covering execution, context management, channels, durability, memory layer lifecycle, cancellation, and tracing.

```typescript
interface Runtime {
  // Core execution
  execute<I, O>(step: Step<I, O>, input: I, ctx: Context): Promise<O>;

  // Context management
  createContext(opts?: {
    parent?: Context;
    messages?: Message[];
    state?: unknown;
    threadId?: string;
    resourceId?: string;
  }): Context;

  // Channel operations (the runtime owns the backing store)
  send<T>(channel: Channel<T>, value: T, ctx: Context): void;
  recv<T>(channel: Channel<T>, ctx: Context, opts?: { timeout?: number }): Promise<T>;

  // Memory layer lifecycle
  initLayers(layers: MemoryLayer[], ctx: Context, storage: StorageAdapter): Promise<void>;
  recallLayers(layers: MemoryLayer[], input: string, ctx: Context): Promise<LayerOutput[]>;
  storeLayers(layers: MemoryLayer[], response: LLMResponse, ctx: Context): Promise<void>;
  disposeLayers(layers: MemoryLayer[], ctx: Context): Promise<void>;

  // View assembly
  assembleView(agent: AgentConfig, input: string, ctx: Context): Promise<Message[]>;

  // Durability (no-ops in InMemoryRuntime)
  checkpoint(ctx: Context): Promise<void>;
  restore(executionId: string): Promise<Context | null>;

  // Lifecycle
  cancel(ctx: Context, reason?: string): Promise<void>;

  // Observability
  createSpan(name: string, parent: Span | null): Span;
}
```

### Key Design Points

- **`send`/`recv` on the runtime** means the runtime controls channel storage. `InMemoryRuntime` uses a `Map`. `DurableRuntime` uses a message broker. The `Context` methods are thin wrappers: `ctx.send(ch, v)` calls `runtime.send(ch, v, ctx)`.
- **Memory layer methods** manage the full lifecycle defined in [MEMORY-LAYER-SPEC.md §3](./MEMORY-LAYER-SPEC.md#3-lifecycle-hooks). `initLayers` runs `init()` on each layer sequentially. `recallLayers` runs `recall()` in slot order. `storeLayers` runs `store()` concurrently via `Promise.allSettled`. `disposeLayers` runs `dispose()` in reverse order. Error handling follows the per-hook policy (init failure disables the layer; recall failure skips it; store failure is logged).
- **`assembleView`** is the Projector — it calls `recallLayers`, allocates token budgets, and assembles system prompt + layer outputs + conversation history into the View. This is what `executeLLM` calls internally before sending messages to the model.
- **`checkpoint`/`restore`** enable durable execution. `InMemoryRuntime` implements them as no-ops. `DurableRuntime` serializes state (including memory layer state) to its backing store.
- **`cancel`** with propagation. The runtime knows the execution tree (via parent/child context references) and walks it to cancel children. Cancelled executions still run `onComplete` and `dispose` on their memory layers.
- **`createSpan`** lets the runtime control the tracing backend.

### What's NOT on the Runtime

- **`executeFork`** — fork execution is handled by the core `execute` switch. The `fork` variant calls `execute` on each path internally.
- **`summarize`** — summarization is just an LLM call. The `spawn` executor calls `execute(step.llm({ id: 'summarize', ... }), ...)` internally.

### Runtime Backends

| Backend              | When to Use                                                     |
|----------------------|-----------------------------------------------------------------|
| `InMemoryRuntime`    | Testing, simple scripts, CLI tools                              |
| `DurableRuntime`     | Production — backed by Temporal, Inngest, or custom event store |
| `DistributedRuntime` | Multi-node — A2A, worker pools, cloud functions                 |

```typescript
import { setRuntime, InMemoryRuntime } from '@orchid/core';

setRuntime(new InMemoryRuntime());
```

---

## Error Model

A concrete error taxonomy with defined propagation rules.

### Error Types

```typescript
type OrchidError =
  | { kind: 'step_failed';          stepId: string; cause: Error; retriesExhausted: boolean }
  | { kind: 'llm_refused';          stepId: string; refusal: string }
  | { kind: 'llm_parse_error';      stepId: string; raw: string; schema: ZodType; zodError: ZodError }
  | { kind: 'llm_rate_limit';       stepId: string; retryAfter?: number }
  | { kind: 'fork_partial';         stepId: string; succeeded: Array<{ stepId: string; value: unknown }>; failed: Array<{ stepId: string; error: OrchidError }> }
  | { kind: 'spawn_summary_failed'; stepId: string; childOutput: unknown; summaryCause: Error }
  | { kind: 'channel_timeout';      channelName: string; timeout: number }
  | { kind: 'cancelled';            reason?: string }
  | { kind: 'budget_exceeded';      field: 'cost' | 'steps' | 'duration'; limit: number; actual: number }
```

### Propagation Rules

**Step failure.** Retry per policy. If retries exhausted, throw `step_failed`. The parent (loop, fork, etc.) decides what to do.

**Fork with `mode: 'all'`.** If any path fails, cancel remaining paths and throw `fork_partial` with both succeeded and failed results. The caller decides whether to use partial results or propagate.

**Fork with `mode: 'settle'`.** Never throws. Failed paths appear as `{ status: 'rejected' }` in the merge function's `SettleResult[]`.

**Fork with `mode: 'race'`.** First success wins. If all fail, throw `fork_partial`.

**Loop body failure.** Default: propagate (loop dies). If `onError` is specified:
- `'retry'` — re-run the same iteration
- `'skip'` — move to next iteration using last successful output
- `'abort'` — propagate the error

**`until` predicate throws.** Treat as `{ stop: true, reason: 'Predicate error: ...' }`. The loop stops. A broken predicate should not cause infinite iteration.

**Spawn with summary failure.** The child's work succeeded — don't discard it. Throw `spawn_summary_failed` with `childOutput` attached so the caller can fall back to using the raw output.

**`llm_parse_error`.** The LLM returned text that didn't match the Zod schema. Includes the `raw` text so the caller can attempt recovery (re-prompt, manual parse, etc.).

---

## Observability

Every variant automatically creates OpenTelemetry-compatible trace spans via the `Context.span` field.

```
[ralph-wiggum-loop]                     <- root span
  [ralph-iteration-1]                   <- spawn span (fresh context)
    [react-loop]                        <- loop span
      [react-step] model=claude-sonnet  <- step span (LLM call)
        gen_ai.usage.input_tokens: 1500
        gen_ai.usage.output_tokens: 340
        gen_ai.cost: 0.0067
      [react-step] tool=shell           <- step span (tool call)
        tool.name: shell
        tool.args: { command: "npm test" }
    loop.verdict: { stop: false, reason: "Verification failed" }
  [ralph-iteration-2]                   <- spawn span (fresh context)
    [react-loop]
      ...
  loop.verdict: { stop: true, reason: "Verification passed" }
```

No user instrumentation needed. The trace tree mirrors the execution tree because every step, fork, spawn, and loop creates a child span from the context.

Custom exporters plug in:

```typescript
import { setTraceExporter } from '@orchid/core';
import { DatadogExporter } from '@orchid/datadog';

setTraceExporter(new DatadogExporter({ apiKey: process.env.DD_API_KEY }));
```

---

## Pattern Derivations

Every pattern is 15-30 lines of composition. The implementations below are real, not pseudocode.

### ReAct

ReAct is: call the LLM with tools, repeat until no tool calls.

```typescript
function react(opts: {
  model: string;
  system?: string;
  tools: Tool[];
  maxSteps?: number;
  maxCost?: number;
}) {
  const llmStep = step.llm({
    id: 'react-step',
    model: opts.model,
    system: opts.system,
    tools: opts.tools,
  });

  return loop({
    id: 'react-loop',
    body: llmStep,
    until: any(
      until.noToolCalls(),
      until.maxSteps(opts.maxSteps ?? 10),
      ...(opts.maxCost ? [until.maxCost(opts.maxCost)] : []),
    ),
  });
}
```

**What it's made of:** `loop` + `step.llm` + `until.noToolCalls` + `until.maxSteps`.

**Event Log strategy:** accumulate. Because there's no spawn boundary, tool call results are appended to the Event Log within the same context. On each iteration, the Projector assembles a fresh View — memory layers `recall()` runs before each LLM call, and `store()` runs after. This means memory layers (working memory, observations, etc.) can evolve across iterations even though the Event Log grows linearly.

---

### Ralph Wiggum Loop

Ralph Wiggum wraps an inner pattern (typically ReAct) in an outer loop where each iteration gets a fresh Event Log. All state that survives across iterations — both task-level artifacts and cognitive state — is managed by memory layers. A `durableTaskState()` layer persists work products (files on disk, git commits) while `observationalMemory()` and `workingMemory()` persist what the agent knows and has learned. Their `onSpawn` hooks control what crosses the fresh boundary.

```typescript
function ralphWiggum(opts: {
  model: string;
  system: string;
  tools: Tool[];
  verify: (output: unknown) => Promise<{ pass: boolean; feedback?: string }>;
  maxIterations?: number;
  innerMaxSteps?: number;
}) {
  const inner = react({
    model: opts.model,
    system: opts.system,
    tools: opts.tools,
    maxSteps: opts.innerMaxSteps ?? 20,
  });

  return loop({
    id: 'ralph-wiggum-loop',
    body: spawn({
      id: 'ralph-iteration',
      child: inner,
      contextIn: { strategy: 'fresh' },
      contextOut: { strategy: 'full' },
    }),
    until: any(
      until.verified(opts.verify),
      until.maxSteps(opts.maxIterations ?? 50),
    ),
    prepareNext: (output, verdict, ctx) => {
      if (verdict.feedback) {
        return `Previous attempt feedback: ${verdict.feedback}\nContinue working.`;
      }
      return 'Continue working on the task.';
    },
  });
}
```

**What it's made of:** `loop` + `spawn(contextIn: fresh)` + `react` (inner) + `until.verified`.

**Type chain:** `react(...)` -> `Step<string, string>` -> `spawn({ contextOut: { strategy: 'full' } })` -> `Step<string, string>` -> `loop(...)` -> `Step<string, string>`. Types check out.

**Memory layer interaction:** Each spawned iteration starts with a fresh Event Log but memory layers with broader scope persist. A `durableTaskState()` layer handles task artifacts (files modified, git commits, test results) — replacing the need for a separate `Persistence` mechanism. A `workingMemory({ scope: 'resource' })` layer carries structured progress tracking. An `observationalMemory()` layer compresses learnings from previous iterations into concise observations that appear in the next iteration's View — giving the agent "memory" of past attempts without the full conversation history. All persistence is handled uniformly through memory layers and their `StorageAdapter`.

**Usage:**

```typescript
const migrator = ralphWiggum({
  model: 'anthropic/claude-sonnet-4-20250514',
  system: fs.readFileSync('PROMPT.md', 'utf-8'),
  tools: [shellTool, fileWriteTool, fileReadTool, gitTool],
  verify: async (output) => {
    const result = await exec('npm test');
    return { pass: result.exitCode === 0, feedback: result.stderr };
  },
  maxIterations: 50,
});

const result = await execute(migrator, 'Migrate all tests from Jest to Vitest', ctx);
```

---

### Task Trees with Plan Enforcement

A task tree is a recursive structure: each node either executes directly (leaf) or decomposes into children (branch).

```typescript
interface TaskNode<I, O> {
  id: string;
  execute: Step<I, O>;
  children?: TaskNode<any, any>[];
  childExecution?: 'parallel' | 'sequential';
  merge?: (childResults: any[], ctx: Context) => O;
}
```

```typescript
const buildFeature: TaskNode<string, string> = {
  id: 'build-feature',
  execute: step.llm({ id: 'plan', model, system: 'Create a technical spec' }),
  childExecution: 'sequential',
  children: [
    {
      id: 'implement',
      execute: step.llm({ id: 'code', model, system: 'Write the code' }),
      childExecution: 'parallel',
      children: [
        { id: 'frontend', execute: frontendAgent },
        { id: 'backend',  execute: backendAgent },
        { id: 'tests',    execute: testAgent },
      ],
      merge: (results) => results.join('\n---\n'),
    },
    {
      id: 'review',
      execute: reviewAgent,
    },
  ],
  merge: (results) => results[results.length - 1],
};

const result = await execute(taskTree(buildFeature), 'Add user authentication', ctx);
```

No string IDs for dependencies. Data flows through the tree structure itself. Sequential children pipe output -> input. Parallel children receive the parent's output and their results are merged.

**Plan enforcement.** The `enforced()` wrapper is preventive, not reactive:

```typescript
const result = await execute(
  enforced(buildFeature, {
    toolAllowlist: {
      'frontend': ['readFile', 'writeFile', 'search'],
      'backend':  ['readFile', 'writeFile', 'shell', 'database'],
      'tests':    ['readFile', 'writeFile', 'shell'],
    },
    maxStepsPerNode: 15,
    requireApproval: ['review'],
    validate: async (taskId, input, ctx) => {
      return ctx.cost < 10.00;
    },
  }),
  'Add user authentication',
  ctx
);
```

"Preventive" means: `toolAllowlist` modifies the tool list passed to `step.llm` for that node — the LLM never sees the disallowed tools. `requireApproval` pauses execution and waits on a channel for human input. No tokens are wasted on rejected tool calls.

---

### Recursive LLM Decomposition

An agent that decomposes its task by spawning child instances of itself with focused sub-context.

```typescript
function recursiveLLM<I, O>(opts: {
  model: string;
  system: string;
  tools?: Tool[];
  decompose: (input: I, ctx: Context) => Promise<I[] | null>;
  merge: (results: O[], ctx: Context) => Promise<O>;
  maxDepth: number;
}): Step<I, O> {
  return step.run({
    id: 'recursive-llm',
    execute: async (input: I, ctx: Context) => {
      if (ctx.depth >= opts.maxDepth) {
        return execute(directSolve, input, ctx);
      }

      const subTasks = await opts.decompose(input, ctx);
      if (!subTasks) return execute(directSolve, input, ctx);

      const childResults = await execute(
        fork({
          id: 'recursive-fork',
          mode: 'all',
          paths: () => subTasks.map((sub, i) =>
            spawn({
              id: `child-${i}`,
              child: recursiveLLM(opts),
              contextIn: {
                strategy: 'custom',
                build: (inp) => [
                  { role: 'system', content: opts.system },
                  { role: 'user', content: String(inp) },
                ],
              },
              contextOut: { strategy: 'summary' },
            })
          ),
          merge: (results) => results,
        }),
        input,
        ctx
      );

      return opts.merge(childResults as unknown as O[], ctx);
    },
  });
}
```

**What it's made of:** `step.run` (outer) + `fork` (parallel children) + `spawn(contextIn: custom, contextOut: summary)` + self-reference for recursion. Depth control via `ctx.depth`.

**Memory layer interaction:** Each recursive child spawns with `contextIn: 'custom'`, which gives it a tailored Event Log. Memory layers with `scope: 'global'` (like a shared knowledge base) are available to all children in the recursion tree. Each child's `onReturn` can merge its discoveries back into the parent's memory layer state, enabling the merge function to work with both the child's typed output and its accumulated knowledge.

---

### Slate Thread Weaving

An orchestrator dispatches parallel worker threads. Workers run in fresh contexts and return episodic summaries.

```typescript
function threadWeave<O>(opts: {
  orchestrator: { model: string; system: string };
  workers: Record<string, { model: string; system: string; tools: Tool[] }>;
  dispatch: Step<string, WorkerDispatch[]>;
  maxParallel?: number;
  maxRounds?: number;
}) {
  return loop({
    id: 'thread-weave',
    body: step.run({
      id: 'weave-round',
      execute: async (input: string, ctx: Context) => {
        const dispatches = await execute(opts.dispatch, input, ctx);

        return execute(
          fork({
            id: 'worker-fork',
            mode: 'all',
            concurrency: opts.maxParallel ?? 5,
            paths: () => dispatches.map((d, i) => {
              const worker = opts.workers[d.workerName];
              return spawn({
                id: `worker-${d.workerName}-${i}`,
                child: react({
                  model: worker.model,
                  system: worker.system,
                  tools: worker.tools,
                }),
                contextIn: { strategy: 'fresh' },
                contextOut: {
                  strategy: 'summary',
                  prompt: 'Summarize ONLY successful actions and their results.',
                },
              });
            }),
            merge: (results) => results.join('\n'),
          }),
          dispatches[0],
          ctx
        );
      },
    }),
    until: any(
      until.maxSteps(opts.maxRounds ?? 20),
      until.outputContains('WEAVE_COMPLETE'),
    ),
  });
}

interface WorkerDispatch {
  workerName: string;
  prompt: string;
  tools?: string[];
}
```

**What it's made of:** `loop` (orchestrator rounds) + `fork` (parallel workers) + `spawn(contextIn: fresh, contextOut: summary)` + `react` (inner worker loop).

**Memory layer interaction:** The orchestrator maintains its own memory layers across rounds — its `observationalMemory()` accumulates compressed summaries of worker results. Workers spawn with fresh Event Logs and `contextOut: 'summary'`, so the orchestrator's View grows with episode summaries rather than raw worker conversations. A `sharedSwarmMemory()` layer (see [MEMORY-LAYER-SPEC.md §14.3](./MEMORY-LAYER-SPEC.md#143-shared-swarm-memory)) can enable real-time finding sharing between concurrent workers via pub/sub.

---

### A2A Protocol

A2A is `spawn` + `step.run` over HTTP. Remote agents are wrapped in Steps that compose like local ones.

```typescript
function remote<O = string>(opts: {
  url: string;
  output?: ZodTypeAny;
  auth?: { type: 'bearer'; token: string };
  timeout?: number;
}): Step<string, O> {
  return step.run({
    id: `remote-${new URL(opts.url).hostname}`,
    execute: async (input: string, ctx: Context) => {
      const response = await fetch(opts.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(opts.auth ? { Authorization: `Bearer ${opts.auth.token}` } : {}),
        },
        body: JSON.stringify({ message: input }),
        signal: AbortSignal.timeout(opts.timeout ?? 30_000),
      });
      const result = await response.json();
      return opts.output ? opts.output.parse(result) : result;
    },
    retry: { maxAttempts: 3, backoff: 'exponential', initialDelay: 1000 },
  });
}
```

Remote agents compose naturally with everything else:

```typescript
const results = await execute(
  fork({
    id: 'hybrid-search',
    mode: 'all',
    paths: () => [
      react({ model: 'local-model', tools: searchTools, system: 'Search...' }),
      remote({ url: 'https://research-agent.example.com', auth: { type: 'bearer', token } }),
    ],
    merge: (results) => mergeSearchResults(results),
  }),
  query,
  ctx
);
```

No separate "Protocol" primitive. A2A transport complexity (task lifecycle, SSE streaming, capability negotiation) is a runtime concern.

---

## Dynamic Plans: Agent-Generated Execution

### The Schema

```typescript
const PlanNodeSchema: z.ZodType<PlanNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    description: z.string(),
    assignee: z.string(),
    execution: z.enum(['sequential', 'parallel']).default('sequential'),
    children: z.array(PlanNodeSchema).optional(),
  })
);
```

### The Compiler

```typescript
function compilePlan<O>(
  plan: PlanNode,
  agents: Record<string, (prompt: string) => Step<string, unknown>>,
  constraints?: PlanConstraints,
): Step<string, O> {
  function compile(node: PlanNode): TaskNode<string, unknown> {
    const agentFactory = agents[node.assignee];
    if (!agentFactory) {
      throw new Error(
        `Plan references agent "${node.assignee}" but available agents are: `
        + Object.keys(agents).join(', ')
      );
    }
    return {
      id: node.id,
      execute: agentFactory(node.description),
      childExecution: node.execution === 'parallel' ? 'parallel' : 'sequential',
      children: node.children?.map(compile),
      merge: node.children ? (results) => results : undefined,
    };
  }

  const tree = compile(plan);
  return constraints ? enforced(tree, constraints) : taskTree(tree);
}
```

### Adaptive Plans

For agents that need to modify their own execution structure, `adaptivePlan` wraps `compilePlan` in a plan -> validate -> execute -> revise loop:

```typescript
function adaptivePlan<O>(opts: {
  planner: Step<string, PlanNode>;
  agents: Record<string, (prompt: string) => Step<string, unknown>>;
  constraints: PlanConstraints;
  maxRevisions: number;
}) {
  return loop({
    id: 'adaptive-plan',
    body: step.run({
      id: 'plan-execute-cycle',
      execute: async (input: string, ctx: Context) => {
        // 1. Generate or revise plan
        const plan = await execute(opts.planner, input, ctx);

        // 2. Validate plan against available agents BEFORE execution
        const validation = validatePlan(plan, opts.agents);
        if (!validation.valid) {
          ctx.state.lastPlanError = validation.errors;
          return { success: false, errors: validation.errors };
        }

        // 3. Compile and execute
        const executable = compilePlan(plan, opts.agents, opts.constraints);
        try {
          const result = await execute(executable, input, ctx);
          return { success: true, result };
        } catch (e) {
          if (e.kind === 'fork_partial') {
            ctx.state.partialResults = e.succeeded;
            ctx.state.failures = e.failed;
            return { success: false, partialResults: e.succeeded, failures: e.failed };
          }
          throw e;
        }
      },
    }),
    until: any(
      until.custom((snap) => {
        const last = snap.lastOutput as any;
        return {
          stop: last?.success === true,
          reason: last?.success ? 'Plan succeeded' : 'Revising plan',
        };
      }),
      until.maxSteps(opts.maxRevisions),
    ),
    prepareNext: (output, verdict, ctx) => {
      if (ctx.state.lastPlanError) {
        return `Previous plan was invalid: ${ctx.state.lastPlanError.join(', ')}. Revise.`;
      }
      if (ctx.state.failures) {
        return `These subtasks failed: ${JSON.stringify(ctx.state.failures)}. `
             + `These succeeded: ${JSON.stringify(ctx.state.partialResults)}. Revise the plan.`;
      }
      return 'Continue.';
    },
  });
}
```

### Full Flow

```typescript
// 1. LLM generates a plan
const planResult = await execute(
  step.llm({
    id: 'generate-plan',
    model: 'anthropic/claude-sonnet-4-20250514',
    system: 'Generate a plan as JSON. Available agents: researcher, coder, reviewer.',
    output: PlanNodeSchema,
  }),
  'Build a REST API for user management',
  ctx
);

// 2. Compile into executable task tree
const executable = compilePlan(planResult, {
  researcher: (prompt) => react({ model, tools: searchTools, system: prompt }),
  coder:      (prompt) => react({ model, tools: codeTools, system: prompt }),
  reviewer:   (prompt) => react({ model, tools: reviewTools, system: prompt }),
}, {
  maxStepsPerNode: 15,
  requireApproval: ['deploy'],
});

// 3. Execute with enforcement
const result = await execute(executable, 'Build a REST API for user management', ctx);
```

---

## Design Decisions

### One discriminated union vs. separate primitive types

We chose a single `Step<I, O>` discriminated union with seven `kind` variants. The alternative — seven independent types — would require seven overloads of `execute` and make composition less natural. The tradeoff: pattern-matching on `kind` is slightly more verbose than direct function dispatch, but it gives us a single recursive interpreter and makes "everything is a Step" true at the type level.

### Three execution variants (`run`, `llm`, `tool`) vs. a single overloaded function

We chose explicit variants because the runtime treats them differently: retry semantics, cost tracking, approval gating, sandboxing, and telemetry all differ. The cost is three constructors instead of one. The benefit is that TypeScript enforces correct usage at compile time and the runtime never needs to inspect arguments to determine behavior.

### `O` as business value only vs. rich return types

We chose to keep `O` as the business value and put execution metadata (`toolCalls`, `usage`, `cost`) on the context. The alternative — returning `LLMResult<O>` from LLM steps — breaks the composability contract because `Step<I, O>` would lie about its output type. The tradeoff: accessing metadata requires reading `ctx.lastStepMeta` instead of destructuring the return value, which is slightly less ergonomic for single-step scripts but dramatically simpler for multi-step compositions.

### Mandatory `merge` for fork vs. optional with `ForkResult<O>[]` default

We chose mandatory `merge` for `all` and `settle` modes to keep the `Step<I, O>` contract honest. The alternative — returning `ForkResult<O>[]` — leaks fork semantics into downstream steps that shouldn't need to know they're consuming forked output. The tradeoff: every fork requires a merge function, even when the merge is trivial (e.g., `(results) => results[0]`).

### Two-axis context strategy vs. single enum

We chose `contextIn` x `contextOut` as two independent axes with discriminated union variants. The original design used a single string enum (`'accumulate' | 'fresh' | 'episodic' | 'windowed'`) that hid enormous complexity behind four words. The tradeoff: more verbose configuration, but every combination is explicit, configurable, and type-safe.

### Error taxonomy vs. generic `Error` propagation

We chose a discriminated union `OrchidError` with specific kinds because different errors require different recovery strategies. `llm_parse_error` includes the raw text for re-prompting. `fork_partial` includes both succeeded and failed results for partial recovery. `spawn_summary_failed` preserves the child's output. The tradeoff: callers must pattern-match on error kinds instead of catching generic `Error`, but they get actionable information for recovery.

### Channels as standalone objects vs. state properties

We chose standalone `Channel<T>` objects over LangGraph-style state properties because they provide compile-time type safety (the channel object IS the connection) and clear scope/lifecycle rules. The tradeoff: slightly more setup (you create a channel object) vs. just declaring a state field, but you get type-checked `send`/`recv` and explicit semantics for `value`/`queue`/`topic` modes.

### `until` predicates returning `Verdict` vs. `boolean`

We chose `Verdict` with `stop`, `reason`, and `feedback` fields. Booleans provide no observability (you can't trace why a loop stopped) and no feedback injection (the Ralph Wiggum pattern needs the verification result to feed back into the next iteration). The tradeoff: predicate implementations are slightly more verbose, but every loop termination is traceable and debuggable.

### Memory layers as a separate plugin system vs. built into Context

We chose to make memory layers a plugin system with lifecycle hooks (`recall`, `store`, `onSpawn`, `onReturn`, `dispose`) rather than building memory management into the `Context` object. The alternative — putting working memory, semantic recall, etc. directly on `Context` — would make every agent pay for memory features it doesn't use, and would make it impossible to add new memory types without modifying the core. The tradeoff: more indirection (the View is assembled by the Projector, not read directly from Context), but memory layers are independently authorable, composable, and replaceable. A simple script can use zero layers; a production agent can use five — same runtime, same Step types.

### Event Log + Memory Layers vs. a single "context" concept

We chose to separate the Event Log (append-only conversation record) from memory layers (recall/store lifecycle hooks) because they have fundamentally different lifecycles. The Event Log is the raw record of what happened; memory layers are interpretations of that record (observations, entity extraction, embeddings). Conversation history is the baseline that memory layers augment — it gets the remainder of the token budget after layers are allocated, not a share of a common pool. This asymmetry is intentional: you can always inspect the raw Event Log, and memory layers can't suppress or rewrite conversation history.

---

## Build Sequence

Each stage produces a working system that can be tested. The spec updates after each stage to match what was actually built.

### Stage 1: Core Interpreter

The discriminated union `Step` type and the `execute` interpreter. Get the core switch working with `run`, `llm` (mocked), and `loop` + `until`. Write **ReAct** against this.

### Stage 2: Fork

`fork` with all three modes (`all`, `race`, `settle`). Write the parallel search pattern. This forces the merge types and `SettleResult` to be nailed down.

### Stage 3: Spawn with Fresh Context

`spawn` with `fresh` + `full`. Write **Ralph Wiggum**. This forces context isolation and the `prepareNext` feedback loop. State persistence across fresh boundaries is deferred to Stage 7 (memory layers).

### Stage 4: Channels

`channel` with `value` and `queue` modes. Write a two-step pipeline where one step produces and another consumes. This forces the async blocking model.

### Stage 5: Spawn with Summary/Schema

`spawn` with `summary` and `schema` contextOut strategies. Write **Slate thread weaving**. This forces the summary LLM call integration and the type overloads.

### Stage 6: Branch and Plans

`branch` and `compilePlan`. Write the **dynamic plan** pattern and **adaptive plan** loop. This forces agent resolution and the adaptive revision cycle.

### Stage 7: Memory Layer System

Implement the `MemoryLayer` interface, the Projector (View assembly), and the `workingMemory()` built-in. Write a ReAct agent with working memory and verify the recall/store lifecycle runs correctly on each iteration. This forces the budget allocation algorithm and the slot-ordering system.

### Stage 8: Memory Layers Across Spawn Boundaries

Implement `onSpawn`/`onReturn` hooks. Write Ralph Wiggum with `workingMemory({ scope: 'resource' })` and verify that structured state persists across fresh-context iterations while the Event Log resets. Add `observationalMemory()` and verify that observations compress across iterations.

### Stage 9: Error Model

Deliberately inject failures at every level and verify propagation matches the defined rules. Test `onError` on loops, `fork_partial` recovery, `spawn_summary_failed` fallback. Test memory layer error policies: init failure disables the layer, recall failure skips iteration, store failure is logged but doesn't block.

### Stage 10: Observability

Add span creation to the `execute` interpreter. Verify the trace tree matches the execution tree for all patterns. Verify memory layer trace spans include budget allocation, token usage, and hook duration.

---

## Full API Surface

```typescript
// === Builder Functions (construct Step variants) ===
export { step }          // step.run, step.llm, step.tool
export { branch }        // conditional routing
export { fork }          // parallel execution
export { spawn }         // child execution with context boundary
export { loop }          // repeating execution

// === Channels ===
export { channel }       // typed data flow

// === Termination ===
export { until }         // termination predicates namespace
export { any, all }      // until composition

// === Memory Layers ===
export { Slot }                  // named slot constants
export { workingMemory }         // structured/freeform state in View
export { semanticRecall }        // vector-search over past messages
export { observationalMemory }   // LLM-distilled observations
export { episodicMemory }        // execution summary retrieval
export { durableTaskState }      // task artifacts, checkpoints, git integration

// === Pattern Compositions (convenience, NOT variants) ===
export { react }         // ReAct loop
export { ralphWiggum }   // Ralph Wiggum meta-loop
export { taskTree }      // Hierarchical task decomposition
export { recursiveLLM }  // Recursive self-decomposition
export { threadWeave }   // Slate-style thread weaving
export { remote }        // A2A remote agent as Step
export { enforced }      // Plan enforcement wrapper
export { compilePlan }   // JSON plan -> executable task tree
export { adaptivePlan }  // Plan -> validate -> execute -> revise loop

// === Schemas ===
export { PlanNodeSchema }

// === Types ===
export type { Step, Context, Channel, Until, Verdict, Snapshot }
export type { Tool, StepMeta, Runtime, TaskNode, PlanNode }
export type { PlanConstraints, SpawnOpts, ForkOpts }
export type { SettleResult, Span, TraceExporter }
export type { ContextInStrategy, ContextOutStrategy }
export type { OrchidError, RetryPolicy, ModelParams }
export type { LoopOpts, BranchOpts, StepRunOpts, StepLLMOpts, StepToolOpts }
export type { EventLog, Message }

// === Memory Layer Types (full spec: MEMORY-LAYER-SPEC.md) ===
export type { MemoryLayer, MemoryHooks, MemoryScope, BudgetConfig }
export type { RecallParams, RecallResult, StoreParams, StoreResult }
export type { SpawnParams, SpawnResult, ReturnParams, ReturnResult }
export type { ExecutionContext, ScopedStorage, StorageAdapter }
export type { ProjectionPolicy, LayerTimeouts, MemoryTraceSpan }
```

**Variant count:** 1 type, 7 variants.
**Pattern count:** 7 compositions (each 15-30 lines).
**Memory layers:** 5 built-in factories + plugin interface for custom layers.
**Total named exports:** ~50 (types + values).

The patterns are compositions, not framework magic. You can read them, modify them, or build new ones from the same variants. Memory layers are plugins, not framework internals — if it satisfies the `MemoryLayer` interface, the runtime runs it.
