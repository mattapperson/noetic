# Error Model

> **Depends On:** `01-step-type` (stepId concept)
> **Exports:** `OrchidError`

---

## Error Types

```typescript
type OrchidError =
  | { kind: 'step_failed';          stepId: string; cause: Error; retriesExhausted: boolean }
  | { kind: 'llm_refused';          stepId: string; refusal: string }
  | { kind: 'llm_parse_error';      stepId: string; raw: string; schema: ZodType; zodError: ZodError }
  | { kind: 'llm_rate_limit';       stepId: string; retryAfter?: number }
  | { kind: 'fork_partial';         stepId: string; succeeded: Array<{ stepId: string; value: unknown }>; failed: Array<{ stepId: string; error: OrchidError }> }
  | { kind: 'spawn_summary_failed'; stepId: string; childOutput: unknown; summaryCause: Error }
  | { kind: 'channel_timeout';      channelName: string; timeout: number }
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

### Cancellation

`cancelled` is thrown when `runtime.cancel()` is called on a context. Propagates to all children in the execution tree. Cancelled executions still run `onComplete` and `dispose` on their memory layers (see `11-memory-layer-system`).

### Budget Exceeded

Thrown by `until` predicates (`maxCost`, `maxSteps`, `maxDuration`) when limits are breached. Includes the `field`, `limit`, and `actual` values for diagnostics.
