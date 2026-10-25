# Loop and Until: Iteration and Termination

> **Depends On:** `01-step-type` (Step<I,O>), `06-channels` (Channel), `07-context-and-event-log` (Context), `09-error-model` (NoeticError), `32-decide` (decide steps as deciders)
> **Exports:** `loop()`, `LoopConfig`, `schedule()`, `ScheduleOptions`, `Until`, `UntilRun`, `Verdict`, `Snapshot`, `until.*` predicates, `any()`, `all()`, `VerifyFn`, `ConvergeConfig`

---

## `loop()` — Repeating Execution

Combines an array of body steps + termination predicate + optional input preparation into repeating execution. Each iteration executes the steps sequentially, piping the output of one into the input of the next.

```typescript
interface LoopConfig<I, O> {
  id: string;
  steps: ReadonlyArray<Step<I, O>>;
  until: Until | StepDecide;  // a predicate, or a decide step asking one boolean question
  maxIterations?: number;    // hard cap on iterations (default 1000; Infinity = uncapped)
  maxHistorySize?: number;   // bounds Snapshot.history (default 100, oldest dropped first)
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

`onError` is never consulted for a `cancelled` error — cancellation is not a retriable error and always terminates the loop immediately (see `09-error-model`, Cancellation Propagation Semantics).

### Iteration Cap

`maxIterations` caps the total number of iterations, retries included. It defaults to `1000` so a predicate that never fires still ends the loop. A loop that should run until its predicate says stop — an agent that works until a goal is met, a state machine driven by its own output — opts out with `maxIterations: Infinity`. An uncapped loop ends only when:

- its `until` predicate returns `{ stop: true }` (a predicate that throws counts as stop),
- an iteration's error propagates (no `onError`, or `onError` returns `'abort'`), or
- its context is aborted (`cancelled`).

The cap must be a positive integer or `Infinity`. Any other value — `NaN`, `0`, a negative number, a fraction like `1.5` — fails the loop with a `step_failed` error before the first iteration. Running past the cap fails it with a `step_failed` error naming the cap.

Nothing else in the loop depends on a finite cap: `Snapshot.history` is bounded by `maxHistorySize`, not by the cap, so the loop's own state stays bounded however long an uncapped loop runs (the ItemLog and context layers still grow with what the body records).

### Context Layer Interaction

On each loop iteration, the full context layer lifecycle runs: `recall()` before the LLM call, `store()` after. This means context layers (scratchpad, observations, etc.) can evolve across iterations even though the ItemLog grows linearly.

---

## `Until` — Termination Predicates

An `until` is a predicate that receives an execution `Snapshot` and returns a `Verdict`.

```typescript
type Until = (snapshot: Snapshot, run?: UntilRun) => Verdict | Promise<Verdict>;

/** What a loop hands its predicate so the predicate can run steps. */
interface UntilRun {
  ctx: Context;
  executeStep: ExecuteStepFn;
}
```

The loop always passes `run`, and `any()`/`all()` forward it to every predicate they hold. Predicates that only read the snapshot ignore it; a decide step used as `until` runs through it (see Ending a Loop with a Decision).

### `Snapshot`

```typescript
interface Snapshot {
  stepCount: number;
  tokens: { input: number; output: number; total: number };
  elapsed: number;        // wall-clock ms
  cost: number;           // USD
  lastOutput: unknown;
  lastText: string;       // lastOutput as string
  history: unknown[];     // outputs from this loop, oldest first; bounded by maxHistorySize (default 100, oldest dropped first)
  depth: number;          // spawn depth
  lastStepMeta?: StepMeta | null;
}
```

### `Verdict`

```typescript
interface Verdict {
  stop: boolean;
  reason?: string;        // recorded on the loop.verdict span event
  feedback?: string;      // injected into next iteration's input via prepareNext
}
```

### Verdict Traces

After each verdict — including the stop verdict a throwing predicate produces — the loop adds a `loop.verdict` event to the enclosing span (`ctx.span`). Loops open no span of their own, so the event lands on whatever span wraps the loop — inside a `spawn` child or an `inParallel` path, that child's span (see `10-observability`).

| Attribute | Type | Description |
|-----------|------|-------------|
| `loop` | string | The loop's step id |
| `iteration` | number | 1-based attempt count; an attempt retried via `onError` gives no verdict but still counts, so numbers can skip |
| `stop` | boolean | The verdict's `stop` |
| `reason` | string | The verdict's `reason`; absent when the verdict has none |

`feedback` is left out: it can be large and may carry sensitive output.

### Why `Verdict` Instead of `boolean`?

1. **Observability**: the `reason` string shows up in traces. When debugging "why did my agent stop after 7 iterations?", you see `"Cost $5.12 exceeded budget $5.00"` instead of `true`.
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

Both combinators run their predicates in order and short-circuit on the first verdict that decides the outcome: `any()` on the first stop, `all()` on the first continue. That verdict is returned as is, `reason` and `feedback` included. When no predicate short-circuits, every predicate decided the outcome together, and the combined verdict carries all of their `reason`s joined with `'; '` and all of their `feedback` joined with `'\n'`, leaving a field out when none of them set it. `all()` falls back to the reason `All predicates satisfied`.

So a continue verdict always carries the feedback of the predicates that asked to continue: `any(until.maxSteps(20), until.verified(fn))` hands the verifier's feedback to `prepareNext` exactly as a bare `until.verified(fn)` would.

`any()` and `all()` accept decide steps beside predicates — `any(until.maxSteps(20), isDone)` — under the rules below.

---

## Ending a Loop with a Decision

A `decide` step (spec 32) can stand where a predicate stands: as `loop({ until })` itself, or as an argument to `any()`/`all()`. There is no wrapper and no separate decider type — the step `decide()` returns is the decider, told apart from a predicate by being a step rather than a function.

```typescript
const isDone = decide({
  id: 'is-done',
  questions: { stop: { type: 'boolean', instructions: 'Is the task finished?' } },
});

loop({ id: 'work', steps: [act], until: isDone, maxIterations: Infinity });
loop({ id: 'work', steps: [act], until: any(until.maxSteps(20), isDone) });
```

- **Shape.** A decider asks exactly one question, and that question is boolean. `loop()`, `any()`, and `all()` check this where they are built and throw `NoeticConfigError` `INVALID_UNTIL_DECIDER` otherwise. There are no threshold knobs on the decider; the boolean question's own `threshold` (spec 32) sets where yes begins.
- **Running.** After each iteration the predicate runs the decide step through `run.executeStep(step, snapshot.lastOutput, run.ctx)`: the input is the iteration's output, and the step goes through the interpreter like any other, so its span, durable replay, and decision-layer notification apply. Called without `run` (outside a loop), a decider throws `INVALID_UNTIL_DECIDER`.
- **Verdict.** Yes → `{ stop: true }`, no → `{ stop: false }`, refusal → `{ stop: false }`. The `reason` names the step, question, answer, and probability: `decide 'is-done' answered 'stop' yes (p=0.91)`, or `decide 'is-done' refused 'stop'; continuing`. Because a refusal continues, an uncapped loop whose model refuses every time runs until its context is aborted; give such a loop a backstop (`any(until.maxSteps(n), isDone)`) when that matters.
- **Decide rules hold.** The decider writes nothing to the conversation and merges its metadata into `ctx.lastStepMeta` (spec 32, No Conversation Side Effects), so a later `until.noToolCalls()` in the same `any()` still sees the body's tool calls.
- **Fresh every iteration.** Spec 32's reuse within an execution would return the first iteration's answer whenever the output and conversation length repeat (a body that logs nothing and returns the same value). The loop therefore drops the decide step's earlier answers before each ask: every iteration is a new question.
- **Failure.** A decider whose call fails stops the loop like any throwing predicate (Error Behavior below), except that cancellation propagates.
- **Visibility.** A decide step given directly as `until` is a child of the loop for step walks (`stepChildren`), so harness preflight sees its model. One inside `any()`/`all()` is closed over and not visible to walks.

---

## Built-in Predicates

```typescript
const until = {
  maxSteps:       (n: number) => Until,
  maxCost:        (usd: number) => Until,
  maxDuration:    (duration: number) => Until,
  noToolCalls:    () => Until,                    // ReAct termination
  never:          () => Until,                    // never stops; pair with `schedule` or external cancellation
  verified:       (fn: VerifyFn) => Until,        // Ralph Wiggum external check
  converged:      (opts: ConvergeConfig) => Until,  // recursive self-refinement
  outputContains: (marker: string) => Until,      // completion promise marker (substring match)
  outputEquals:   (sentinel: string) => Until,    // exit sentinel (exact equality; avoids substring collisions)
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
  reason: snap.stepCount >= n ? `Reached max steps (${n})` : undefined,
});

const maxCost = (usd: number): Until => (snap) => ({
  stop: snap.cost >= usd,
  reason: snap.cost >= usd
    ? `Cost $${snap.cost.toFixed(2)} exceeded budget $${usd.toFixed(2)}`
    : undefined,
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
  steps: [callModel({ id: 'agent-llm', model: 'gpt-4o', tools: [launchTool] })],
  until: until.noToolCalls(),
  inbox,
  parkTimeout: 3e4,  // wait up to 30s for sub-agent results
};
```

When a sub-agent completes, its result is sent to the inbox channel. The loop wakes, injects the result as a developer message, and the LLM can incorporate it in its next response.

---

## `schedule()` — Scheduled Forever-Iteration

`schedule` runs a body step on a fixed-interval schedule, optionally woken sooner by a wake channel. It runs forever until the executing context is cancelled.

```typescript
interface ScheduleOptions<I, O> {
  id: string;
  step: Step<I, O>;
  interval: number;           // park duration between iterations (>= 0)
  inbox?: Channel<unknown>;   // any value on this channel wakes the park
  onError?: 'continue' | 'fail';   // default 'continue'
  jitter?: number;            // ms of symmetric random jitter (>= 0, default 0)
}

schedule<I, O>(opts: ScheduleOptions<I, O>): StepSchedule<I, O>;
```

### Semantics

1. The first iteration starts immediately; the body step is invoked with `input`.
2. After the body returns, `schedule` parks for `interval ± jitter` ms or until any value is sent on `inbox` — whichever happens first. The park observes the wake non-consumingly: a queue-mode wake message stays on the queue so the next iteration's body can drain it via `tryRecv`.
3. The park resolves immediately when the executing context is aborted; the next iteration's abort check then surfaces a `cancelled` `NoeticError`.
4. The operator output is `void`. `schedule` does not accumulate iteration outputs.
5. `schedule` only terminates by throw — either `cancelled` from abort, or the body's error under `onError: 'fail'`.

### Error Policy

- **`onError: 'continue'`** *(default)*: when the body throws, `schedule` records a span event named `schedule.iteration.error` with `message` and `stack` attributes, then proceeds to the park step as if no error occurred.
- **`onError: 'fail'`**: re-throws the body's error, terminating the operator. Any enclosing `inParallel({ mode: 'all' })` settles with that error.
- A `cancelled` `NoeticError` thrown by the body is never swallowed — it propagates regardless of `onError`.

### Composition with `inParallel` and `spawn`

- Inside `inParallel({ mode: 'race' })`, the first racing path that returns wins; cancelling the others aborts their `schedule`.
- Inside `inParallel({ mode: 'all' })`, a `schedule` with `onError: 'fail'` rejects the parallel group on first body failure.
- Inside `spawn`, `schedule` runs in the isolated child context with its own abort signal.

### Example

```typescript
const wake = channel('poll-wake', { schema: z.string(), mode: 'queue' });

const poller = schedule({
  id: 'job-poller',
  interval: 30_000,          // poll every 30s
  jitter: 5_000,             // ±5s to spread load
  inbox: wake,               // external trigger to poll immediately
  onError: 'continue',
  step: runCode({
    id: 'fetch-jobs',
    execute: async (_, ctx) => fetchAndDispatchPendingJobs(ctx),
  }),
});
```

Pair with `until.never()` when you need a `loop`-shaped never-stops predicate elsewhere in the same tree.

---

## Error Behavior

- **`until` predicate throws:** Treat as `{ stop: true, reason: 'Predicate error: ...' }`. The loop stops. A broken predicate should not cause infinite iteration. A `cancelled` error is the exception: it propagates and ends the loop as cancelled (spec 09), since an aborted context must not read as a clean stop.
- **Iteration cap reached:** The loop fails with `step_failed` (`Loop exceeded maximum iterations (N)`). An invalid cap fails the same way before the first iteration. A `maxIterations: Infinity` loop never reaches this branch.
- **Loop body failure with `onError`:** See `09-error-model` for full propagation rules.
- **`schedule` body failure:** Governed by `schedule`'s own `onError` policy (`'continue'` records a span event; `'fail'` re-throws).
