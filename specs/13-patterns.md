# Pattern Derivations

> **Depends On:** `01-step-type` (Step, execute), `02-step-variants` (step.run, step.llm, Tool), `03-control-flow` (fork), `04-spawn` (spawn, contextIn, contextOut), `05-loop-and-until` (loop, until, any), `07-context-and-event-log` (Context), `11-memory-layer-system` (memory layer lifecycle)
> **Exports:** `react()`, `ralphWiggum()`, `taskTree()`, `enforced()`, `recursiveLLM()`, `threadWeave()`, `remote()`, `compilePlan()`, `adaptivePlan()`, `TaskNode`, `PlanNode`, `PlanNodeSchema`, `PlanConstraints`, `WorkerDispatch`

---

Every pattern is 15-30 lines of primitive composition. The implementations below are real, not pseudocode.

---

## ReAct

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

**Primitives used:** `loop` + `step.llm` + `until.noToolCalls` + `until.maxSteps`.

**Event Log strategy:** Accumulate. No spawn boundary — tool call results append to the Event Log. Memory layers `recall()`/`store()` run each iteration.

---

## Ralph Wiggum Loop

Wraps an inner pattern in an outer loop where each iteration gets a fresh Event Log. All state that survives across iterations is managed by memory layers.

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

**Primitives used:** `loop` + `spawn(contextIn: fresh)` + `react` (inner) + `until.verified`.

**Memory layer interaction:** `durableTaskState()` handles task artifacts across fresh boundaries. `workingMemory({ scope: 'resource' })` carries structured progress. `observationalMemory()` compresses learnings from past iterations into the next View.

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

## Task Trees with Plan Enforcement

A task tree is a recursive structure: each node either executes directly (leaf) or decomposes into children.

```typescript
interface TaskNode<I, O> {
  id: string;
  execute: Step<I, O>;
  children?: TaskNode<any, any>[];
  childExecution?: 'parallel' | 'sequential';
  merge?: (childResults: any[], ctx: Context) => O;
}
```

No string IDs for dependencies. Data flows through the tree structure itself. Sequential children pipe output → input. Parallel children receive the parent's output and their results are merged.

### `enforced()` — Preventive Plan Enforcement

```typescript
interface PlanConstraints {
  toolAllowlist?: Record<string, string[]>;
  maxStepsPerNode?: number;
  requireApproval?: string[];
  validate?: (taskId: string, input: unknown, ctx: Context) => Promise<boolean>;
}
```

`toolAllowlist` modifies the tool list passed to `step.llm` — the LLM never sees disallowed tools. `requireApproval` pauses execution and waits on a channel for human input. No tokens wasted on rejected tool calls.

---

## Recursive LLM Decomposition

An agent that decomposes its task by spawning child instances of itself with focused sub-context.

```typescript
function recursiveLLM<I, O>(opts: {
  model: string;
  system: string;
  tools?: Tool[];
  decompose: (input: I, ctx: Context) => Promise<I[] | null>;
  merge: (results: O[], ctx: Context) => Promise<O>;
  maxDepth: number;
}): Step<I, O>
```

**Primitives used:** `step.run` (outer) + `fork` (parallel children) + `spawn(contextIn: custom, contextOut: summary)` + self-reference for recursion. Depth control via `ctx.depth`.

**Memory layer interaction:** `scope: 'global'` layers (shared knowledge) available to all children. Each child's `onReturn` merges discoveries back into parent state.

---

## Slate Thread Weaving

An orchestrator dispatches parallel worker threads. Workers run in fresh contexts and return episodic summaries.

```typescript
function threadWeave<O>(opts: {
  orchestrator: { model: string; system: string };
  workers: Record<string, { model: string; system: string; tools: Tool[] }>;
  dispatch: Step<string, WorkerDispatch[]>;
  maxParallel?: number;
  maxRounds?: number;
}): Step<string, O>

interface WorkerDispatch {
  workerName: string;
  prompt: string;
  tools?: string[];
}
```

**Primitives used:** `loop` (orchestrator rounds) + `fork` (parallel workers) + `spawn(contextIn: fresh, contextOut: summary)` + `react` (inner worker loop).

**Memory layer interaction:** Orchestrator's `observationalMemory()` accumulates worker summaries. `sharedSwarmMemory()` enables real-time finding sharing between concurrent workers.

---

## A2A Protocol

A2A is `spawn` + `step.run` over HTTP. Remote agents are wrapped in Steps that compose like local ones.

```typescript
function remote<O = string>(opts: {
  url: string;
  output?: ZodTypeAny;
  auth?: { type: 'bearer'; token: string };
  timeout?: number;
}): Step<string, O>
```

No separate "Protocol" primitive. A2A transport complexity (task lifecycle, SSE streaming, capability negotiation) is a runtime concern. Remote agents compose with `fork`, `loop`, `taskTree` identically to local steps.

---

## Dynamic Plans: `compilePlan` and `adaptivePlan`

### Schema

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

### Compiler

```typescript
function compilePlan<O>(
  plan: PlanNode,
  agents: Record<string, (prompt: string) => Step<string, unknown>>,
  constraints?: PlanConstraints,
): Step<string, O>
```

Invalid agent references throw with available options listed.

### Adaptive Plans

For agents that modify their own execution structure:

```typescript
function adaptivePlan<O>(opts: {
  planner: Step<string, PlanNode>;
  agents: Record<string, (prompt: string) => Step<string, unknown>>;
  constraints: PlanConstraints;
  maxRevisions: number;
}): Step<string, O>
```

Wraps `compilePlan` in a plan → validate → execute → revise loop. Feeds validation errors and partial failure results back to the planner.
