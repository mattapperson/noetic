# Step Variants: `run`, `llm`, `tool`

> **Depends On:** `01-step-type` (Step<I,O>, execute)
> **Exports:** `step.run()`, `step.llm()`, `step.tool()`, `StepRunOpts`, `StepLLMOpts`, `StepToolOpts`, `Tool`, `RetryPolicy`, `ModelParams`

---

## Variant: `run` — Arbitrary Async Work

Pure computation. The agent harness can retry freely, cache results, and doesn't need to track token usage.

```typescript
interface StepRunOpts<I, O> {
  id: string;
  execute: (input: I, ctx: Context) => Promise<O>;
  retry?: RetryPolicy;
}

interface RetryPolicy {
  maxAttempts: number;
  backoff: 'fixed' | 'linear' | 'exponential';
  initialDelay: number;  // ms
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

## Variant: `llm` — Single LLM Call

Costs tokens, needs model routing (OpenRouter, gateway, etc.), generates trace metadata with GenAI semantic conventions. Output may contain tool calls that drive the next iteration.

```typescript
interface StepLLMOpts<O> {
  id: string;
  model: string;              // e.g. 'anthropic/claude-sonnet-4-20250514'
  system?: string;
  tools?: Tool[];             // tools available for THIS call
  output?: ZodType<O>;        // structured output schema
  params?: ModelParams;       // temperature, topP, etc.
  emit?: boolean | ((eventType: string, data: Record<string, unknown>) => boolean);
}

interface ModelParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
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
import { AgentHarness } from '@noetic/core';

const harness = new AgentHarness({
  llm: { provider: 'openrouter', apiKey: process.env.OPENROUTER_API_KEY },
});
```

### OpenRouter Integration

The agent harness delegates LLM calls to the `@openrouter/sdk` internally. It:

1. Extracts system messages from `items` and passes them as `instructions`.
2. Converts Noetic `Item[]` to OpenResponses input format.
3. Wraps Noetic `Tool[]` into SDK tool objects, binding `ctx` into each `execute` closure.
4. Calls the SDK's `callModel()` — the SDK handles the tool call loop internally.
5. Converts the SDK response back to Noetic `Item[]` and `LLMResponse`.

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

The `system` field on `StepLLMOpts` becomes the agent's base instructions within the View (rendered as a `MessageItem` with `role: system`). Memory layers inject additional context as `MessageItem` entries with `role: developer`.

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

## Why Three Execution Variants?

The agent harness needs to treat them differently:

- **LLM steps** have cost implications, need model routing, produce telemetry with GenAI semantic conventions, and their output may contain tool calls that drive the next iteration.
- **Tool steps** may have side effects, may need human approval before execution, and may need sandboxing.
- **Run steps** are pure computation — the agent harness can retry freely, cache results, and doesn't need to track token usage.

A single `step()` that inspects its arguments loses type safety and forces runtime introspection. Explicit variants mean the TypeScript compiler knows exactly what you're doing.
