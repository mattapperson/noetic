# Channels: Typed Data Flow

> **Depends On:** `07-context-and-event-log` (Context — for `ctx.send`/`ctx.recv`/`ctx.tryRecv`)
> **Exports:** `channel()`, `Channel<T>`, `ExternalChannel<T>`, `ChannelHandle<T>`, `tryRecv` semantics

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

## The `channel()` Factory

```typescript
function channel<T>(name: string, opts: {
  schema: ZodType<T>;
  mode: 'value' | 'queue' | 'topic';
  capacity?: number;     // queue mode only, default 1000
  external?: boolean;    // marks channel as externally writable
}): Channel<T>;
```

When `external: true` is set, the returned channel is an `ExternalChannel<T>` (see below).

## Usage

```typescript
// Create typed channels
const findings = channel('findings', {
  schema: z.array(z.string()),
  mode: 'topic',
});
const status = channel('status', {
  schema: z.enum(['running', 'done', 'error']),
  mode: 'value',
});

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

## `tryRecv` — Non-Blocking Read

`tryRecv` reads from a channel without blocking. It returns the value if available, or `null` if not. It never throws.

```typescript
ctx.tryRecv(channel): T | null
```

### Behavior by Mode

| Mode    | `tryRecv` behavior                                        |
|---------|-----------------------------------------------------------|
| `queue` | Dequeues head item or returns `null` if queue is empty    |
| `value` | Returns current value or `null` if never written          |
| `topic` | Returns `null` always (topic is push-based, use `recv`)   |

`tryRecv` is useful for polling patterns — checking whether new data has arrived without suspending the step. This is Go's `select/default` analogue.

```typescript
step.run({
  id: 'check-updates',
  execute: async (_, ctx) => {
    const update = ctx.tryRecv(planUpdates);
    if (update) {
      // New plan received — adjust behavior
      return applyUpdate(update);
    }
    // No update — continue with current plan
    return continueWork();
  },
});
```

---

## External Channels

External channels allow code outside the execution tree (HTTP handlers, WebSocket listeners, CLI prompts) to send data into a running execution.

### `ExternalChannel<T>`

```typescript
interface ExternalChannel<T> extends Channel<T> {
  readonly external: true;
}
```

Created via the `channel()` factory with `external: true`:

```typescript
const userMessages = channel('user-messages', {
  schema: z.string(),
  mode: 'queue',
  external: true,
});
```

### `ChannelHandle<T>`

A typed, lifecycle-aware write surface for external callers. External code uses handles instead of `ctx.send` because it doesn't hold a `Context` reference.

```typescript
interface ChannelHandle<T> {
  send(value: T): void;
  readonly closed: boolean;
  readonly channel: Channel<T>;
}
```

Obtained via the agent harness:

```typescript
const handle = harness.getChannelHandle(userMessages, executionId);
```

### Scope Rule

External channels survive `contextIn: 'fresh'` spawn boundaries. They are scoped to the **root execution**, not individual spawn boundaries. This is analogous to `scope: 'resource'` memory layers — they represent user-level communication, not execution-level state.

### Lifecycle

- **Open**: External channels are eagerly initialized when `run()` is called on the root step. The channel is ready to receive before any step runs.
- **Closed**: When the root execution completes (success, failure, or cancellation), all external channel handles are closed.
- **After close**: `handle.send()` throws `channel_closed` (see `09-error-model`). Callers can check `handle.closed` before sending.

### External Sender Back-Pressure

External senders are NOT back-pressured. If a queue channel's buffer is full when an external sender calls `handle.send()`:
- The **oldest** item in the queue is dropped.
- A warning is emitted via the agent harness's tracing system.

This design prevents external callers (e.g., HTTP handlers) from blocking on a full queue, which would cause upstream timeouts. Internal senders (`ctx.send`) are still subject to normal back-pressure semantics.

### Thread Safety

Node.js is single-threaded, so `InMemoryAgentHarness` handles are inherently thread-safe. `DurableAgentHarness` translates `handle.send()` to durable signals (e.g., Temporal signals, Inngest events).

---

## Channel Semantics

### Scope

Channels are scoped to an execution tree. A channel created in a parent is accessible to all descendants unless a `spawn` boundary (see `04-spawn`) uses `contextIn: 'fresh'`. Fresh contexts get a new channel namespace — **except** for external channels, which survive fresh boundaries (scoped to root execution). To pass a non-external channel across a fresh boundary, use `contextIn: 'custom'` explicitly — this is the "you opted into this" escape hatch.

### Lifecycle

Channels are created on first reference and garbage-collected when the execution tree completes. Queue channels buffer indefinitely within an execution (bounded by `capacity`, default 1000 items). When the buffer is full, internal senders block (back-pressure); external senders drop oldest (see above). Topic channels are ephemeral — items are delivered to currently-waiting receivers and dropped if no one is listening.

### Default Timeout and Deadlock Prevention

All `recv` calls have a **default timeout of 30 seconds**. If no data arrives within the timeout, the agent harness throws `channel_timeout` (see `09-error-model`). Callers may override the default:

```typescript
ctx.recv(findings, { timeout: 60_000 }); // 60s
ctx.recv(status, { timeout: 0 });         // no timeout (use with caution)
```

Setting `timeout: 0` disables the timeout — this is an explicit opt-in to potential deadlock. The agent harness SHOULD emit a warning when `timeout: 0` is used.

### Back-Pressure (Internal Senders)

When a queue channel's buffer reaches `capacity`, `ctx.send` returns a `Promise` that resolves when space is available (a consumer calls `recv`). Like `recv`, back-pressure `send` is subject to the default 30-second timeout. If the timeout fires, the agent harness throws `channel_timeout` with the channel name. This prevents silent deadlocks where a producer and consumer are both blocked.

### Blocking Model

`recv` returns a `Promise` that resolves when data is available. This works because `recv` is only called inside `step.execute`, which is already async. The agent harness manages a waiter queue:

```typescript
// Inside the agent harness (simplified)
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

function tryRecv<T>(ch: Channel<T>): T | null {
  const state = channelState.get(ch.name);
  if (state.mode === 'topic') return null;
  if (state.buffer.length > 0) {
    return (state.mode === 'queue'
      ? state.buffer.shift()
      : state.buffer[0]) as T;
  }
  return null;
}
```

Within a `fork` (see `03-control-flow`), the agent harness runs paths as concurrent promises (not sequential), so `send` in one path can wake `recv` in another.

### Topic Mode is Lossy

Items are not buffered if no receiver is waiting. This is intentional — topic channels are for real-time coordination, not reliable delivery. Use `queue` mode for reliable delivery.
