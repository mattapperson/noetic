# Step Variants: `runCode`, `callModel`, `invokeTool`, `withContext`

> **Depends On:** `01-step-type` (Step<I,O>, execute), `11-context-layer-system` (ContextLayer, ContextConfig)
> **Exports:** `runCode()`, `callModel()`, `invokeTool()`, `withContext()`, `StepRunCodeOpts`, `StepCallModelOpts`, `StepInvokeToolOpts`, `StepWithContextOpts`, `Tool`, `RetryPolicy`, `ModelParams`

---

## Variant: `runCode` — Arbitrary Async Work

Pure computation. The agent harness can retry freely, cache results, and doesn't need to track token usage.

```typescript
interface StepRunCodeOpts<I, O> {
  id: string;
  execute: (input: I, ctx: Context) => Promise<O>;
  retry?: RetryPolicy;
  /**
   * Per-step subprocess adapter override. When set, the interpreter
   * dispatches this step through the given adapter instead of the harness
   * default. Resolution order at dispatch time is
   * `detachedSpawn-overrides.subprocess ?? step.subprocess ?? harness.subprocess`.
   * Use an out-of-process adapter here to run this specific step in its own
   * OS child; use an in-memory test adapter to intercept the request and
   * assert on it from a unit test.
   */
  subprocess?: SubprocessAdapter;
}

interface RetryPolicy {
  maxAttempts: number;
  backoff: 'fixed' | 'linear' | 'exponential';
  initialDelay: number;  // ms
}
```

The `subprocess` field is preserved verbatim across step registration and interpreter dispatch. The same adapter is consulted by `harness.run()`, `spawn()`, and `harness.detachedSpawn()` when the dispatched step has it set. See `04-spawn` for routing semantics and `23-durable-execution` for how adapters carry durable handle manifests.

```typescript
const fetchData = runCode({
  id: 'fetch-user-data',
  execute: async (userId: string, ctx) => {
    const response = await fetch(`/api/users/${userId}`);
    return response.json();
  },
  retry: { maxAttempts: 3, backoff: 'exponential', initialDelay: 1000 },
});
```

---

## Variant: `callModel` — Single LLM Call

Costs tokens, needs model routing (OpenRouter, gateway, etc.), generates trace metadata with GenAI semantic conventions. Output may contain tool calls that drive the next iteration.

```typescript
type Lazy<T, TContext = ContextData> =
  | T
  | ((ctx: Context<TContext>) => T | Promise<T>);

interface StepCallModelOpts<TContext, O> {
  id: string;
  model: Lazy<string, TContext>;                    // e.g. 'anthropic/claude-sonnet-4-20250514' — or a (ctx) => string getter
  instructions?: Lazy<string | undefined, TContext>;
  tools?: Lazy<Tool[] | undefined, TContext>;       // allowed tool subset (undefined = all, [] = none)
  output?: StandardSchemaV1<unknown, O>;          // structured output schema (any Standard Schema v1)
  outputJsonSchema?: Record<string, unknown>;     // explicit JSON Schema override for non-Zod `output`
  params?: ModelParams;                            // temperature, topP, etc.
  emit?: boolean | ((eventType: string, data: Record<string, unknown>) => boolean);
}

interface ModelParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
}
```

### Lazy Params

`model`, `instructions`, and `tools` each accept either an eager value or a `(ctx) => value` getter resolved at step execution. Getters see the live `Context`, so a step can read `ctx.harness.config.params`, `ctx.unifiedTools`, or context layer state to produce per-run values without baking them in at build time.

- **Eager vs lazy — semantics are identical** after resolution. An eager `model: 'gpt-4'` behaves the same as `model: () => 'gpt-4'`.
- **Model validation moves to runtime for getters.** `callModel()` validates eager `model` strings at build time; function-form models are validated after resolution inside `executeLLM` with the same `MISSING_MODEL` `NoeticConfigError`.
- **Function-form `tools` do NOT contribute to `ctx.unifiedTools`.** `collectAllTools` skips them since they can't be inspected without a live context. Tools needed in the harness-wide pool should be registered via `AgentHarness.tools` (see spec 08).

```typescript
const planChat = callModel({
  id: 'plan-chat',
  model: (ctx) => ctx.harness.config.params.model as string,
  instructions: (ctx) => {
    const user = ctx.harness.config.params.instructions;
    return [user, PLAN_SYSTEM_PROMPT].filter(Boolean).join('\n\n');
  },
  tools: (ctx) => (ctx.unifiedTools ?? []).filter((t) => PLAN_MODE_TOOL_NAMES.has(t.name)),
});
```

### Structured Output Schemas: Standard Schema v1

`output` accepts any [Standard Schema v1](https://standardschema.dev/schema) validator (Zod, Valibot, ArkType, …). Zod schemas remain the validation fast path; other schemas run `schema['~standard'].validate` (sync or Promise), and the parsed/transformed value becomes the step output.

The model constraint uses a tiered conversion chain: Zod first via `z.toJSONSchema(..., { target: 'draft-07' })`, then the [Standard JSON Schema v1](https://standardschema.dev/json-schema) companion trait via `schema['~standard'].jsonSchema.input({ target: 'draft-07' })`, then the explicit `outputJsonSchema` fallback/override. Zod 4.2+, ArkType 2.1.28+, Zod Mini, VineJS, and Sury implement the trait; Valibot provides it through `toStandardJsonSchema()` from `@valibot/to-json-schema`. A validation-only schema with neither the trait nor an explicit override fails with `MISSING_JSON_SCHEMA`. This keeps the Zod-bound `@openrouter/agent` adaptation self-contained and adds no per-validator runtime dependency to Noetic.

```typescript
const analyze = callModel({
  id: 'analyze-code',
  model: 'anthropic/claude-sonnet-4-20250514',
  instructions: 'You are a code reviewer. Analyze the code for bugs.',
  tools: [searchTool, readFileTool],
  output: z.object({
    bugs: z.array(z.object({ line: z.number(), description: z.string() })),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
  }),
});
```

### LLM Provider Configuration

The agent harness uses the OpenRouter SDK internally for all LLM calls. The provider is configured via `LlmProviderConfig` on the `AgentHarness`:

```typescript
interface LlmProviderConfig {
  provider: 'openrouter';
  apiKey?: string;  // defaults to process.env.OPENROUTER_API_KEY
}
```

The agent harness constructs and manages the OpenRouter client internally. There is no user-facing `CallModelFn` — the adapter seam is the `LlmProviderConfig` on the harness.

```typescript
import { AgentHarness } from '@noetic-tools/core';

const harness = new AgentHarness({
  callModelDefaults: { provider: 'openrouter', apiKey: process.env.OPENROUTER_API_KEY },
});
```

### Unified Tool Set

Before execution begins, the agent harness walks the entire step tree and collects all `Tool` instances declared on `callModel` steps, plus tools provided by context layers. These are deduplicated by name (first-wins) into a **unified tool set** stored on the execution context.

Every LLM call receives the full unified tool set, preserving prompt cache across calls with different tool restrictions. Individual steps restrict which tools the model may invoke via the `tools` field on `StepCallModelOpts`:

- `tools: undefined` (or omitted) — unrestricted, model may call any tool
- `tools: [searchTool, readFileTool]` — model may only call these tools
- `tools: []` — no tools available for this step

The restriction is communicated to the provider via `tool_choice: { type: "allowed_tools", tools: [...] }` in the API call.

### OpenRouter Integration

The agent harness delegates LLM calls to the `@openrouter/sdk` internally. It:

1. Merges `StepCallModel.instructions` (from the step definition) with any system-role messages extracted from `items`, joined by `\n\n`. If only one source is present, that one is used. If neither is present, `instructions` is `undefined`.
2. Converts Noetic `Item[]` to OpenResponses input format.
3. Wraps the unified `Tool[]` into SDK tool objects, binding `ctx` into each `execute` closure.
4. Passes `tool_choice` with allowed subset when the step restricts tools.
5. Calls the SDK's `callModel()` — the SDK handles the tool call loop internally.
6. Converts the SDK response back to Noetic `Item[]` and `LLMResponse`.

### Tool Call Execution

The `executeLLM` function delegates to the OpenRouter SDK's `callModel` method, which handles the tool call loop internally. When the model response contains tool calls:

1. The SDK executes each tool call using the `Tool.execute` function.
2. Tool results are appended to the conversation.
3. The model is called again with the updated conversation.
4. This repeats until the model responds without tool calls or a terminal condition is met.

The agent harness does NOT implement its own tool call loop — the SDK owns this cycle. The `until.noToolCalls()` predicate (see `05-loop-and-until`) checks whether the *outer loop iteration* produced tool calls, not whether the SDK's internal cycle did. By the time `executeLLM` returns, all tool calls from that LLM invocation have been resolved.

The SDK returns a `ModelResult` with `getItemsStream()`. The agent harness appends response items to the `ItemLog`. The return type is `O` — the parsed output (or `string` if no `output` schema is specified). Tool calls, token usage, and cost are execution metadata accumulated on the context (see `07-context-and-event-log`):

```typescript
const result = await execute(analyze, codeSnippet, ctx);
// result is { bugs: Bug[], severity: Severity }

// Metadata on ctx.lastStepMeta:
// { toolCalls: FunctionCallItem[], usage: { inputTokens, outputTokens, cachedTokens }, cost, responseItems: Item[] }
```

### What the LLM Actually Sees: The View

A `callModel` step does NOT simply send the `system` prompt and the raw input. The agent harness assembles a **View** — the complete `Item[]` array sent to the model — via the context layer system (see `11-context-layer-system`). Before each LLM call, the agent harness:

1. Runs `recall()` on each context layer to gather contextual content.
2. Assembles system prompt item (`role: system`) + context layer output items (`role: developer`) + conversation history items into the View as `Item[]`.
3. Sends the View to the model. The View is `Item[]` — directly passable to the LLM provider as input.
4. After the response, runs `store()` on each context layer to persist learnings.

The `instructions` field on `StepCallModelOpts` becomes the agent's base instructions within the View (rendered as a `MessageItem` with `role: system`). Context layers inject additional context as `MessageItem` entries with `role: developer`.

### `StepMeta`

```typescript
interface StepMeta {
  toolCalls?: FunctionCallItem[];
  usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  cost?: number;
  responseItems?: ReadonlyArray<Item>;
}
```

---

## Variant: `invokeTool` — Single Tool Execution

May have side effects, may need human approval before execution (preventive gating), and may need sandboxing.

```typescript
interface StepInvokeToolOpts<I, O> {
  id: string;
  tool: Tool<I, O>;
  args?: Partial<I>;  // can override LLM-provided args
}
```

---

## The `Tool` Type

```typescript
interface ToolContextDeclaration<TState = unknown> {
  id?: string;            // shared id = shared state; defaults to tool.name
  init: () => TState;
  recall: (state: TState) => string | null;
}

interface Tool<I extends StandardSchemaV1 = StandardSchemaV1, O extends StandardSchemaV1 = StandardSchemaV1> {
  name: string;
  description: string;
  input: I;                      // any Standard Schema v1
  output: O;                     // any Standard Schema v1
  inputJsonSchema?: Record<string, unknown>;  // explicit override/fallback for non-Zod input
  event?: StandardSchemaV1;      // validates streaming events yielded during execution
  execute: (args: InferSchemaOutput<I>, ctx: Context) => Promise<InferSchemaOutput<O>>;
  needsApproval?: boolean;  // preventive gating, not reactive throwing
  context?: ToolContextDeclaration;
}
```

`toolCalls(tools)` generates one `ContextLayer` per unique `context.id` among the tools. Tools sharing the same id share state.

Tool `input`/`output`/`event` accept any Standard Schema v1 validator. The runtime validates tool input through `validateSchema` (Zod `safeParse` fast path, otherwise `~standard.validate` with sync/Promise support), and the parsed/transformed input is what `execute` receives. As before, `output` and `event` describe and infer tool values but are not runtime validation boundaries. Tool input JSON Schema uses the same Zod → StandardJSONSchemaV1 → explicit `inputJsonSchema` chain. For non-Zod schemas, `inputJsonSchema` overrides the trait and also serves as the fallback if the trait converter throws; a validation-only schema must provide it.

Zod stays the default everywhere else in the framework — channels, context-layer schemas, item extension schemas, and JSON workflow schemas remain Zod-specific.

---

## Variant: `withContext` — Scoped Context Layer Injection

Attaches context layers to a descendant step subtree without creating an isolated context. Analogous to React's `Context.Provider` — the layers are available to all descendant `callModel` steps without the context boundary that `spawn` introduces.

```typescript
interface StepWithContextOpts<TContext, I, O> {
  id: string;
  child: Step<TContext, I, O>;
  context: ContextConfig | ContextLayer[];
}
```

```typescript
const withContextLayers = withContext({
  id: 'inject-scratchpad',
  child: analyzeAndRespond,
  context: context([scratchpad(), semanticRecall({ embedder })]),
});
```

### Semantics

1. **No context boundary.** Unlike `spawn`, the child step shares the parent's `Context` and `ItemLog`. There is no `onSpawn`/`onReturn` lifecycle.
2. **Layer merging.** The provided layers are appended to whatever layers the parent already has. Descendant `callModel` steps see the merged set.
3. **Scoped lifetime.** Provided layers are initialized when `withContext` begins and disposed when the child completes. They do not outlive the `withContext` boundary.
4. **Composable.** `withContext` steps can nest. Inner `withContext` layers merge with outer ones. Duplicate layer IDs follow the same resolution rules as top-level layer deduplication (see `11-context-layer-system`).

### When to Use `withContext` vs `spawn`

| Concern | `withContext` | `spawn` |
|---------|-----------|---------|
| Context isolation | Shared — same ItemLog | Isolated — fresh ItemLog |
| Context layers | Merged with parent | Replaced or propagated via `onSpawn` |
| Use case | "Add capabilities to this subtree" | "Run this work with a different context window" |

---

## Builder: `workflow` — JSON Workflow as a Step

Runs a `WorkflowDocument` (spec 26) as a single composable step. Not a new `Step` kind — the builder returns a `StepRunCode` whose `execute` hydrates the document via the harness on the execution context and runs it.

```typescript
workflow(opts: {
  id: string;
  document?: WorkflowDocument;   // inline — XOR with ref
  ref?: string;                  // named, resolved from workflows
  tools?: Tool[];
  layers?: ReadonlyMap<string, ContextLayer>;
  workflows?: ReadonlyMap<string, WorkflowDocument>;
  acpAgents?: ReadonlyMap<string, AcpAgent>;
  uiLibraries?: ReadonlyMap<string, OutputCodec>;
  resolveSubprocess?: (ref: string) => SubprocessAdapter | undefined;
  isolation?: 'inherit' | 'spawn';
}): StepRunCode<ContextData, string, string>
```

Semantics:

- **Lazy resolution, memoized.** The document resolves on first execution (a `ref` may target a workflow registered after the step is built); the hydrated tree is reused across executions.
- **Isolation.** `'inherit'` (default) runs the hydrated tree in the caller's session; `'spawn'` wraps it in `spawn({ id: `${id}-spawn` })` for a fresh context boundary.
- **Cycle safety.** When built from a `ref`, that name seeds the subflow ancestry chain, so a self-referencing named workflow fails with `WORKFLOW_CYCLE` instead of recursing.
- **Errors.** `EMPTY_STEP_ID`; `INVALID_WORKFLOW_SOURCE` unless exactly one of `document`/`ref` is set; at execution time `MISSING_HARNESS_CONTEXT` without `ctx.harness` and `UNKNOWN_WORKFLOW_REFERENCE` for an unregistered `ref`.
- **Portability.** `workflow` is exported from the main entry only; the `/portable` surface omits it, keeping the hydrator out of restricted runtimes.

---

## Why Four Execution Variants?

The agent harness needs to treat them differently:

- **callModel steps** have cost implications, need model routing, produce telemetry with GenAI semantic conventions, and their output may contain tool calls that drive the next iteration.
- **invokeTool steps** may have side effects, may need human approval before execution, and may need sandboxing.
- **runCode steps** are pure computation — the agent harness can retry freely, cache results, and doesn't need to track token usage.
- **withContext steps** are structural — they configure the context layer environment for a subtree without altering execution semantics or creating context boundaries.

A single `step()` that inspects its arguments loses type safety and forces runtime introspection. Explicit variants mean the TypeScript compiler knows exactly what you're doing.
