# Step Variants: `runCode`, `callModel`, `invokeTool`, `withContext`

> **Depends On:** `01-step-type` (Step<I,O>, execute), `11-context-layer-system` (ContextLayer, ContextConfig)
> **Exports:** `runCode()`, `callModel()`, `invokeTool()`, `withContext()`, `RunCodeOpts`, `CallModelOpts`, `InvokeToolOpts`, `WithContextOpts`, `Tool`, `RetryPolicy`, `ModelParams`

---

## Variant: `runCode` — Arbitrary Async Work

Pure computation. The agent harness can retry freely, cache results, and doesn't need to track token usage.

Every builder below (and every other step builder) also accepts the `StepReplay` fields from `01-step-type` — `durable` and `replayKey` — and copies them onto the step it builds. See `23a-step-level-resume` § Identity.

```typescript
interface RunCodeOpts<TContext, I, O> extends StepReplay<TContext, I> {
  id: string;
  execute: (input: I, ctx: Context<TContext>) => Promise<O>;
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

interface CallModelOpts<TContext, O, I = unknown> extends StepReplay<TContext, I> {
  id: string;
  model: Lazy<string, TContext>;                    // e.g. 'anthropic/claude-sonnet-4-20250514' — or a (ctx) => string getter
  instructions?: Lazy<string | undefined, TContext>;
  // Allowed tool subset (undefined = all, [] = none). A `ServerToolSpec` is an
  // OpenRouter server tool the provider executes itself (e.g. web search).
  tools?: Lazy<(Tool | ServerToolSpec)[] | undefined, TContext>;
  output?: StandardSchemaV1<unknown, O> | OutputCodec<O>;        // structured output schema or streaming codec (see 28-generative-ui)
  outputJsonSchema?: Record<string, unknown>;     // explicit JSON Schema override for non-Zod `output`
  params?: ModelParams;                            // temperature, topP, etc.
  emit?: boolean | ((eventType: string, data: Record<string, unknown>) => boolean);
}

interface ModelParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];    // deprecated: accepted, never sent (see below)
  serviceTier?: ServiceTier;   // OpenRouter service tier, forwarded unchanged
}

// ESM literal enum (`ServiceTier.Ultrafast`, ...) plus the matching union type.
type ServiceTier = 'auto' | 'default' | 'fast' | 'flex' | 'priority' | 'scale' | 'ultrafast';
```

`serviceTier` asks OpenRouter for a processing tier: `fast` is an alias for `priority`; `ultrafast` prefers ultrafast endpoints and falls back to `priority`, then default endpoints. The tier the provider actually served lands on `LLMResponse.serviceTier` (taken from the last round) and on `ctx.lastStepMeta.serviceTier`. Both stay `undefined` when the provider reports no tier — they never echo the requested value, so a mismatch with the request means a fallback happened.

`temperature`, `topP`, `maxTokens` (as `maxOutputTokens`) and `serviceTier` are forwarded on every round. `stopSequences` is not: the OpenRouter Responses API that `callModel` runs on has no stop parameter, so the value is accepted (on steps, `CallModelRequest`, and workflow `params`) and ignored. It is deprecated and leaves the type and the workflow schema in the next major.

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
  provider?: 'noetic' | 'openrouter';  // default 'noetic'
  apiKey?: string;                     // default: NOETIC_API_KEY or OPENROUTER_API_KEY, per provider
  baseUrl?: string;                    // override the API base URL (advanced / self-host)
  cache?: boolean;                     // send `X-OpenRouter-Cache: true` on every model call
}
```

- **`provider`.** `'noetic'` (the default) targets the Noetic platform (`https://platform.noetic.tools/v1`), which serves managed, metered inference through the same OpenRouter-compatible API. `'openrouter'` calls OpenRouter directly with the caller's own key.
- **`apiKey`.** Falls back to `NOETIC_API_KEY` for `'noetic'` and `OPENROUTER_API_KEY` for `'openrouter'`. The other provider's variable is never read, so `OPENROUTER_API_KEY` alone does nothing unless `provider: 'openrouter'` is set. With no key at all, the first model call fails with `NoeticConfigError` `NO_LLM_PROVIDER`.
- **`baseUrl`.** For `'noetic'` it falls back to `NOETIC_BASE_URL`, then the platform URL. For `'openrouter'` it falls back to the SDK's default endpoint.
- **`cache`.** Asks OpenRouter to serve identical requests from its response cache without billing them again, which suits deterministic re-runs (evals, regression suites). Defaults to `false`.

The agent harness constructs and manages the OpenRouter client internally. There is no user-facing `CallModelFn` — the adapter seam is the `LlmProviderConfig` on the harness.

```typescript
import { AgentHarness } from '@noetic-tools/core';

const harness = new AgentHarness({
  callModelDefaults: { provider: 'openrouter', apiKey: process.env.OPENROUTER_API_KEY },
});
```

### Unified Tool Set

Before execution begins, the agent harness walks the entire step tree and collects all `Tool` instances declared on `callModel` steps, plus tools provided by context layers. These are deduplicated by name (first-wins) into a **unified tool set** stored on the execution context.

The unified set is the pool every `callModel` step draws from. A step narrows it with the `tools` field on `CallModelOpts`, which the interpreter turns into `allowedToolNames` on the `CallModelRequest`:

- `tools: undefined` (or omitted) — unrestricted, model may call any tool in the unified set
- `tools: [searchTool, readFileTool]` — model may only call these tools
- `tools: []` — no tools available for this step

Every LLM call that may use a client tool receives the full unified tool set, in the same order, so the tool definitions — part of the provider's prompt-cache prefix — are byte-identical across every step in the tree, whatever each step allows. The restriction travels separately, in two layers:

1. **Request.** The step's allowed subset is sent as the request's tool choice, which the model honours when picking a tool. The mapping from `tools` to `tool_choice`:

   | Step `tools` | Tools sent | `tool_choice` |
   |---|---|---|
   | omitted | full unified set | not set (provider default, `auto`) |
   | `[a, b]` | full unified set | `{ type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "a" }, { type: "function", name: "b" }, ...server tools] }` |
   | `[]`, or a subset that names no tool in the set | none | not set |

   Function names in `allowed_tools` are the sanitised wire names the model sees. Server tools (`ServerToolSpec` entries, run by the provider) are appended to the tools sent and, when the step restricts, listed in `allowed_tools` as `{ type: "<server tool type>" }`. `mode` is always `auto`: the model may answer without calling a tool.
2. **Execution.** The harness tool loop (see Tool Call Execution) only runs tools in the allowed subset. A function call naming any other tool — a provider that ignores `allowed_tools`, or a model that names a tool anyway — is answered with an `Error: unknown tool '<name>'` tool result and never runs.

A step with no tools sends none rather than the full set with `tool_choice: "none"`: some models still write tool-call syntax as text when told not to call, so withholding the list is the safer way to say "no tools".

### OpenRouter Integration

The agent harness delegates LLM calls to the `@openrouter/sdk` internally. It:

1. Merges the step's resolved instructions with any system-role messages extracted from the View, joined by `\n\n` (see What the LLM Actually Sees). If only one source is present, that one is used. If neither is present, `instructions` is `undefined`.
2. Converts Noetic `Item[]` to OpenResponses input format.
3. Converts the unified `Tool[]` into SDK tool definitions — name, description and input JSON Schema, with no `execute`, so the SDK never runs a tool itself — and appends any server tools for the provider to run.
4. Passes the step's restriction as `toolChoice: { type: "allowed_tools", ... }` when the step restricts tools (see Unified Tool Set).
5. Calls the SDK's `callModel()` once per round of the harness tool loop (see Tool Call Execution).
6. Converts each round's response back to Noetic `Item[]` and folds the rounds into one `LLMResponse`.

### Tool Call Execution

The agent harness owns the tool call loop. The SDK makes one model request per round and never runs a tool: the tool definitions it receives carry no `execute`. Owning the loop lets the harness run steering checks, tool UI and spans around every call, inject queued messages between rounds, and recover from bad rounds. One `callModel` step runs these rounds:

1. **Request.** Send the conversation so far (the View plus this step's earlier rounds) to the SDK's `callModel()`, streaming its events to the session broadcaster through `getFullResponsesStream()` and reading the finished response from `getResponse()`.
2. **Stop check.** If the round's output holds no function calls, the step is done.
3. **Run tools.** Otherwise run each function call in order: look the tool up in the step's allowed subset (see Unified Tool Set), run the layers' `beforeToolCall` steering hooks, validate the arguments against `Tool.input`, and call `Tool.execute`. An unknown tool, malformed JSON arguments, invalid arguments, a steering denial or redirect, or a thrown error becomes an error tool result for the model to read; it does not fail the step.
4. **Append.** Add the `function_call` and `function_call_output` items to the conversation, then go back to step 1.

Limits and recovery:

- **Round cap.** After 32 tool rounds the harness sends a further round with an ephemeral `continue` user message (never logged), and allows three such rounds before the step throws `LLM exceeded maximum tool rounds (32)`.
- **Bad rounds.** A provider-reported terminal error, or a completed response with no output items, is retried the same way: an ephemeral `continue` round, up to three in a row, then the step throws.
- **Between rounds.** On a session turn, queued `between-rounds` inbox messages are appended as user messages before the next round (see `08-runtime`).
- **Abort and stalls.** The request's abort signal cancels the in-flight round and ends the loop. A per-round stream-idle watchdog aborts a round whose stream goes silent (see `08-runtime`).

`until.noToolCalls()` (see `05-loop-and-until`) works one level up. It reads `ctx.lastStepMeta.toolCalls`, which holds every function call from every round of the step, so an outer `loop` iteration counts as having called tools if any round did. By the time `executeLLM` returns, every tool call from that step has a result.

The agent harness appends the response items from all rounds — the model's messages and function calls and the harness's tool results, in order — to the `ItemLog`. The return type is `O` — the parsed output (or `string` if no `output` schema is specified). Tool calls, token usage, and cost are execution metadata accumulated on the context (see `07-context-and-event-log`):

```typescript
const result = await execute(analyze, codeSnippet, ctx);
// result is { bugs: Bug[], severity: Severity }

// Metadata on ctx.lastStepMeta:
// { toolCalls: FunctionCallItem[], usage: { inputTokens, outputTokens, cachedTokens }, cost, serviceTier?, responseItems: Item[] }
```

### What the LLM Actually Sees: The View

A `callModel` step does NOT simply send its instructions and the raw input. Each model request has two parts: the **instructions** string and the **View** — the `Item[]` input assembled by the context layer system (see `11-context-layer-system`). Before each LLM call, the agent harness:

1. Runs `recall()` on each context layer to gather contextual content.
2. Assembles the View: context layer output items (`role: developer`) in their bands around the conversation history (anchor layers, history, live layers — see `11-context-layer-system` § Prompt-Cache Anchoring).
3. Builds the instructions: the step's `instructions` (plus an output codec's own instructions, if `output` is one), then the text of any `role: system` messages found in the View, joined by `\n\n`. Those system messages are removed from the input, so a system message in the log reaches the model only through this field.
4. Sends the instructions as the request's `instructions` field and the View as its input.
5. After the response, runs `store()` on each context layer to persist learnings.

The `instructions` field on `CallModelOpts` is therefore never an item in the View. Keeping it out of the input means the View is pure context and history, and the instructions stay a stable request field the provider can cache ahead of every item. Its tokens are still reserved from the projection budget, so instructions plus View fit the policy's `tokenBudget`. Context layers inject additional context as `MessageItem` entries with `role: developer`.

### `StepMeta`

```typescript
interface StepMeta {
  toolCalls?: FunctionCallItem[];
  usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  cost?: number;
  serviceTier?: string;   // tier the provider served a callModel step on; undefined if unreported
  responseItems?: ReadonlyArray<Item>;
}
```

---

## Variant: `invokeTool` — Single Tool Execution

May have side effects, may need human approval before execution (preventive gating — see `needsApproval` below), and may need sandboxing.

```typescript
interface InvokeToolOpts<I, O, TContext = ContextData> extends StepReplay<TContext, I> {
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
  execute: (
    args: InferSchemaOutput<I>,
    toolCtx: ToolExecutionContext,
  ) => Promise<InferSchemaOutput<O>> | AsyncGenerator<unknown, InferSchemaOutput<O>>;
  needsApproval?: boolean;  // declares the call needs human approval; see below
  context?: ToolContextDeclaration;
}
```

`execute` receives a `ToolExecutionContext` (`{ ctx, harness, fs, shell, context, assembledView, lastStepMeta, turnContext? }`), not the bare `Context` — the step's `Context` is `toolCtx.ctx`. See `04-spawn` ("Context in Tools") for how tools that spawn sub-agents use it. The base `Tool` in `@noetic-tools/types` types the second argument as `unknown` to stay a dependency leaf; `tool()` and the `Tool` re-exported from `@noetic-tools/core` type it as `ToolExecutionContext`. An async-generator `execute` (built with `toolWithGenerator`) yields streaming events (typed by `event`) and returns the result.

`toolCalls(tools)` generates one `ContextLayer` per unique `context.id` among the tools. Tools sharing the same id share state.

### Approval

`needsApproval: true` declares that a call must be approved by a human before it runs. It is a declaration, not a gate: core records it as the `tool.needs_approval` attribute on each `tool.call` span (`10-observability`) and does not pause on its own. Approval is enforced before execution — never by throwing after the work is done — by one of:

- **A `beforeToolCall` gating layer** (`11-context-layer-system`). Both the model-driven path and `invokeTool` run the gate before `execute`; the layer asks its approver (keyed by `BeforeToolCallParams.callId`) and returns `allow` to run the call or `deny` to refuse it. A refused call never executes: on the model-driven path the model receives the denial as an error tool result; an `invokeTool` step throws `NoeticError` kind `steering_denied`.
- **The tool's own integration.** A wrapper that owns its approval channel checks inside `execute` before doing any work — `fromAiSdkTool` (`29-chat-platform-integration`) sends an approval request, waits for the decision, and fails the call with a tool error when it is refused or times out.

A tool that sets `needsApproval` with neither in place runs without approval.

Tool `input`/`output`/`event` accept any Standard Schema v1 validator. The runtime validates tool input through `validateSchema` (Zod `safeParse` fast path, otherwise `~standard.validate` with sync/Promise support), and the parsed/transformed input is what `execute` receives. As before, `output` and `event` describe and infer tool values but are not runtime validation boundaries. Tool input JSON Schema uses the same Zod → StandardJSONSchemaV1 → explicit `inputJsonSchema` chain. For non-Zod schemas, `inputJsonSchema` overrides the trait and also serves as the fallback if the trait converter throws; a validation-only schema must provide it.

Zod stays the default everywhere else in the framework — channels, context-layer schemas, item extension schemas, and JSON workflow schemas remain Zod-specific.

---

## Variant: `withContext` — Scoped Context Layer Injection

Attaches context layers to a descendant step subtree without creating an isolated context. Analogous to React's `Context.Provider` — the layers are available to all descendant `callModel` steps without the context boundary that `spawn` introduces.

```typescript
interface WithContextOpts<TContext, I, O> extends StepReplay<TContext, I> {
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
3. **Scoped lifetime.** Provided layers are initialized when `withContext` begins and disposed when the child completes — or throws. They do not outlive the `withContext` boundary: on exit their state is dropped while the parent's layers keep theirs, and their prompt-cache pins (`11-context-layer-system`, "Prompt-Cache Anchoring") are removed from the epoch, so their last render never replays into later model calls on the same context. Removing a pin changes the cached prefix, so the next call after a `withContext` boundary that pinned output pays one cache miss. A provided layer whose id the parent already has overrides that layer for the subtree but shares its state slot, so the boundary neither initializes nor disposes it.
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

---

## Future Considerations

- **A built-in approval gate.** Core could read `needsApproval` itself and pause before `execute`, asking a harness-level approver and treating refusal like a `deny` decision. Open questions: the approver contract (a channel pair, the ask-user service, or a callback), what happens when no approver is configured, and how it composes with integrations that already gate inside `execute`.
