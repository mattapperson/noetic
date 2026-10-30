# Step Type

> **Depends On:** (none — this is the root)
> **Exports:** `Step<I, O>`, `execute()` signature, the `O` contract

---

## The `Step<I, O>` Discriminated Union

`Step` is a single type with eight variants. The runtime pattern-matches on `kind`. Builder functions (`runCode(...)`, `inParallel(...)`, etc.) are constructors for the union variants.

```typescript
type Step<I, O> =
  | { kind: 'runCode';     id: string; execute: (input: I, ctx: Context) => Promise<O>; retry?: RetryPolicy; subprocess?: SubprocessAdapter }
  | { kind: 'callModel';     id: string; model: string; instructions?: string; tools?: Tool[]; output?: StandardSchemaV1<unknown, O>; outputJsonSchema?: Record<string, unknown>; params?: ModelParams }
  | { kind: 'invokeTool';    id: string; tool: Tool<I, O>; args?: Partial<I> }
  | { kind: 'decide';  id: string; model?: string; questions: DecideQuestions; view: 'full' | 'layers' | 'none'; samples: number }
  | { kind: 'conditional';  id: string; route: (input: I, ctx: Context, run: ExecuteStepFn) => Step<I, O> | null }
  | { kind: 'inParallel';    id: string; mode: 'race';   paths: (input: I, ctx: Context) => Step<I, O>[]; concurrency?: number }
  | { kind: 'inParallel';    id: string; mode: 'all';    paths: (input: I, ctx: Context) => Step<I, O>[]; merge: MergeFn<O>; concurrency?: number }
  | { kind: 'inParallel';    id: string; mode: 'settle'; paths: (input: I, ctx: Context) => Step<I, O>[]; merge: MergeFn<O, SettleResult<O>>; concurrency?: number }
  | { kind: 'spawn';   id: string; child: Step<I, O>; context?: ContextLayer[]; timeout?: number; subprocess?: SubprocessAdapter }
  | { kind: 'withContext'; id: string; child: Step<I, O>; context: ContextConfig | ContextLayer[] }
  | { kind: 'loop';    id: string; steps: ReadonlyArray<Step<I, O>>; until: Until | StepDecide; maxIterations?: number; maxHistorySize?: number; prepareNext?: (output: O, verdict: Verdict, ctx: Context) => I; onError?: (error: NoeticError, ctx: Context) => 'retry' | 'skip' | 'abort' }
  | { kind: 'sequence'; id: string; steps: ReadonlyArray<Step<I, O>> }
```

### Arrays of steps

An array of steps runs in sequence, each step's output the next one's input,
everywhere Noetic takes a step: `harness.run` and `ctx.harness.run`, a
harness's `agentGraph`, `spawn` and `withContext` children, `schedule` bodies,
each `inParallel` path, a `conditional` route's pick, a wait's `around` and a
verify's `act`. There is no `step.sequence` builder. The builders turn an
array of two or more steps into a `sequence` step (one step is itself; an
empty array is `EMPTY_STEP_ARRAY`), whose id joins its children's ids with
` > `. The interpreter runs each child as its own step, with its own ledger
path, events and gates. Tree walks (tool collection, custom items, connection
needs, the optimizer) see through it: the optimizer gives a sequence's
children the paths they would have as siblings.

`Step` is invariant in `I` and `O`, so an array is typed by its elements
rather than by one `Step<I, O>`: `StepArray` is a non-empty tuple of
`StepLike`, `StepArrayInput<T>` is the first step's input and
`StepArrayOutput<T>` the last step's output. `run` infers both, so
`harness.run([parse, count], text, ctx)` takes what `parse` takes and gives
what `count` gives. Where a builder's own type parameters fix `I` and `O`
(`spawn<C, I, O>({ child: [...] })`), the array's steps are not checked
against them.

Every variant also carries the replay controls from `StepReplay`, omitted above for width:

```typescript
interface StepReplay<I> {
  durable?: boolean;                               // default true; false = never recorded or replayed
  replayKey?(input: I, ctx: Context): string;      // ledger key replacing the execution path
}
```

They govern step-level resume: a resumed execution replays a recorded step's output instead of running it, keyed by execution path unless `replayKey` names a content key, and skipping the ledger entirely for `durable: false`. See `23a-step-level-resume` § Identity.

Every variant also carries `emitItems` and `customItems` from `StepEmitItems`:

```typescript
type StepEmitItemsResult = string | Item | ReadonlyArray<Item> | undefined;
type StepEmitItemsFn<O> = (output: O, ctx: Context) => StepEmitItemsResult | Promise<StepEmitItemsResult>;

interface StepEmitItems<I, O, M extends CustomItemMap> {
  emitItems?: boolean | StepEmitItemsFn<O> | StepEmitItemsConfig<I, O, M>;  // hook form: spec 34
  customItems?: M;                                                          // items only this step may emit
}
```

### Emitting items

A step's output normally reaches the user only when it is the workflow's final output, or when the step is a `callModel` whose model writes a message. `emitItems` lets any step add items to the conversation as soon as it finishes. Once the step completes, the interpreter appends the items to `ctx.itemLog` and emits `item_appended` for each one (`08-runtime`), so `getItemStream` carries them while the rest of the tree is still running. A step inside a loop body, or a `decide` step used as the loop's `until`, emits on every iteration, before the loop's exit test ends it.

What a step emits is one or more `Item`s (`07-context-and-event-log`), not only messages:

- `true` emits the output as a final item. An object (or, for a JSON node, JSON text) whose `type` names a custom item in the step's scope becomes that item (`34-custom-items`). Another `Item` is appended as given. A string becomes an assistant `message`; anything else, its JSON text (`null`/`undefined` emit nothing).
- The hook form `{ item, onStart, onDone }` runs `onStart` with the input as the step starts and `onDone` with the output as it finishes. Naming a declared custom `item`, the hooks stream its events and give its final item (`34-custom-items` § Emitting).
- A function picks from the output. Text becomes an assistant message; an `Item`, or a list of them, is appended as given. That includes any custom item type the context's item schemas accept: a harness-wide `itemSchemas` extension, named `prefix:name` after the Open Responses convention for extension items. An item no schema accepts fails the step with `item_schema_mismatch`. `undefined` or an empty string emits nothing, so one step can emit on some runs and stay quiet on others.
- Only a step that completes emits. A step that throws emits nothing, and a `schedule` never completes, so it never emits. Emitting runs inside the dispatch: an item the schemas refuse fails the step, which then gives its dispatch ordinal back like any other failure.
- `emitItems` is separate from the framework-event filter `emit` on `callModel`, `decide`, and `acp-agent`, and that filter does not gate it: like the SDK item events, emitted items always stream.
- Emitted items are conversation items like any other: later `callModel` steps see them in their history, and `HarnessResponse.items` includes them.

#### On resume

Emitted items are appended through the step's lane, so the step's ledger entry records them with its other `items`. Its `streamed` indices mark which items it emitted (`23a-step-level-resume` § The ledger). The marks travel up with the items: an enclosing step's entry holds its children's items and their marks, so a parent that replays as a whole still knows what its children emitted.

A replay re-appends a recorded entry's `items` to the log, quietly by default. The harness option `emitItemsOnReplay` (`08-runtime`) makes it also stream the marked items again as `item_appended`, so a client that reconnects to a resumed run sees the progress it missed. It is one setting for the whole harness rather than a per-step choice, because whether to re-stream depends on the client watching, not on the step. Items the step appended any other way go back on the log but never stream.

The optional `subprocess?: SubprocessAdapter` field on `runCode` and `spawn` variants is a per-step adapter override. When set, the interpreter dispatches that step through the given adapter instead of the harness default. Resolution order at dispatch time is `detachedSpawn-overrides.subprocess ?? step.subprocess ?? harness.subprocess`. See `04-spawn` for adapter routing and `23-durable-execution` for durability guarantees.

Schemas on `llm` output and `Tool` input/output/event accept any [Standard Schema v1](https://standardschema.dev/schema) validator. Model-facing JSON Schema resolves through Zod's native converter, then the [Standard JSON Schema v1](https://standardschema.dev/json-schema) companion trait, then an explicit raw JSON Schema override (`outputJsonSchema`, tool `inputJsonSchema`). Validation scope is limited to these tool/LLM/ACP-agent boundaries — channels, context-layer schemas, item extension schemas, and JSON workflow schemas remain Zod-specific. See `02-step-variants`.

Each variant is specified in its own feature spec:

| Variant | Spec | Purpose |
|---------|------|---------|
| `runCode` | `02-step-variants` | Arbitrary async work |
| `callModel` | `02-step-variants` | Single LLM call |
| `invokeTool` | `02-step-variants` | Single tool execution |
| `decide` | `32-decide` | Typed questions answered with probabilities |
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
    case 'decide':      return executeDecide(step, input, ctx);
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
