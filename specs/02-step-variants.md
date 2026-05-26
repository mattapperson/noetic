# Step Variants: `run`, `llm`, `tool`, `provide`

> **Depends On:** `01-step-type` (Step<I,O>, execute), `11-memory-layer-system` (MemoryLayer, MemoryConfig)
> **Exports:** `step.run()`, `step.llm()`, `step.tool()`, `step.provide()`, `StepRunOpts`, `StepLLMOpts`, `StepToolOpts`, `StepProvideOpts`, `Tool`, `RetryPolicy`, `ModelParams`

---

## Variant: `run` — Arbitrary Async Work

Pure computation. The agent harness can retry freely, cache results, and doesn't need to track token usage.

```typescript
interface StepRunOpts<I, O> {
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

## Variant: `llm` — Single LLM Call

Costs tokens, needs model routing (OpenRouter, gateway, etc.), generates trace metadata with GenAI semantic conventions. Output may contain tool calls that drive the next iteration.

```typescript
type Lazy<T, TMemory = ContextMemory> =
  | T
  | ((ctx: Context<TMemory>) => T | Promise<T>);

interface StepLLMOpts<TMemory, O> {
  id: string;
  model: Lazy<string, TMemory>;                    // e.g. 'anthropic/claude-sonnet-4-20250514' — or a (ctx) => string getter
  instructions?: Lazy<string | undefined, TMemory>;
  tools?: Lazy<Tool[] | undefined, TMemory>;       // allowed tool subset (undefined = all, [] = none)
  output?: ZodType<O>;                             // structured output schema
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

`model`, `instructions`, and `tools` each accept either an eager value or a `(ctx) => value` getter resolved at step execution. Getters see the live `Context`, so a step can read `ctx.harness.config.params`, `ctx.unifiedTools`, or memory layer state to produce per-run values without baking them in at build time.

- **Eager vs lazy — semantics are identical** after resolution. An eager `model: 'gpt-4'` behaves the same as `model: () => 'gpt-4'`.
- **Model validation moves to runtime for getters.** `step.llm()` validates eager `model` strings at build time; function-form models are validated after resolution inside `executeLLM` with the same `MISSING_MODEL` `NoeticConfigError`.
- **Function-form `tools` do NOT contribute to `ctx.unifiedTools`.** `collectAllTools` skips them since they can't be inspected without a live context. Tools needed in the harness-wide pool should be registered via `AgentHarness.tools` (see spec 08).

```typescript
const planChat = step.llm({
  id: 'plan-chat',
  model: (ctx) => ctx.harness.config.params.model as string,
  instructions: (ctx) => {
    const user = ctx.harness.config.params.instructions;
    return [user, PLAN_SYSTEM_PROMPT].filter(Boolean).join('\n\n');
  },
  tools: (ctx) => (ctx.unifiedTools ?? []).filter((t) => PLAN_MODE_TOOL_NAMES.has(t.name)),
});
```

```typescript
const analyze = step.llm({
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
  llm: { provider: 'openrouter', apiKey: process.env.OPENROUTER_API_KEY },
});
```

### Unified Tool Set

Before execution begins, the agent harness walks the entire step tree and collects all `Tool` instances declared on LLM steps, plus tools provided by memory layers. These are deduplicated by name (first-wins) into a **unified tool set** stored on the execution context.

Every LLM call receives the full unified tool set, preserving prompt cache across calls with different tool restrictions. Individual steps restrict which tools the model may invoke via the `tools` field on `StepLLMOpts`:

- `tools: undefined` (or omitted) — unrestricted, model may call any tool
- `tools: [searchTool, readFileTool]` — model may only call these tools
- `tools: []` — no tools available for this step

The restriction is communicated to the provider via `tool_choice: { type: "allowed_tools", tools: [...] }` in the API call.

### OpenRouter Integration

The agent harness delegates LLM calls to the `@openrouter/sdk` internally. It:

1. Merges `StepLLM.instructions` (from the step definition) with any system-role messages extracted from `items`, joined by `\n\n`. If only one source is present, that one is used. If neither is present, `instructions` is `undefined`.
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

An `llm` step does NOT simply send the `system` prompt and the raw input. The agent harness assembles a **View** — the complete `Item[]` array sent to the model — via the Memory Layer system (see `11-memory-layer-system`). Before each LLM call, the agent harness:

1. Runs `recall()` on each memory layer to gather contextual content.
2. Assembles system prompt item (`role: system`) + memory layer output items (`role: developer`) + conversation history items into the View as `Item[]`.
3. Sends the View to the model. The View is `Item[]` — directly passable to the LLM provider as input.
4. After the response, runs `store()` on each memory layer to persist learnings.

The `instructions` field on `StepLLMOpts` becomes the agent's base instructions within the View (rendered as a `MessageItem` with `role: system`). Memory layers inject additional context as `MessageItem` entries with `role: developer`.

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

## Variant: `tool` — Single Tool Execution

May have side effects, may need human approval before execution (preventive gating), and may need sandboxing.

```typescript
interface StepToolOpts<I, O> {
  id: string;
  tool: Tool<I, O>;
  args?: Partial<I>;  // can override LLM-provided args
}
```

---

## The `Tool` Type

```typescript
interface ToolMemoryDeclaration<TState = unknown> {
  id?: string;            // shared id = shared state; defaults to tool.name
  init: () => TState;
  recall: (state: TState) => string | null;
}

interface Tool<I extends ZodTypeAny = ZodTypeAny, O extends ZodTypeAny = ZodTypeAny> {
  name: string;
  description: string;
  input: I;
  output: O;
  execute: (args: z.infer<I>, ctx: Context) => Promise<z.infer<O>>;
  needsApproval?: boolean;  // preventive gating, not reactive throwing
  memory?: ToolMemoryDeclaration;
}
```

`toolMemoryLayer(tools)` generates one `MemoryLayer` per unique `memory.id` among the tools. Tools sharing the same id share state.

---

## Variant: `provide` — Scoped Memory Layer Injection

Attaches memory layers to a descendant step subtree without creating an isolated context. Analogous to React's `Context.Provider` — the layers are available to all descendant `llm` steps without the context boundary that `spawn` introduces.

```typescript
interface StepProvideOpts<TMemory, I, O> {
  id: string;
  child: Step<TMemory, I, O>;
  memory: MemoryConfig | MemoryLayer[];
}
```

```typescript
const withMemory = step.provide({
  id: 'inject-working-memory',
  child: analyzeAndRespond,
  memory: memory([workingMemory(), semanticRecall({ embedder })]),
});
```

### Semantics

1. **No context boundary.** Unlike `spawn`, the child step shares the parent's `Context` and `ItemLog`. There is no `onSpawn`/`onReturn` lifecycle.
2. **Layer merging.** The provided layers are appended to whatever layers the parent already has. Descendant `llm` steps see the merged set.
3. **Scoped lifetime.** Provided layers are initialized when `provide` begins and disposed when the child completes. They do not outlive the `provide` boundary.
4. **Composable.** `provide` steps can nest. Inner `provide` layers merge with outer ones. Duplicate layer IDs follow the same resolution rules as top-level layer deduplication (see `11-memory-layer-system`).

### When to Use `provide` vs `spawn`

| Concern | `provide` | `spawn` |
|---------|-----------|---------|
| Context isolation | Shared — same ItemLog | Isolated — fresh ItemLog |
| Memory layers | Merged with parent | Replaced or propagated via `onSpawn` |
| Use case | "Add capabilities to this subtree" | "Run this work with a different context window" |

---

## Why Four Execution Variants?

The agent harness needs to treat them differently:

- **LLM steps** have cost implications, need model routing, produce telemetry with GenAI semantic conventions, and their output may contain tool calls that drive the next iteration.
- **Tool steps** may have side effects, may need human approval before execution, and may need sandboxing.
- **Run steps** are pure computation — the agent harness can retry freely, cache results, and doesn't need to track token usage.
- **Provide steps** are structural — they configure the memory layer environment for a subtree without altering execution semantics or creating context boundaries.

A single `step()` that inspects its arguments loses type safety and forces runtime introspection. Explicit variants mean the TypeScript compiler knows exactly what you're doing.
