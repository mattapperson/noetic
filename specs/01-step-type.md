# Step Type

> **Depends On:** (none — this is the root)
> **Exports:** `Step<I, O>`, `execute()` signature, the `O` contract

---

## The `Step<I, O>` Discriminated Union

`Step` is a single type with seven variants. The runtime pattern-matches on `kind`. Builder functions (`step.run(...)`, `fork(...)`, etc.) are constructors for the union variants.

```typescript
type Step<I, O> =
  | { kind: 'run';    id: string; execute: (input: I, ctx: Context) => Promise<O>; retry?: RetryPolicy }
  | { kind: 'llm';    id: string; model: string; system?: string; tools?: Tool[]; output?: ZodType<O>; params?: ModelParams }
  | { kind: 'tool';   id: string; tool: Tool; args?: unknown }
  | { kind: 'branch'; id: string; route: (input: I, ctx: Context) => Step<I, O> | null }
  | { kind: 'fork';   id: string; mode: 'all' | 'race' | 'settle'; paths: (input: I, ctx: Context) => Step<I, O>[]; merge?: MergeFn<O>; concurrency?: number }
  | { kind: 'spawn';  id: string; child: Step<I, O>; contextIn: ContextInStrategy; contextOut: ContextOutStrategy<O>; timeout?: number }
  | { kind: 'loop';   id: string; body: Step<I, O>; until: Until; maxIterations?: number; maxHistorySize?: number; prepareNext?: (output: O, verdict: Verdict, ctx: Context) => I; onError?: (error: OrchidError, ctx: Context) => 'retry' | 'skip' | 'abort' }
```

Each variant is specified in its own feature spec:

| Variant | Spec | Purpose |
|---------|------|---------|
| `run` | `02-step-variants` | Arbitrary async work |
| `llm` | `02-step-variants` | Single LLM call |
| `tool` | `02-step-variants` | Single tool execution |
| `branch` | `03-control-flow` | Conditional routing |
| `fork` | `03-control-flow` | Parallel execution |
| `spawn` | `04-spawn` | Child execution with context boundary |
| `loop` | `05-loop-and-until` | Repeating execution with termination |

## The `execute()` Interpreter

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

## The `O` Contract

`O` is always the business value — the thing the next step receives. Execution metadata (tool calls, token usage, cost) lives on the `Context` (see `07-context-and-event-log`), not the return value.

```typescript
const result = await execute(analyze, codeSnippet, ctx);
// result is { bugs: Bug[], severity: Severity } — just O, nothing else.

// Metadata is on the context:
ctx.lastStepMeta; // { toolCalls: FunctionCallItem[], usage: TokenUsage, cost: number, responseItems: Item[] }
```

This means `Step<I, O>` is an honest contract: input `I`, output `O`, always. This is analogous to how OpenTelemetry works — spans carry metadata, the function return carries the business value.

## Cross-References

- `Context` type referenced here is defined in `07-context-and-event-log`
- `RetryPolicy`, `ModelParams`, `Tool` are defined in `02-step-variants`
- `MergeFn`, `SettleResult` are defined in `03-control-flow`
- `ContextInStrategy`, `ContextOutStrategy` are defined in `04-spawn`
- `Until`, `Verdict` are defined in `05-loop-and-until`
- `OrchidError` is defined in `09-error-model`
