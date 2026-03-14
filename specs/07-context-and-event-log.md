# Context and Event Log

> **Depends On:** `06-channels` (Channel — for send/recv signatures), `10-observability` (Span)
> **Exports:** `Context`, `EventLog`, `Message`, `StepMeta`, `TokenUsage`

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

  // The Event Log — append-only record of all messages in this execution
  readonly eventLog: EventLog;

  // Last step execution metadata (tool calls, token usage, cost)
  readonly lastStepMeta: StepMeta | null;

  // Channel operations (thin wrappers over runtime.send/recv, see 06-channels)
  recv<T>(channel: Channel<T>, opts?: { timeout?: number }): Promise<T>;
  send<T>(channel: Channel<T>, value: T): void;

  // Lifecycle
  checkpoint(): Promise<void>;
  complete<T>(value: T): void;
  abort(reason?: string): void;
}
```

---

## `EventLog`

The append-only record of all conversation events in an execution. It is NOT directly sent to the LLM. The Projector (see `11-memory-layer-system`) renders it into the View alongside memory layer outputs, applying overflow policies when the log exceeds the token budget.

```typescript
interface EventLog {
  readonly events: ReadonlyArray<Event>;
  append(event: Event): void;
}

interface Event {
  readonly id: number;           // monotonically increasing within the log
  readonly kind: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system';
  readonly content: unknown;
  readonly timestamp: number;    // Unix ms
}
```

---

## `Message`

The basic message type used throughout the system — in the View, in Event Log projections, and in `contextIn` strategies.

```typescript
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  toolCallId?: string;
  name?: string;
}
```

---

## `StepMeta`

Execution metadata from the most recent step. Available on `ctx.lastStepMeta` after any step completes.

```typescript
interface StepMeta {
  toolCalls?: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
  cost?: number;  // USD
}

interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

interface TokenUsage {
  input: number;
  output: number;
  total: number;
}
```

---

## Key Relationships

- **`parent`** enables spawn-tree traversal. The `depth` field enables recursive patterns with depth limits.
- **`span`** means every step is automatically traced without user instrumentation (see `10-observability`).
- **`threadId` / `resourceId`** are used by the runtime to resolve memory layer scope keys. A `scope: 'thread'` memory layer isolates state per `threadId`; a `scope: 'resource'` layer shares state across threads for the same `resourceId` (see `11-memory-layer-system`).
- **`eventLog`** is the raw record. The View (what the LLM sees) is a projection of it plus memory layer outputs.

## Circular Reference with Channels

`Context` has `send`/`recv` methods typed with `Channel<T>` (from `06-channels`), while channel scope rules reference `Context` for execution-tree scoping. This is resolved at the type level by co-defining both interfaces in the same package. In the specs, both files cross-reference each other.
