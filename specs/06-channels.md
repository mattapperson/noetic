# Channels: Typed Data Flow

> **Depends On:** `07-context-and-event-log` (Context — for `ctx.send`/`ctx.recv`)
> **Exports:** `channel()`, `Channel<T>`

---

## The `Channel<T>` Type

Channels are typed, named conduits for data between steps. They are standalone objects that TypeScript can type-check — no string IDs connecting things.

```typescript
interface Channel<T> {
  readonly name: string;
  readonly schema: ZodType<T>;
  readonly mode: 'value' | 'queue' | 'topic';
  readonly capacity?: number;  // queue mode only, default 1000
}
```

| Mode    | Behavior                                       | Analogue                                |
|---------|-------------------------------------------------|-----------------------------------------|
| `value` | Last-write-wins                                | LangGraph `LastValue`, mutable variable |
| `queue` | FIFO buffer, readers block                     | CSP channel, Go `chan`                  |
| `topic` | Pub/sub, all current readers get every message | LangGraph `Topic`, event bus            |

## Usage

```typescript
// Create typed channels
const findings = channel('findings', z.array(z.string()), 'topic');
const status = channel('status', z.enum(['running', 'done', 'error']), 'value');

// In a step: write to a channel
step.run({
  id: 'research',
  execute: async (query, ctx) => {
    const results = await search(query);
    ctx.send(findings, results);        // type-checked: must be string[]
    ctx.send(status, 'done');           // type-checked: must be 'running' | 'done' | 'error'
  },
});

// In another step: read from a channel
step.run({
  id: 'synthesize',
  execute: async (_, ctx) => {
    const allFindings = await ctx.recv(findings);  // typed as string[]
    return summarize(allFindings);
  },
});
```

The channel object IS the connection. If you pass the same `Channel<string[]>` to both a writer and a reader, TypeScript guarantees type compatibility at compile time.

---

## Channel Semantics

### Scope

Channels are scoped to an execution tree. A channel created in a parent is accessible to all descendants unless a `spawn` boundary (see `04-spawn`) uses `contextIn: 'fresh'`. Fresh contexts get a new channel namespace. To pass a channel across a fresh boundary, use `contextIn: 'custom'` explicitly — this is the "you opted into this" escape hatch.

### Lifecycle

Channels are created on first reference and garbage-collected when the execution tree completes. Queue channels buffer indefinitely within an execution (bounded by `capacity`, default 1000 messages). When the buffer is full, senders block (back-pressure). Topic channels are ephemeral — messages are delivered to currently-waiting receivers and dropped if no one is listening.

### Blocking Model

`recv` returns a `Promise` that resolves when data is available. This works because `recv` is only called inside `step.execute`, which is already async. The runtime manages a waiter queue:

```typescript
// Inside the runtime (simplified)
const channelState = new Map<string, {
  mode: 'value' | 'queue' | 'topic';
  buffer: unknown[];
  waiters: Array<{ resolve: (value: unknown) => void }>;
}>();

function send<T>(ch: Channel<T>, value: T): void {
  const state = channelState.get(ch.name);
  if (state.waiters.length > 0) {
    state.waiters.shift()!.resolve(value);
  } else if (state.mode === 'queue') {
    state.buffer.push(value);
  } else if (state.mode === 'value') {
    state.buffer = [value]; // last-write-wins
  }
  // topic: deliver to ALL waiters, drop if none
}

async function recv<T>(ch: Channel<T>): Promise<T> {
  const state = channelState.get(ch.name);
  if (state.buffer.length > 0) {
    return state.buffer.shift() as T;
  }
  return new Promise(resolve => state.waiters.push({ resolve }));
}
```

Within a `fork` (see `03-control-flow`), the runtime runs paths as concurrent promises (not sequential), so `send` in one path can wake `recv` in another.

### Topic Mode is Lossy

Messages are not buffered if no receiver is waiting. This is intentional — topic channels are for real-time coordination, not reliable delivery. Use `queue` mode for reliable delivery.
