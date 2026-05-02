# Loop and Until: Iteration and Termination

> **Depends On:** `01-step-type` (Step<I,O>), `06-channels` (Channel), `07-context-and-event-log` (Context), `09-error-model` (NoeticError)
> **Exports:** `loop()`, `LoopConfig`, `every()`, `EveryOptions`, `Until`, `Verdict`, `Snapshot`, `until.*` predicates, `any()`, `all()`, `VerifyFn`, `ConvergeConfig`

---

## `loop()` — Repeating Execution

Combines an array of body steps + termination predicate + optional input preparation into repeating execution. Each iteration executes the steps sequentially, piping the output of one into the input of the next.

```typescript
interface LoopConfig<I, O> {
  id: string;
  steps: ReadonlyArray<Step<I, O>>;
  until: Until;
  maxIterations?: number;    // hard safety cap on iterations (default 1000)
  maxHistorySize?: number;   // limits history array size for memory management
  prepareNext?: (output: O, verdict: Verdict, ctx: Context) => I;
  onError?: (error: NoeticError, ctx: Context) => 'retry' | 'skip' | 'abort';
}
```

`prepareNext` is how feedback flows from the `until` verdict back into the next iteration's input. For ReAct, it's not needed (the runtime accumulates items). For Ralph Wiggum, it injects verification failure feedback:

```typescript
prepareNext: (output, verdict, ctx) => {
  if (verdict.feedback) {
    return `Previous attempt failed: ${verdict.feedback}\nTry a different approach.`;
  }
  return 'Continue working on the task.';
},
```

`onError` controls behavior when the loop steps fails:

- `'retry'` — re-run the same iteration
- `'skip'` — move to the next iteration using the last successful output
- `'abort'` — propagate the error (default behavior if `onError` is not specified)

### Memory Layer Interaction

On each loop iteration, the full memory layer lifecycle runs: `recall()` before the LLM call, `store()` after. This means memory layers (working memory, observations, etc.) can evolve across iterations even though the ItemLog grows linearly.

---

## `Until` — Termination Predicates

An `until` is a predicate that receives an execution `Snapshot` and returns a `Verdict`.

```typescript
type Until = (snapshot: Snapshot) => Verdict | Promise<Verdict>;
```

### `Snapshot`

```typescript
interface Snapshot {
  stepCount: number;
  tokens: { input: number; output: number; total: number };
  elapsed: number;        // wall-clock ms
  cost: number;           // USD
  lastOutput: unknown;
  lastText: string;       // lastOutput as string
  history: unknown[];     // all outputs from this loop
  depth: number;          // spawn depth
  lastStepMeta?: StepMeta | null;
}
```

### `Verdict`

```typescript
interface Verdict {
  stop: boolean;
  reason?: string;        // shows up in traces
  feedback?: string;      // injected into next iteration's input via prepareNext
}
```

### Why `Verdict` Instead of `boolean`?

1. **Observability**: the `reason` string shows up in traces. When debugging "why did my agent stop after 7 iterations?", you see `"Cost $4.82 exceeded budget $5.00"` instead of `true`.
2. **Feedback injection**: for verify-and-retry patterns (Ralph Wiggum), the verdict can include `feedback` that gets injected into the next iteration. The loop's `prepareNext` function receives the verdict.

---

## Composition

```typescript
// Stop when ANY predicate fires
const production = any(
  until.maxSteps(20),
  until.maxCost(5.00),
  until.maxDuration(5 * 60 * 1000),
);

// Stop when ALL predicates agree
const cautious = all(
  until.converged({ threshold: 0.95 }),
  until.maxSteps(3),  // need at least 3 iterations AND convergence
);
```

---

## Built-in Predicates

```typescript
const until = {
  maxSteps:       (n: number) => Until,
  maxCost:        (usd: number) => Until,
  maxDuration:    (ms: number) => Until,
  noToolCalls:    () => Until,                    // ReAct termination
  never:          () => Until,                    // never stops; pair with `every` or external cancellation
  verified:       (fn: VerifyFn) => Until,        // Ralph Wiggum external check
  converged:      (opts: ConvergeConfig) => Until,  // recursive self-refinement
  outputContains: (marker: string) => Until,      // completion promise marker
  custom:         (fn: Until) => Until,           // escape hatch
};

type VerifyFn = (output: unknown) => Promise<{ pass: boolean; feedback?: string }>;

interface ConvergeConfig {
  threshold?: number;        // default 1 (exact match). When embed is provided and threshold < 1, uses cosine similarity
  embed?: EmbedFn;           // when provided + threshold < 1, embed both outputs and compare via cosine similarity
  cache?: StorageAdapter;    // persist previous output vector across ephemeral invocations
}
```

Each is 3-5 lines. They're compositions of the `Until` type:

```typescript
const maxSteps = (n: number): Until => (snap) => ({
  stop: snap.stepCount >= n,
  reason: `Reached ${n} steps`,
});

const verified = (fn: VerifyFn): Until => async (snap) => {
  const result = await fn(snap.lastOutput);
  return {
    stop: result.pass,
    reason: result.pass ? 'Verification passed' : 'Verification failed',
    feedback: result.feedback,
  };
};
```

---

## Inbox Channel

A loop can optionally define an **inbox channel** that lets external messages prevent the loop from stopping. This enables async sub-agent patterns where the loop parks, waiting for background work to complete.

```typescript
interface LoopConfig<I, O> {
  // ... existing fields
  inbox?: Channel<string>;   // messages injected as developer items
  parkTimeout?: number;       // ms to wait on inbox before truly stopping (default: 0 = tryRecv only)
}
```

### Behavior

When the `until` predicate returns `{ stop: true }` and `inbox` is defined:

1. If `parkTimeout > 0`: the loop calls `ctx.recv(inbox, { timeout: parkTimeout })` — blocking until a message arrives or the timeout expires.
2. If `parkTimeout` is `0` or omitted: the loop calls `ctx.tryRecv(inbox)` — non-blocking check.
3. If a message is received: it is appended to the context's `ItemLog` as a `developer` message, and the loop **continues** (does not stop).
4. If no message (tryRecv returns null, or recv times out): the loop proceeds with normal stop behavior.

This means the loop only truly stops when both the `until` predicate says stop AND the inbox is empty (or timed out).

### Use Case: Async Sub-Agent Results

```typescript
const inbox = channel('agent-inbox', { schema: z.string(), mode: 'queue' });

const agentLoop = {
  kind: 'loop',
  id: 'async-agent',
  steps: [step.llm({ id: 'agent-llm', model: 'gpt-4o', tools: [launchTool] })],
  until: until.noToolCalls(),
  inbox,
  parkTimeout: 3e4,  // wait up to 30s for sub-agent results
};
```

When a sub-agent completes, its result is sent to the inbox channel. The loop wakes, injects the result as a developer message, and the LLM can incorporate it in its next response.

---

## `every()` — Scheduled Forever-Iteration

`every` runs a body step on a fixed-interval schedule, optionally woken sooner by a wake channel. It runs forever until the executing context is cancelled.

```typescript
interface EveryOptions<I, O> {
  id: string;
  step: Step<I, O>;
  ms: number;                 // park duration between iterations (>= 0)
  wakeOn?: Channel<unknown>;  // any value on this channel wakes the park
  onError?: 'continue' | 'fail';   // default 'continue'
  jitter?: number;            // ms of symmetric random jitter (>= 0, default 0)
}

every<I, O>(opts: EveryOptions<I, O>): StepEvery<I, O>;
```

### Semantics

1. The first iteration starts immediately; the body step is invoked with `input`.
2. After the body returns, `every` parks for `ms ± jitter` ms or until any value is sent on `wakeOn` — whichever happens first. The park observes the wake non-consumingly: a queue-mode wake message stays on the queue so the next iteration's body can drain it via `tryRecv`.
3. The park resolves immediately when the executing context is aborted; the next iteration's abort check then surfaces a `cancelled` `NoeticError`.
4. The operator output is `void`. `every` does not accumulate iteration outputs.
5. `every` only terminates by throw — either `cancelled` from abort, or the body's error under `onError: 'fail'`.

### Error Policy

- **`onError: 'continue'`** *(default)*: when the body throws, `every` records a span event named `every.iteration.error` with `message` and `stack` attributes, then proceeds to the park step as if no error occurred.
- **`onError: 'fail'`**: re-throws the body's error, terminating the operator. Any enclosing `fork({ mode: 'all' })` settles with that error.
- A `cancelled` `NoeticError` thrown by the body is never swallowed — it propagates regardless of `onError`.

### Composition with `fork` and `spawn`

- Inside `fork({ mode: 'race' })`, the first racing path that returns wins; cancelling the others aborts their `every`.
- Inside `fork({ mode: 'all' })`, an `every` with `onError: 'fail'` rejects the fork on first body failure.
- Inside `spawn`, `every` runs in the isolated child context with its own abort signal.

### Example

```typescript
const wake = channel('poll-wake', { schema: z.string(), mode: 'queue' });

const poller = every({
  id: 'job-poller',
  ms: 30_000,                // poll every 30s
  jitter: 5_000,             // ±5s to spread load
  wakeOn: wake,              // external trigger to poll immediately
  onError: 'continue',
  step: step.run({
    id: 'fetch-jobs',
    execute: async (_, ctx) => fetchAndDispatchPendingJobs(ctx),
  }),
});
```

Pair with `until.never()` when you need a `loop`-shaped never-stops predicate elsewhere in the same tree.

---

## Error Behavior

- **`until` predicate throws:** Treat as `{ stop: true, reason: 'Predicate error: ...' }`. The loop stops. A broken predicate should not cause infinite iteration.
- **Loop body failure with `onError`:** See `09-error-model` for full propagation rules.
- **`every` body failure:** Governed by `every`'s own `onError` policy (`'continue'` records a span event; `'fail'` re-throws).
