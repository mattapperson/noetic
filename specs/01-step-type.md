# Step Type

> **Depends On:** (none — this is the root)
> **Exports:** `Step<I, O>`, `execute()` signature, the `O` contract

---

## The `Step<I, O>` Discriminated Union

`Step` is a single type with eight variants. The runtime pattern-matches on `kind`. Builder functions (`step.runCode(...)`, `inParallel(...)`, etc.) are constructors for the union variants.

```typescript
type Step<I, O> =
  | { kind: 'runCode';     id: string; execute: (input: I, ctx: Context) => Promise<O>; retry?: RetryPolicy; subprocess?: SubprocessAdapter }
  | { kind: 'callModel';     id: string; model: string; instructions?: string; tools?: Tool[]; output?: ZodType<O>; params?: ModelParams }
  | { kind: 'invokeTool';    id: string; tool: Tool; args?: unknown }
  | { kind: 'conditional';  id: string; route: (input: I, ctx: Context) => Step<I, O> | null }
  | { kind: 'inParallel';    id: string; mode: 'all' | 'race' | 'settle'; paths: (input: I, ctx: Context) => Step<I, O>[]; merge?: MergeFn<O>; concurrency?: number }
  | { kind: 'spawn';   id: string; child: Step<I, O>; context?: ContextLayer[]; timeout?: number; subprocess?: SubprocessAdapter }
  | { kind: 'withContext'; id: string; child: Step<I, O>; context: ContextConfig | ContextLayer[] }
  | { kind: 'loop';    id: string; body: Step<I, O>; until: Until; maxIterations?: number; maxHistorySize?: number; prepareNext?: (output: O, verdict: Verdict, ctx: Context) => I; onError?: (error: NoeticError, ctx: Context) => 'retry' | 'skip' | 'abort' }
```

The optional `subprocess?: SubprocessAdapter` field on `runCode` and `spawn` variants is a per-step adapter override. When set, the interpreter dispatches that step through the given adapter instead of the harness default. Resolution order at dispatch time is `detachedSpawn-overrides.subprocess ?? step.subprocess ?? harness.subprocess`. See `04-spawn` for adapter routing and `23-durable-execution` for durability guarantees.

Each variant is specified in its own feature spec:

| Variant | Spec | Purpose |
|---------|------|---------|
| `runCode` | `02-step-variants` | Arbitrary async work |
| `callModel` | `02-step-variants` | Single LLM call |
| `invokeTool` | `02-step-variants` | Single tool execution |
| `conditional` | `03-control-flow` | Conditional routing |
| `inParallel` | `03-control-flow` | Parallel execution |
| `spawn` | `04-spawn` | Child execution with context boundary |
| `withContext` | `02-step-variants` | Scoped context layer injection |
| `loop` | `05-loop-and-until` | Repeating execution with termination |

## The `execute()` Interpreter

The runtime is a single recursive interpreter:

```typescript
async function execute<I, O>(step: Step<I, O>, input: I, ctx: Context): Promise<O> {
  switch (step.kind) {
    case 'runCode':     return executeRun(step, input, ctx);
    case 'callModel':   return executeLLM(step, input, ctx);
    case 'invokeTool':  return executeTool(step, input, ctx);
    case 'conditional': return executeBranch(step, input, ctx);
    case 'inParallel':  return executeFork(step, input, ctx);
    case 'spawn':       return executeSpawn(step, input, ctx);
    case 'withContext': return executeProvide(step, input, ctx);
    case 'loop':        return executeLoop(step, input, ctx);
  }
}
```

This makes the "everything is a Step" claim true at the type level. The primitive count debate dissolves: one type, eight variants.

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
- `ContextLayer` is defined in `11-context-layer-system`
- `Until`, `Verdict` are defined in `05-loop-and-until`
- `NoeticError` is defined in `09-error-model`
- `SubprocessAdapter` is defined in `08-runtime`; per-step override semantics and the shared step registry live in `04-spawn`, and durable execution in `23-durable-execution`.
