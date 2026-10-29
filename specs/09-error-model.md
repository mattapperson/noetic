# Error Model

> **Depends On:** `01-step-type` (stepId concept)
> **Exports:** `NoeticError`, `NoeticConfigError`, `isNoeticError`, `isNoeticConfigError`

---

## Error Types

```typescript
type NoeticError =
  | { kind: 'step_failed';          stepId: string; cause: Error; retriesExhausted: boolean }
  | { kind: 'model_refused';          stepId: string; refusal: string }
  | { kind: 'model_parse_error';      stepId: string; raw: string; schema: StandardSchemaV1; zodError: ZodError }
  | { kind: 'model_rate_limit';       stepId: string; retryAfter?: number }
  | { kind: 'fork_partial';         stepId: string; succeeded: Array<{ stepId: string; value: unknown }>; failed: Array<{ stepId: string; error: NoeticError }> }
  | { kind: 'spawn_summary_failed'; stepId: string; childOutput: unknown; summaryCause: Error }
  | { kind: 'channel_timeout';      channelName: string; timeout: number }
  | { kind: 'channel_closed';       channelName: string }
  | { kind: 'cancelled';            reason?: string }
  | { kind: 'budget_exceeded';      field: 'cost' | 'steps' | 'duration'; limit: number; actual: number }
  | { kind: 'item_schema_mismatch'; category: 'items' | 'developerMessages' | 'toolCalls' | 'toolResults'; itemType?: string }
  | { kind: 'steering_denied';      guidance?: string }
```

`steering_denied` is raised when a context layer's `beforeToolCall` or `afterModelCall` hook denies the action (see `11-context-layer-system`), or when the harness approver refuses an `invokeTool` call to a tool that declares `needsApproval` (see `02-step-variants`, "Approval"); `guidance` carries the reason.

---

## Propagation Rules

### Step Failure

Retry per policy (see `RetryPolicy` in `02-step-variants`). If retries exhausted, throw `step_failed`. The parent (loop, inParallel, etc.) decides what to do.

### Model Provider Failure

A model call (`callModel`, `decide`) never lets a raw provider error reach the caller of `execute()`. Errors that are already a `NoeticError` or `NoeticConfigError` pass through unchanged; otherwise the error is mapped once, at the step that made the call:

- the context was aborted → `cancelled` (the abort is what broke the call);
- the provider answered HTTP 429 → `model_rate_limit` with the step's `stepId`;
- anything else → `step_failed` with the provider error as `cause`.

### inParallel (see `03-control-flow`)

- **`mode: 'all'`** — If any path fails, cancel remaining paths and throw `fork_partial` with both succeeded and failed results. The caller decides whether to use partial results or propagate.
- **`mode: 'settle'`** — Never throws. Failed paths appear as `{ status: 'rejected' }` in the merge function's `SettleResult[]`.
- **`mode: 'race'`** — First success wins. If all fail, throw `fork_partial`.

### Loop Body Failure (see `05-loop-and-until`)

Default: propagate (loop dies). If `onError` is specified:
- `'retry'` — re-run the same iteration
- `'skip'` — move to next iteration using last successful output
- `'abort'` — propagate the error

### `until` Predicate Throws

Treat as `{ stop: true, reason: 'Predicate error: ...' }`. The loop stops. A broken predicate should not cause infinite iteration. A `cancelled` `NoeticError` and a `NoeticConfigError` propagate instead and fail the loop (spec 05, Error Behavior).

### Spawn with Summary Failure (see `04-spawn`)

The child's work succeeded — don't discard it. When a layer's `onReturn` hook (for example a summarizer) throws or times out, the spawn does **not** throw: it returns the result as it stood before that hook (for a single summarizing layer, the child's raw output), and later layers still run. The failure is reported, not swallowed: the runtime builds a `spawn_summary_failed` error (`stepId`, `childOutput`, `summaryCause`), passes it to the layer state store's diagnostic sink (`diagnostic(layerId, 'onReturn', error)`), and adds a `spawn.summary_failed` event (`stepId`, `layerId`, `message`) to the child's span (the `spawn` span, or the `inParallel.path` span for a path). This matches the `onReturn` row of the hook error table in `11-context-layer-system`. The same applies to `inParallel` paths, whose results pass through `onReturn` the same way.

### LLM Parse Error

The LLM returned text that didn't match the structured-output schema. Includes the `raw` text so the caller can attempt recovery (re-prompt, manual parse, etc.).

`schema` is typed as `StandardSchemaV1` since `callModel`/ACP-agent step outputs accept any Standard Schema v1 validator. `zodError` remains populated for backward compatibility: for Zod schemas it is the real `ZodError`; for non-Zod schemas the vendor's Standard Schema issues are adapted into a synthetic `ZodError` of `custom` issues, so consumers keep a single error surface.

### Item Schema Mismatch

Thrown by `ItemSchemaRegistry` when an item fails extension-schema validation at a trust boundary (model output parsing, session restore, tool-result decoration). `category` names the schema category consulted; `itemType` is set when an unknown item type was rejected under `strictUnknownExtensions`. Tool-result validation is owner-scoped (see `08-runtime`): only the called tool's own `toolResults` schemas can raise this for its result items.

### Channel Closed

Thrown when `ChannelHandle.send()` is called after the execution has completed. The execution's external channels are closed when the root execution finishes (success, failure, or cancellation). External callers can check `handle.closed` before sending to avoid this error. Closure is an error only for `send` — an external channel stream (`getChannelStream`) reports it as normal end-of-iteration after draining buffered values.

### Cancellation

`cancelled` is thrown when `runtime.cancel()` is called on a context, or when
`ctx.abort()` is called directly.

The two entry points differ only in cleanup:

| | `ctx.abort(reason)` | `runtime.cancel(ctx, reason)` |
|---|---|---|
| Aborts the context and its descendants | yes | yes |
| Runs context-layer teardown (`onComplete` + `dispose`) | no | yes |
| Return type | `void` (synchronous) | `Promise<void>` (awaits teardown) |

Hosts that own the context lifecycle themselves can use `ctx.abort()`; anything
else should call `runtime.cancel()`.

#### Propagation Semantics

Cancellation covers the whole execution tree rooted at the cancelled context:

1. **Down the tree, never up.** Aborting a context cascades synchronously into
   every live child context — inParallel paths, spawn children, and their own
   descendants — so a nested sub-agent stops when its parent is cancelled. It
   never travels the other way: aborting a child leaves the parent running.
   A child context created *after* its parent was cancelled is aborted at
   construction, so cancellation cannot be outrun by a spawn in flight.
2. **Blocking operations.** Any pending `recv` or back-pressure `send` on a channel immediately rejects with `{ kind: 'cancelled' }`. The blocked Promise resolves with the error — it does not hang.
3. **inParallel paths.** In `race` mode, non-winning paths are cancelled using the same mechanism. In `all`/`settle` mode, if cancellation arrives mid-execution, all paths are cancelled and the `inParallel` throws `cancelled` (not `fork_partial`).
4. **Loop iterations.** If cancellation arrives during a loop body, the current iteration's step is cancelled. The loop does NOT run another iteration. `onError` is NOT consulted — cancellation is not a retriable error.
5. **In-flight model calls and ACP agent turns.** The executing context's
   abort signal is threaded into the model call and into the ACP session's
   turn (which issues `session/cancel`), so cancellation cuts the stream and the tool-round
   loop mid-flight rather than waiting for a long generation to finish. Tokens
   and cost already spent are charged to the context; the truncated response is
   not returned as the step's output — the step throws `cancelled`.
6. **Context layer cleanup.** `onComplete` runs with `outcome: 'aborted'`, then `dispose` runs. Both always execute, even under cancellation. If a context layer hook (`recall`, `store`, `beforeToolCall`, `afterModelCall`, `onDecision`) is in-progress on a context when cancellation arrives, the runtime waits for it to settle (up to its timeout) before running that context's `onComplete`/`dispose`. Cleanup runs bottom-up: a child context's teardown completes before its parent's.
7. **In-progress `store()` calls.** Concurrent `store()` calls are allowed to settle (they use `Promise.allSettled`). The runtime does not abort them — they may write partial results, which is acceptable because `store` is idempotent by convention.

Cancellation is cooperative beyond those points: step code that ignores
`ctx.aborted` between `await`s runs until its next step boundary, which is where
the interpreter throws `cancelled`.

#### Graceful Cancellation

`runtime.cancel(ctx, { drainMs })` holds every new step, model round and tool
call beneath `ctx`, lets the model calls already in flight finish and be
charged for up to `drainMs`, and then cancels exactly as above. The held work
throws `cancelled`; calls still running at the deadline are cut off by the same
abort signal as item 5. A second `cancel` during the drain cancels at once. See
`08-runtime` § Graceful Stop.

#### Cancellation is Idempotent

Calling `runtime.cancel()` on an already-cancelled context is a no-op, and the
first `abort()` owns `ctx.abortReason` — a later abort does not overwrite it.

---

## `NoeticConfigError`

`NoeticConfigError` is a separate class from `NoeticError`. The two are never interchangeable:

- **`NoeticError`** — thrown during execution (LLM failures, inParallel failures, spawn errors, budget exceeded, cancellation). Always has a `kind` discriminant. Caught by callers of `execute()`.
- **`NoeticConfigError`** — thrown during construction and setup (invalid step config, missing env vars, invalid context layer config, runtime misconfiguration). Always has `code`, `hint`, and optional `docsUrl`. Raised before execution begins wherever the problem is statically detectable: builders validate their own options, and `AgentHarness.run()` / `execute()` walk the step tree before running any step, raising `NO_LLM_PROVIDER` up front when a statically declared `callModel` or `decide` step has no LLM provider to run on. Problems only visible at run time (a dynamically chosen branch, a lazily resolved model) are raised at the step that hits them.

```typescript
class NoeticConfigError extends Error {
  readonly code: string;       // SCREAMING_SNAKE_CASE, e.g. 'MISSING_API_KEY'
  readonly hint: string;       // complete sentence: what the user should do next
  readonly docsUrl: string;    // defaults to the code's section of the error reference
}

function isNoeticConfigError(e: unknown): e is NoeticConfigError;
```

### Rules

1. `code` MUST be `SCREAMING_SNAKE_CASE` and uniquely identify the error condition across the entire framework.
2. `hint` MUST be a complete sentence. It MUST NOT say "an error occurred" or restate the message.
3. `docsUrl` defaults to the code's section of the error reference, `https://noetic.tools/docs/framework/errors#<code in lower case>`. A throw site MAY pass a more specific page.
4. Error messages MUST NOT expose internal stack details, file paths, or implementation class names.
5. Every `code` value MUST have its own section in the error reference (`packages/web/content/docs/framework/errors.mdx`, served at `/docs/framework/errors`), headed by the code itself so its anchor is the code in lower case, with the cause and the fix. A drift test fails when a code thrown in source has no section, or a section names a code no longer thrown.
6. Construction-time functions (builders, factories, context layer factories) that can throw `NoeticConfigError` MUST document the applicable `code` values in a `@throws` TSDoc tag.

### Example

```
NoeticConfigError: Missing required environment variable.
  code: MISSING_API_KEY
  hint: Set OPENROUTER_API_KEY in your environment or pass an llm config to AgentHarness.
  docsUrl: https://noetic.tools/docs/framework/errors#missing_api_key
```

### Type Guards

`isNoeticError(e)` narrows an `unknown` value to `NoeticErrorImpl`. It uses an `instanceof` fast path with a structural fallback (an `Error` carrying `noeticError.kind: string`), so the guard keeps working when two copies of the types package are loaded (mixed `src`/`dist` resolution, duplicated node_modules). The inner `kind` is not validated against the closed union — errors minted by a newer package version still pass.

### Budget Exceeded

Budget limits (`maxCost`, `maxSteps`, `maxDuration`) are enforced by `until` predicates, which return `Verdict` objects — they do NOT throw. The `budget_exceeded` error kind exists for cases where budget enforcement happens **outside** a loop's `until` predicate — for example, when the runtime itself detects that an agent-level budget (set on `AgentConfig`) has been exceeded between steps. In that case, the runtime throws `budget_exceeded` directly.

Within a loop, the `until` predicate returns `{ stop: true, reason: 'Cost $5.12 exceeded budget $5.00' }` and the loop terminates normally. The `budget_exceeded` error is only thrown when there is no `until` predicate to catch the overage.

## Connection Errors

Connections (`35-connections`) and verification (`37-verification`) add `NoeticConfigError` codes for setup and validation (`CONNECTION_*`, `UNKNOWN_CONNECTION_SLOT`, `UNKNOWN_CONNECTION_INSTANCE`, `INVALID_CONNECTION_REQUIREMENT`, `VERIFIER_NOT_CONFIGURED`, `VERIFY_*`) and `NoeticError` kinds for run-time failures (`connection_*`, `task_lost`, `event_gap`, `verification_act_failed`). Each spec's § Errors lists its codes and kinds with their conditions and payloads; this spec's rules apply to all of them.
