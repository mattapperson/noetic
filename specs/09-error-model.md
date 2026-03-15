# Error Model

> **Depends On:** `01-step-type` (stepId concept)
> **Exports:** `NoeticError`

---

## Error Types

```typescript
type NoeticError =
  | { kind: 'step_failed';          stepId: string; cause: Error; retriesExhausted: boolean }
  | { kind: 'llm_refused';          stepId: string; refusal: string }
  | { kind: 'llm_parse_error';      stepId: string; raw: string; schema: ZodType; zodError: ZodError }
  | { kind: 'llm_rate_limit';       stepId: string; retryAfter?: number }
  | { kind: 'fork_partial';         stepId: string; succeeded: Array<{ stepId: string; value: unknown }>; failed: Array<{ stepId: string; error: NoeticError }> }
  | { kind: 'spawn_summary_failed'; stepId: string; childOutput: unknown; summaryCause: Error }
  | { kind: 'channel_timeout';      channelName: string; timeout: number }
  | { kind: 'channel_closed';       channelName: string }
  | { kind: 'cancelled';            reason?: string }
  | { kind: 'budget_exceeded';      field: 'cost' | 'steps' | 'duration'; limit: number; actual: number }
```

---

## Propagation Rules

### Step Failure

Retry per policy (see `RetryPolicy` in `02-step-variants`). If retries exhausted, throw `step_failed`. The parent (loop, fork, etc.) decides what to do.

### Fork (see `03-control-flow`)

- **`mode: 'all'`** — If any path fails, cancel remaining paths and throw `fork_partial` with both succeeded and failed results. The caller decides whether to use partial results or propagate.
- **`mode: 'settle'`** — Never throws. Failed paths appear as `{ status: 'rejected' }` in the merge function's `SettleResult[]`.
- **`mode: 'race'`** — First success wins. If all fail, throw `fork_partial`.

### Loop Body Failure (see `05-loop-and-until`)

Default: propagate (loop dies). If `onError` is specified:
- `'retry'` — re-run the same iteration
- `'skip'` — move to next iteration using last successful output
- `'abort'` — propagate the error

### `until` Predicate Throws

Treat as `{ stop: true, reason: 'Predicate error: ...' }`. The loop stops. A broken predicate should not cause infinite iteration.

### Spawn with Summary Failure (see `04-spawn`)

The child's work succeeded — don't discard it. Throw `spawn_summary_failed` with `childOutput` attached so the caller can fall back to using the raw output.

### LLM Parse Error

The LLM returned text that didn't match the Zod schema. Includes the `raw` text so the caller can attempt recovery (re-prompt, manual parse, etc.).

### Channel Closed

Thrown when `ChannelHandle.send()` is called after the execution has completed. The execution's external channels are closed when the root execution finishes (success, failure, or cancellation). External callers can check `handle.closed` before sending to avoid this error.

### Cancellation

`cancelled` is thrown when `runtime.cancel()` is called on a context.

#### Propagation Semantics

Cancellation walks the execution tree depth-first from the cancelled context:

1. **Children first.** The runtime cancels all child contexts (spawned or forked) before cancelling the target context. This ensures cleanup runs bottom-up.
2. **Blocking operations.** Any pending `recv` or back-pressure `send` on a channel immediately rejects with `{ kind: 'cancelled' }`. The blocked Promise resolves with the error — it does not hang.
3. **Fork paths.** In `race` mode, non-winning paths are cancelled using the same mechanism. In `all`/`settle` mode, if cancellation arrives mid-fork, all paths are cancelled and the fork throws `cancelled` (not `fork_partial`).
4. **Loop iterations.** If cancellation arrives during a loop body, the current iteration's step is cancelled. The loop does NOT run another iteration. `onError` is NOT consulted — cancellation is not a retriable error.
5. **Memory layer cleanup.** `onComplete` runs with `outcome: 'aborted'`, then `dispose` runs. Both always execute, even under cancellation. If a memory layer hook is in-progress when cancellation arrives, the hook is allowed to complete (up to its timeout) before `onComplete`/`dispose` run.
6. **In-progress `store()` calls.** Concurrent `store()` calls are allowed to settle (they use `Promise.allSettled`). The runtime does not abort them — they may write partial results, which is acceptable because `store` is idempotent by convention.

#### Cancellation is Idempotent

Calling `runtime.cancel()` on an already-cancelled context is a no-op.

### Budget Exceeded

Budget limits (`maxCost`, `maxSteps`, `maxDuration`) are enforced by `until` predicates, which return `Verdict` objects — they do NOT throw. The `budget_exceeded` error kind exists for cases where budget enforcement happens **outside** a loop's `until` predicate — for example, when the runtime itself detects that an agent-level budget (set on `AgentConfig`) has been exceeded between steps. In that case, the runtime throws `budget_exceeded` directly.

Within a loop, the `until` predicate returns `{ stop: true, reason: 'Cost $X exceeded budget $Y' }` and the loop terminates normally. The `budget_exceeded` error is only thrown when there is no `until` predicate to catch the overage.
