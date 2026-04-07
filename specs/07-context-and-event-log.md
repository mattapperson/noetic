# Context and Item Log

> **Depends On:** `06-channels` (Channel — for send/recv/tryRecv signatures), `08-runtime` (AgentHarness — for harness reference), `10-observability` (Span)
> **Exports:** `Context`, `ItemLog`, `Item`, `OutputItem`, `MessageItem`, `FunctionCallItem`, `FunctionCallOutputItem`, `ReasoningItem`, `WebSearchItem`, `FileSearchItem`, `ImageGenerationItem`, `ServerToolItem`, `InputMessageItem`, `ContentPart`, `OutputTextPart`, `RefusalPart`, `InputTextPart`, `ReasoningTextPart`, `SummaryTextPart`, `StepMeta`, `TokenUsage`, `LLMResponse`

---

## The `Context` Interface

Every step runs inside a `Context`. It's the runtime's handle into the execution. The `Context` is NOT the content sent to the LLM — that is the **View**, assembled by the Projector from memory layers and conversation history (see `11-memory-layer-system`). The `Context` is execution metadata and infrastructure.

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
  readonly span: Span;           // OpenTelemetry trace span (see 10-observability)
  readonly harness: AgentHarness;   // reference to the owning agent harness (see 08-runtime)

  // Identifiers for memory layer scope resolution (see 11-memory-layer-system)
  readonly threadId: string;     // stable across calls in the same conversation
  readonly resourceId?: string;  // user, entity, or resource identifier

  // The Item Log — append-only record of all items in this execution
  readonly itemLog: ItemLog;

  // Last step execution metadata (tool calls, token usage, cost)
  readonly lastStepMeta: StepMeta | null;

  // Channel operations (thin wrappers over runtime.send/recv, see 06-channels)
  recv<T>(channel: Channel<T>, opts?: { timeout?: number }): Promise<T>;
  send<T>(channel: Channel<T>, value: T): void;

  // Non-blocking channel read (see 06-channels)
  tryRecv<T>(channel: Channel<T>): T | null;

  // Lifecycle
  checkpoint(): Promise<void>;
  complete<T>(value: T): void;
  abort(reason?: string): void;
}
```

---

## `ItemLog`

The append-only record of all conversation items in an execution. It is NOT directly sent to the LLM. The Projector (see `11-memory-layer-system`) renders it into the View alongside memory layer outputs, applying overflow policies when the log exceeds the token budget.

```typescript
interface ItemLog {
  readonly items: ReadonlyArray<Item>;
  append(item: Item): void;
}
```

---

## `Item` Type Hierarchy

Items are the native data format aligned with Open Responses. Output item types are direct type aliases of the `@openrouter/sdk` types (`ResponsesOutputMessage`, `ResponsesOutputItemFunctionCall`, etc.), eliminating impedance mismatch between the framework's internal state and the model API. Framework-owned item types (`InputMessageItem`, `FunctionCallOutputItem`) are Noetic interfaces that follow the same shape conventions.

### Content Parts

```typescript
/** Model-generated text with optional annotations and logprobs. */
type OutputTextPart = ResponseOutputText;

/** Model refusal content. */
type RefusalPart = OpenAIResponsesRefusalContent;

/** User/developer input text (framework-created). */
interface InputTextPart {
  readonly type: 'input_text';
  readonly text: string;
}

/** Reasoning trace content. */
type ReasoningTextPart = ReasoningTextContent;

/** Reasoning summary content. */
type SummaryTextPart = ReasoningSummaryText;

/** Content part variants for message items. */
type ContentPart = OutputTextPart | RefusalPart | InputTextPart;
```

### Output Items (from the model)

These are type aliases of the `@openrouter/sdk` types. The SDK provides `id`, `type`, and `status` fields on each.

```typescript
/** Assistant message output item (role is always 'assistant'). */
type MessageItem = ResponsesOutputMessage;

/** Function call requested by the model. */
type FunctionCallItem = ResponsesOutputItemFunctionCall;

/** Reasoning trace from the model. Uses ReasoningTextPart and SummaryTextPart content. */
type ReasoningItem = ResponsesOutputItemReasoning;

/** Web search call result. */
type WebSearchItem = ResponsesWebSearchCallOutput;

/** File search call result. */
type FileSearchItem = ResponsesOutputItemFileSearchCall;

/** Image generation call result. */
type ImageGenerationItem = ResponsesImageGenerationCall;

/**
 * Server tool output (vendor-prefixed type like `openrouter:datetime`).
 * Constrains the SDK's type field from `string` to `${string}:${string}`
 * so discriminant narrowing works in Item unions.
 */
type ServerToolItem = Omit<ResponsesServerToolOutput, 'type'> & {
  readonly type: `${string}:${string}`;
};

type OutputItem =
  | MessageItem
  | FunctionCallItem
  | ReasoningItem
  | WebSearchItem
  | FileSearchItem
  | ImageGenerationItem
  | ServerToolItem;
```

### Framework Items (created by Noetic)

```typescript
/**
 * Input message created by the framework (user, system, or developer role).
 * Status includes `failed` as a Noetic extension beyond the Open Responses spec
 * (which only defines `in_progress | completed | incomplete` for items).
 */
interface InputMessageItem {
  readonly id: string;
  readonly type: 'message';
  readonly role: 'user' | 'system' | 'developer';
  readonly status: 'in_progress' | 'completed' | 'incomplete' | 'failed';
  readonly content: InputTextPart[];
}

/**
 * Tool execution output created by the harness during the tool loop.
 * This is an input-only item type in Open Responses (sent by the developer, not the model).
 */
interface FunctionCallOutputItem {
  readonly id: string;
  readonly type: 'function_call_output';
  readonly status: 'in_progress' | 'completed' | 'incomplete' | 'failed';
  readonly callId: string;
  readonly output: string;
}
```

### Item Union

```typescript
type Item = OutputItem | InputMessageItem | FunctionCallOutputItem;
```

Server tool items use the `prefix:name` convention established by the OpenResponses `ResponsesServerToolOutput` type. The prefix identifies the vendor or domain (e.g., `openrouter`, `noetic`, `myapp`) and the name identifies the specific item kind. None of the standard item types contain a colon, so the presence of `:` in the type string cleanly distinguishes server tool outputs from standard items.

---

## `StepMeta`

Execution metadata from the most recent step. Available on `ctx.lastStepMeta` after any step completes.

```typescript
interface StepMeta {
  toolCalls?: FunctionCallItem[];
  usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  cost?: number;  // USD
  responseItems?: ReadonlyArray<Item>;
}

interface TokenUsage {
  input: number;
  output: number;
  total: number;
}
```

---

## `LLMResponse`

Framework abstraction over the model result. Contains the response items and token usage from a single LLM call.

```typescript
interface LLMResponse {
  items: Item[];
  usage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  cost?: number;
}
```

---

## Key Relationships

- **`harness`** gives every step direct access to the `AgentHarness` that owns this context. Steps and tools read harness params via `ctx.harness.config.params` and can call harness methods (e.g., `ctx.harness.run(...)` for sub-agent delegation).
- **`parent`** enables spawn-tree traversal. The `depth` field enables recursive patterns with depth limits.
- **`span`** means every step is automatically traced without user instrumentation (see `10-observability`).
- **`threadId` / `resourceId`** are used by the runtime to resolve memory layer scope keys. A `scope: 'thread'` memory layer isolates state per `threadId`; a `scope: 'resource'` layer shares state across threads for the same `resourceId` (see `11-memory-layer-system`).
- **`itemLog`** is the raw record. The View (what the LLM sees) is a projection of it plus memory layer outputs.
- **The `Context` interface is not the context the LLM sees.** The `Context` object is execution infrastructure — metadata, state, and runtime handles. What the LLM actually receives is the View: the result of all memory layers converging in slot order. Context is never a layer itself; it is the output of layer convergence, assembled fresh before each LLM call. See `11-memory-layer-system`.

## Circular Reference with Channels

`Context` has `send`/`recv`/`tryRecv` methods typed with `Channel<T>` (from `06-channels`), while channel scope rules reference `Context` for execution-tree scoping. This is resolved at the type level by co-defining both interfaces in the same package. In the specs, both files cross-reference each other.
