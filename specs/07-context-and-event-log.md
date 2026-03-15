# Context and Item Log

> **Depends On:** `06-channels` (Channel — for send/recv/tryRecv signatures), `10-observability` (Span)
> **Exports:** `Context`, `ItemLog`, `Item`, `MessageItem`, `FunctionCallItem`, `FunctionCallOutputItem`, `ReasoningItem`, `ExtensionItem`, `ContentPart`, `StepMeta`, `TokenUsage`, `LLMResponse`

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

Items are the native data format aligned with OpenResponses. They serve as both the record of what happened and the input to `callModel`, eliminating impedance mismatch between the framework's internal state and the model API.

```typescript
type Item =
  | MessageItem
  | FunctionCallItem
  | FunctionCallOutputItem
  | ReasoningItem
  | ExtensionItem;

interface ItemBase {
  readonly id: string;           // unique string (UUIDv7)
  readonly status: 'in_progress' | 'completed' | 'incomplete' | 'failed';
}

interface MessageItem extends ItemBase {
  readonly type: 'message';
  readonly role: 'user' | 'assistant' | 'system' | 'developer';
  readonly content: ContentPart[];
}

type ContentPart =
  | { type: 'output_text'; text: string }
  | { type: 'input_text'; text: string }
  | { type: 'refusal'; refusal: string };

interface FunctionCallItem extends ItemBase {
  readonly type: 'function_call';
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;     // JSON string per OpenResponses
}

interface FunctionCallOutputItem extends ItemBase {
  readonly type: 'function_call_output';
  readonly call_id: string;
  readonly output: string;
}

interface ReasoningItem extends ItemBase {
  readonly type: 'reasoning';
  readonly content: ContentPart[];
  readonly summary?: ContentPart[];
  readonly encrypted_content?: string;
}

interface ExtensionItem extends ItemBase {
  readonly type: `x-${string}`;
  readonly data: Record<string, unknown>;
}
```

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

- **`parent`** enables spawn-tree traversal. The `depth` field enables recursive patterns with depth limits.
- **`span`** means every step is automatically traced without user instrumentation (see `10-observability`).
- **`threadId` / `resourceId`** are used by the runtime to resolve memory layer scope keys. A `scope: 'thread'` memory layer isolates state per `threadId`; a `scope: 'resource'` layer shares state across threads for the same `resourceId` (see `11-memory-layer-system`).
- **`itemLog`** is the raw record. The View (what the LLM sees) is a projection of it plus memory layer outputs.

## Circular Reference with Channels

`Context` has `send`/`recv`/`tryRecv` methods typed with `Channel<T>` (from `06-channels`), while channel scope rules reference `Context` for execution-tree scoping. This is resolved at the type level by co-defining both interfaces in the same package. In the specs, both files cross-reference each other.
