# JSON Workflow Runtime

> **Depends On:** `01-step-type` (Step, Until), `02-step-variants` (step.llm, step.tool), `03-control-flow` (branch, fork), `04-spawn` (spawn), `05-loop-and-until` (loop, until), `08-runtime` (AgentHarness), `13-patterns` (patterns namespace)
> **Exports:** `WorkflowDocument`, `WorkflowNode`, `WorkflowDocumentSchema`, `WorkflowNodeSchema`, `UntilPredicateSchema`, `MergeStrategySchema`, `hydrateWorkflow`, `hydrateNode`, `dynamicWorkflow`, `parseAndRunWorkflow`

---

## Motivation

Step trees in noetic are built programmatically: TypeScript code calls builders like `step.llm(...)`, `loop(...)`, `fork(...)` and wires them together at compile time. This works when the workflow shape is known ahead of time.

But many agent patterns need the shape to emerge at runtime:

1. **Plan-then-execute** -- An LLM generates a multi-step plan as structured output, then the harness executes it. The plan shape is not known until the model responds.
2. **Portable workflows** -- JSON documents can be stored in databases, passed between processes, shared across language boundaries, and audited after the fact. Closures cannot.
3. **User-authored workflows** -- End users or low-code tools define agent behavior as JSON configuration without writing TypeScript.
4. **Replay and inspection** -- A JSON workflow is a complete, inspectable record of what the agent intended to do, independent of execution state.

The JSON Workflow Runtime bridges these worlds: an LLM (or any producer) emits a `WorkflowDocument`, the runtime validates it, hydrates it into a native `Step` tree, and executes it with the same interpreter, memory layers, and observability as hand-written compositions.

---

## Workflow Document Format

A workflow document is a versioned envelope around a single root node:

```typescript
interface WorkflowDocument {
  version: 1;
  root: WorkflowNode;
}
```

The `version` field enables forward-compatible parsing. Consumers reject documents with an unrecognised version rather than silently misinterpreting them.

```typescript
const WorkflowDocumentSchema = z.object({
  version: z.literal(1),
  root: WorkflowNodeSchema,
});
```

---

## WorkflowNode Union

`WorkflowNode` is a discriminated union on `kind` with nine variants. Each maps to an existing `Step` builder. All nodes share a common `id` field.

```typescript
type WorkflowNode =
  | LlmWorkflowNode
  | ToolWorkflowNode
  | BranchWorkflowNode
  | ForkWorkflowNode
  | SpawnWorkflowNode
  | ProvideWorkflowNode
  | LoopWorkflowNode
  | SequenceWorkflowNode
  | EveryWorkflowNode;
```

### `llm`

A single LLM call.

```typescript
interface LlmWorkflowNode {
  kind: 'llm';
  id: string;
  model?: string;
  instructions: string;
  tools?: string[];
  params?: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    stopSequences?: string[];
  };
}
```

| Field          | Required | Description                                              |
|----------------|----------|----------------------------------------------------------|
| `model`        | No       | Model identifier. Falls back to the harness default.     |
| `instructions` | Yes      | System instructions for this LLM call.                   |
| `tools`        | No       | Tool names resolved from the hydration context registry.  |
| `params`       | No       | Model-level sampling parameters.                         |

### `tool`

A single tool execution, independent of an LLM call.

```typescript
interface ToolWorkflowNode {
  kind: 'tool';
  id: string;
  toolName: string;
  args?: Record<string, unknown>;
}
```

| Field      | Required | Description                                         |
|------------|----------|-----------------------------------------------------|
| `toolName` | Yes      | Name of a tool in the hydration context registry.   |
| `args`     | No       | Static arguments passed to the tool at execution.   |

### `branch`

Conditional routing based on substring matching against the input.

```typescript
interface BranchWorkflowNode {
  kind: 'branch';
  id: string;
  routes: Array<{ match: string; target: WorkflowNode }>;
  default?: WorkflowNode;
}
```

| Field     | Required | Description                                                        |
|-----------|----------|--------------------------------------------------------------------|
| `routes`  | Yes      | Ordered list of match/target pairs. First matching route wins.     |
| `default` | No       | Fallback node when no route matches. Omitting produces a no-op.   |

Each route's `match` string is tested as a case-insensitive substring against the string representation of the input. This keeps the JSON schema simple and LLM-friendly; closures are not JSON-serialisable.

### `fork`

Parallel execution with merge.

```typescript
interface ForkWorkflowNode {
  kind: 'fork';
  id: string;
  mode: 'race' | 'all' | 'settle';
  paths: WorkflowNode[];
  merge?: MergeStrategy;
  concurrency?: number;
}
```

| Field         | Required | Description                                                 |
|---------------|----------|-------------------------------------------------------------|
| `mode`        | Yes      | Execution strategy: `race`, `all`, or `settle`.             |
| `paths`       | Yes      | Array of child nodes to execute in parallel.                |
| `merge`       | No       | How to combine results. Default: `last`.                    |
| `concurrency` | No       | Maximum number of paths running simultaneously.             |

### `spawn`

Child execution with a fresh context boundary.

```typescript
interface SpawnWorkflowNode {
  kind: 'spawn';
  id: string;
  child: WorkflowNode;
  timeout?: number;
}
```

| Field     | Required | Description                                          |
|-----------|----------|------------------------------------------------------|
| `child`   | Yes      | The workflow subtree to execute in the child context. |
| `timeout` | No       | Maximum wall-clock milliseconds for the child.       |

### `provide`

Scoped memory layer injection.

```typescript
interface ProvideWorkflowNode {
  kind: 'provide';
  id: string;
  child: WorkflowNode;
  layers: string[];
}
```

| Field    | Required | Description                                                        |
|----------|----------|--------------------------------------------------------------------|
| `child`  | Yes      | The workflow subtree that receives the layers.                     |
| `layers` | Yes      | Memory layer names resolved from the hydration context registry.   |

### `loop`

Repeating execution with termination.

```typescript
interface LoopWorkflowNode {
  kind: 'loop';
  id: string;
  body: WorkflowNode;
  until: UntilPredicate;
  maxIterations?: number;
}
```

| Field           | Required | Description                                             |
|-----------------|----------|---------------------------------------------------------|
| `body`          | Yes      | The step tree executed each iteration.                  |
| `until`         | Yes      | Termination predicate (see Until Predicates below).     |
| `maxIterations` | No       | Hard safety cap. Defaults to the runtime's global cap.  |

### `sequence`

Ordered sequential execution. Output of each step becomes the input to the next.

```typescript
interface SequenceWorkflowNode {
  kind: 'sequence';
  id: string;
  steps: WorkflowNode[];
}
```

| Field   | Required | Description                                  |
|---------|----------|----------------------------------------------|
| `steps` | Yes      | Ordered array of child nodes to execute.     |

### `every`

Periodic execution at a fixed interval.

```typescript
interface EveryWorkflowNode {
  kind: 'every';
  id: string;
  step: WorkflowNode;
  ms: number;
  onError?: 'continue' | 'fail';
}
```

| Field     | Required | Description                                                           |
|-----------|----------|-----------------------------------------------------------------------|
| `step`    | Yes      | The step to execute each interval.                                    |
| `ms`      | Yes      | Interval in milliseconds between executions.                          |
| `onError` | No       | Error handling: `continue` (default) swallows; `fail` propagates.    |

---

## Until Predicates

Until predicates are JSON-serialisable termination conditions for `loop` nodes. They form a discriminated union on `kind` that mirrors the runtime `until.*` predicates.

```typescript
type UntilPredicate =
  | { kind: 'maxSteps';       n: number }
  | { kind: 'maxCost';        usd: number }
  | { kind: 'maxDuration';    ms: number }
  | { kind: 'noToolCalls' }
  | { kind: 'outputContains'; marker: string }
  | { kind: 'outputEquals';   sentinel: string }
  | { kind: 'converged';      threshold?: number }
  | { kind: 'any';            predicates: UntilPredicate[] }
  | { kind: 'all';            predicates: UntilPredicate[] };
```

### Predicate Reference

| Kind             | Fields          | Equivalent Runtime Predicate     | Description                                    |
|------------------|-----------------|----------------------------------|------------------------------------------------|
| `maxSteps`       | `n`             | `until.maxSteps(n)`              | Stop after `n` iterations.                     |
| `maxCost`        | `usd`           | `until.maxCost(usd)`            | Stop when cumulative cost exceeds threshold.   |
| `maxDuration`    | `ms`            | `until.maxDuration(ms)`         | Stop after wall-clock time exceeds threshold.  |
| `noToolCalls`    | --              | `until.noToolCalls()`           | Stop when the LLM produces no tool calls.      |
| `outputContains` | `marker`        | `until.outputContains(marker)`  | Stop when output contains the marker string.   |
| `outputEquals`   | `sentinel`      | `until.outputEquals(sentinel)`  | Stop when output exactly equals the sentinel.  |
| `converged`      | `threshold?`    | `until.converged({threshold})`  | Stop when consecutive outputs are similar.     |
| `any`            | `predicates[]`  | `any(...predicates)`            | Stop when any child predicate fires.           |
| `all`            | `predicates[]`  | `all(...predicates)`            | Stop when all child predicates agree.          |

### Schema

```typescript
const UntilPredicateSchema: z.ZodType<UntilPredicate> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('maxSteps'),       n: z.number().int().positive() }),
    z.object({ kind: z.literal('maxCost'),        usd: z.number().positive() }),
    z.object({ kind: z.literal('maxDuration'),    ms: z.number().int().positive() }),
    z.object({ kind: z.literal('noToolCalls') }),
    z.object({ kind: z.literal('outputContains'), marker: z.string().min(1) }),
    z.object({ kind: z.literal('outputEquals'),   sentinel: z.string() }),
    z.object({ kind: z.literal('converged'),      threshold: z.number().min(0).max(1).optional() }),
    z.object({ kind: z.literal('any'),            predicates: z.array(UntilPredicateSchema).min(1) }),
    z.object({ kind: z.literal('all'),            predicates: z.array(UntilPredicateSchema).min(1) }),
  ])
);
```

---

## Merge Strategies

Fork nodes use a `MergeStrategy` to combine results from parallel paths. This replaces the closure-based `MergeFn<O>` from the native `fork()` builder with a named enum.

```typescript
type MergeStrategy = 'last' | 'first' | 'concat';
```

| Strategy | Behavior                                                                 |
|----------|--------------------------------------------------------------------------|
| `last`   | Return the result of the last-completed path. This is the default.       |
| `first`  | Return the result of the first-completed path. Equivalent to `race`.     |
| `concat` | Concatenate all results into a single string (joined with newlines).     |

```typescript
const MergeStrategySchema = z.enum(['last', 'first', 'concat']);
```

---

## Hydration

Hydration converts a `WorkflowDocument` into a live `Step` tree that the interpreter can execute. The process is recursive, deterministic, and pure (no side effects).

### Hydration Context

```typescript
interface HydrationContext {
  tools: Map<string, Tool>;
  executeStep: <I, O>(step: Step<I, O>, input: I, ctx: Context) => Promise<O>;
  defaultModel?: string;
  maxDepth?: number;
}
```

| Field          | Required | Description                                                          |
|----------------|----------|----------------------------------------------------------------------|
| `tools`        | Yes      | Registry mapping tool names to live `Tool` objects.                  |
| `executeStep`  | Yes      | The interpreter's `execute` function, threaded for recursive calls.  |
| `defaultModel` | No       | Fallback model for `llm` nodes that omit `model`.                    |
| `maxDepth`     | No       | Maximum tree depth enforced during hydration. Default: `32`.         |

### `hydrateWorkflow`

Top-level entry point. Validates the document, then hydrates the root node.

```typescript
function hydrateWorkflow(
  doc: WorkflowDocument,
  ctx: HydrationContext,
): Step<string, string>
```

Throws `INVALID_WORKFLOW` if the document fails schema validation. Throws `WORKFLOW_TOO_DEEP` if the tree exceeds `maxDepth`.

### `hydrateNode`

Recursive hydrator for a single node. Called by `hydrateWorkflow` and available for partial hydration.

```typescript
function hydrateNode(
  node: WorkflowNode,
  ctx: HydrationContext,
  depth?: number,
): Step<string, string>
```

### Node-to-Builder Mapping

Each node kind maps to a single existing builder:

| Node Kind   | Builder                   | Notes                                                  |
|-------------|---------------------------|--------------------------------------------------------|
| `llm`       | `step.llm({...})`         | Tools resolved by name from `ctx.tools`.               |
| `tool`      | `step.tool({...})`        | Tool resolved by name; throws `UNKNOWN_TOOL_REFERENCE`.|
| `branch`    | `branch({route: ...})`    | Route function does substring matching on input.       |
| `fork`      | `fork({...})`             | `paths` becomes a static function. Merge via strategy. |
| `spawn`     | `spawn({...})`            | Child hydrated recursively.                            |
| `provide`   | `provide({...})`          | Layer names resolved from hydration context.           |
| `loop`      | `loop({...})`             | Until predicate hydrated to runtime `Until` function.  |
| `sequence`  | `step.run` + chaining     | Steps piped sequentially via composed `execute` calls. |
| `every`     | `every({...})`            | Maps directly to the `every()` builder.                |

### Tool Resolution

Tool names in `llm.tools` and `tool.toolName` are resolved against `ctx.tools` at hydration time. If a name is not found, hydration throws:

```typescript
{
  kind: 'UNKNOWN_TOOL_REFERENCE',
  message: `Tool "${name}" not found in registry. Available: ${[...ctx.tools.keys()].join(', ')}`,
}
```

This is a hard failure -- partial hydration with missing tools is not supported. The caller must ensure all referenced tools are registered before hydration.

### Branch Route Hydration

Branch `routes` are hydrated into a `route` function that tests each `match` string as a case-insensitive substring against `String(input)`:

```typescript
route: (input, ctx) => {
  const text = String(input).toLowerCase();
  for (const { match, target } of routes) {
    if (text.includes(match.toLowerCase())) {
      return hydrateNode(target, hydrationCtx);
    }
  }
  return defaultNode ? hydrateNode(defaultNode, hydrationCtx) : null;
}
```

### Until Predicate Hydration

Each `UntilPredicate` node maps to a runtime `until.*` call:

```typescript
function hydrateUntil(pred: UntilPredicate): Until {
  switch (pred.kind) {
    case 'maxSteps':       return until.maxSteps(pred.n);
    case 'maxCost':        return until.maxCost(pred.usd);
    case 'maxDuration':    return until.maxDuration(pred.ms);
    case 'noToolCalls':    return until.noToolCalls();
    case 'outputContains': return until.outputContains(pred.marker);
    case 'outputEquals':   return until.outputEquals(pred.sentinel);
    case 'converged':      return until.converged(pred.threshold ? { threshold: pred.threshold } : undefined);
    case 'any':            return any(...pred.predicates.map(hydrateUntil));
    case 'all':            return all(...pred.predicates.map(hydrateUntil));
  }
}
```

### Depth Enforcement

The `depth` counter increments at each structural node (`fork`, `spawn`, `loop`, `sequence`, `branch`, `provide`). Leaf nodes (`llm`, `tool`, `every`) do not increment depth. If `depth` exceeds `ctx.maxDepth`, hydration throws `WORKFLOW_TOO_DEEP`.

---

## AgentHarness Integration

Two high-level integration points connect JSON workflows to the harness.

### `dynamicWorkflow` -- LLM-Generated Workflows

A `Step` that uses an LLM to generate a workflow document as structured output, validates it, hydrates it, and executes it within the same session.

```typescript
function dynamicWorkflow(opts: {
  id?: string;
  model: string;
  instructions: string;
  tools: Map<string, Tool>;
  maxRevisions?: number;
  maxDepth?: number;
}): Step<string, string>
```

Execution flow:

1. Call the LLM with `WorkflowDocumentSchema` as the structured output schema.
2. Validate the response against `WorkflowDocumentSchema`.
3. If validation fails and revisions remain, feed the validation errors back to the LLM and retry from step 1.
4. If validation succeeds, hydrate the document via `hydrateWorkflow`.
5. Execute the hydrated `Step` tree with the current context.

```typescript
const planner = dynamicWorkflow({
  model: 'anthropic/claude-sonnet-4-20250514',
  instructions: `You are a workflow planner. Given a task description,
    generate a workflow document that accomplishes the task.
    Available tools: ${[...tools.keys()].join(', ')}`,
  tools: toolRegistry,
  maxRevisions: 3,
});

const result = await execute(planner, 'Analyze the codebase and fix all lint errors', ctx);
```

`maxRevisions` defaults to `2`. Each revision re-prompts the LLM with the previous attempt and the validation error. If all revisions are exhausted, execution throws `WORKFLOW_GENERATION_FAILED`.

### `parseAndRunWorkflow` -- Pre-Built Workflows

A standalone utility for executing a workflow document that already exists (loaded from a file, database, or API response).

```typescript
function parseAndRunWorkflow(opts: {
  document: unknown;
  tools: Map<string, Tool>;
  executeStep: <I, O>(step: Step<I, O>, input: I, ctx: Context) => Promise<O>;
  defaultModel?: string;
  maxDepth?: number;
}): Step<string, string>
```

This validates the document, hydrates it, and returns the resulting `Step`. The caller executes it with the interpreter like any other step:

```typescript
const workflow = parseAndRunWorkflow({
  document: JSON.parse(workflowJson),
  tools: toolRegistry,
  executeStep: execute,
});

const result = await execute(workflow, userPrompt, ctx);
```

---

## Constraints

### No `step.run`

`step.run` accepts an `execute` closure, which is not JSON-serialisable. WorkflowNode does not include a `run` variant. Arbitrary computation must be expressed through tool calls or LLM steps.

### Static Lazy Fields Only

All fields in `WorkflowNode` are static JSON values. Fields that accept functions in the native builders (e.g., `fork.paths`, `branch.route`) are replaced with declarative equivalents (static arrays, substring match lists).

### Tool Names Resolved at Hydration Time

Tool references are strings, not `Tool` objects. Resolution happens once during hydration, not at each execution. If the tool registry changes after hydration, the hydrated step tree continues to reference the tools that were resolved at hydration time.

### Maximum Tree Depth

Tree depth is enforced during hydration to prevent unbounded recursion in LLM-generated workflows. The default limit is `32` levels of structural nesting. This is configurable via `HydrationContext.maxDepth`.

---

## Relationship to FlowSchema

`FlowSchema` (defined in `memory/flow-schema.ts`, used by the plan-memory layer) is a JSON-serialisable workflow format that predates `WorkflowNode`. The two formats serve different audiences and scopes:

| Dimension        | FlowSchema                            | WorkflowNode                                    |
|------------------|---------------------------------------|--------------------------------------------------|
| **Scope**        | Plan-mode flows (plan memory layer)   | General-purpose runtime workflow format          |
| **Node kinds**   | 5: llm, subagent, fork, spawn, sequence | 9: llm, tool, branch, fork, spawn, provide, loop, sequence, every |
| **Until support**| None                                  | Full predicate union with combinators            |
| **Model params** | None                                  | temperature, topP, maxTokens, stopSequences      |
| **Tool args**    | None (tools on llm only)              | Explicit tool node with static args              |
| **Memory layers**| None                                  | `provide` node with layer name resolution        |
| **Periodics**    | None                                  | `every` node with interval + error handling      |
| **Branching**    | None                                  | `branch` with substring match routes             |

`FlowSchema` is intentionally minimal -- it describes what the planner wants to happen. `WorkflowNode` is comprehensive -- it describes exactly how the runtime should execute it, including termination conditions, parallelism strategies, and memory scoping.

The two schemas are independent. `FlowSchema` documents are not valid `WorkflowDocument`s and vice versa. A migration utility is not provided; the plan-memory layer continues to use `FlowSchema` for its narrower purpose.

---

## Error Kinds

The JSON Workflow Runtime introduces the following `NoeticError` kinds:

| Kind                         | When                                                          |
|------------------------------|---------------------------------------------------------------|
| `INVALID_WORKFLOW`           | Document fails `WorkflowDocumentSchema` validation.           |
| `WORKFLOW_TOO_DEEP`          | Tree depth exceeds `maxDepth` during hydration.               |
| `UNKNOWN_TOOL_REFERENCE`     | A tool name in the document is not in the hydration registry. |
| `WORKFLOW_GENERATION_FAILED` | `dynamicWorkflow` exhausts all revision attempts.             |

---

## Full Schema

The complete Zod schema for reference:

```typescript
const WorkflowNodeSchema: z.ZodType<WorkflowNode> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('llm'),
      id: z.string().min(1),
      model: z.string().optional(),
      instructions: z.string(),
      tools: z.array(z.string()).optional(),
      params: z.object({
        temperature: z.number().min(0).max(2).optional(),
        topP: z.number().min(0).max(1).optional(),
        maxTokens: z.number().int().positive().optional(),
        stopSequences: z.array(z.string()).optional(),
      }).optional(),
    }),
    z.object({
      kind: z.literal('tool'),
      id: z.string().min(1),
      toolName: z.string().min(1),
      args: z.record(z.unknown()).optional(),
    }),
    z.object({
      kind: z.literal('branch'),
      id: z.string().min(1),
      routes: z.array(z.object({
        match: z.string().min(1),
        target: WorkflowNodeSchema,
      })).min(1),
      default: WorkflowNodeSchema.optional(),
    }),
    z.object({
      kind: z.literal('fork'),
      id: z.string().min(1),
      mode: z.enum(['race', 'all', 'settle']),
      paths: z.array(WorkflowNodeSchema).min(1),
      merge: MergeStrategySchema.optional(),
      concurrency: z.number().int().positive().optional(),
    }),
    z.object({
      kind: z.literal('spawn'),
      id: z.string().min(1),
      child: WorkflowNodeSchema,
      timeout: z.number().int().positive().optional(),
    }),
    z.object({
      kind: z.literal('provide'),
      id: z.string().min(1),
      child: WorkflowNodeSchema,
      layers: z.array(z.string().min(1)).min(1),
    }),
    z.object({
      kind: z.literal('loop'),
      id: z.string().min(1),
      body: WorkflowNodeSchema,
      until: UntilPredicateSchema,
      maxIterations: z.number().int().positive().optional(),
    }),
    z.object({
      kind: z.literal('sequence'),
      id: z.string().min(1),
      steps: z.array(WorkflowNodeSchema).min(1),
    }),
    z.object({
      kind: z.literal('every'),
      id: z.string().min(1),
      step: WorkflowNodeSchema,
      ms: z.number().int().positive(),
      onError: z.enum(['continue', 'fail']).optional(),
    }),
  ])
);

const WorkflowDocumentSchema = z.object({
  version: z.literal(1),
  root: WorkflowNodeSchema,
});
```

---

## Cross-References

- `Step<I, O>` discriminated union: `01-step-type`
- `step.llm`, `step.tool` builders: `02-step-variants`
- `branch()`, `fork()`, `MergeFn`: `03-control-flow`
- `spawn()`: `04-spawn`
- `loop()`, `every()`, `until.*`, `any()`, `all()`: `05-loop-and-until`
- `Context`, `Item`, `ItemLog`: `07-context-and-event-log`
- `AgentHarness`, `Tool`: `08-runtime`
- `NoeticError` kinds: `09-error-model`
- `MemoryLayer`: `11-memory-layer-system`
- `FlowSchema`, `FlowNode`: `memory/flow-schema.ts` (plan-memory internal)
- `compilePlan`, `adaptivePlan`, `PlanNodeSchema`: `13-patterns`

---

## Future Considerations

- **Custom until predicates via registered names.** A plugin could register a named predicate (e.g., `until.custom('myCheck')`) that the hydrator resolves from a predicate registry, similar to tool name resolution. This would allow domain-specific termination logic without extending the schema.
- **Workflow composition and sub-workflow references.** A `ref` node kind that points to another `WorkflowDocument` by URI, enabling modular workflow libraries. The hydrator would fetch and inline the referenced document, with cycle detection.
- **Streaming hydration.** For very large workflows, hydrate nodes lazily as execution reaches them rather than building the entire `Step` tree upfront. This reduces memory pressure and startup latency.
- **Named memory layer resolution for `provide` nodes.** The current design uses string layer names, but the resolution mechanism is left to the `HydrationContext`. A standardised layer registry (analogous to the tool registry) would make `provide` nodes portable across different harness configurations.
- **Workflow versioning and migration.** When `version` increments to `2`, a `migrateV1toV2` function would transform old documents automatically. The version field exists to enable this without breaking existing consumers.
- **Conditional until predicates.** Predicates that inspect specific fields of structured output (e.g., `outputField('status', 'complete')`) rather than treating output as an opaque string.
