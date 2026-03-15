# Loop and Until: Iteration and Termination

> **Depends On:** `01-step-type` (Step<I,O>), `07-context-and-event-log` (Context), `09-error-model` (NoeticError)
> **Exports:** `loop()`, `LoopOpts`, `Until`, `Verdict`, `Snapshot`, `until.*` predicates, `any()`, `all()`, `VerifyFn`, `ConvergeOpts`

---

## `loop()` — Repeating Execution

Combines a body step + termination predicate + optional input preparation into repeating execution.

```typescript
interface LoopOpts<I, O> {
  id: string;
  body: Step<I, O>;
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

`onError` controls behavior when the loop body fails:

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
  verified:       (fn: VerifyFn) => Until,        // Ralph Wiggum external check
  converged:      (opts: ConvergeOpts) => Until,  // recursive self-refinement
  outputContains: (marker: string) => Until,      // completion promise marker
  custom:         (fn: Until) => Until,           // escape hatch
};

type VerifyFn = (output: unknown) => Promise<{ pass: boolean; feedback?: string }>;

interface ConvergeOpts {
  threshold: number;  // 0-1, similarity between consecutive outputs
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

## Error Behavior

- **`until` predicate throws:** Treat as `{ stop: true, reason: 'Predicate error: ...' }`. The loop stops. A broken predicate should not cause infinite iteration.
- **Loop body failure with `onError`:** See `09-error-model` for full propagation rules.
