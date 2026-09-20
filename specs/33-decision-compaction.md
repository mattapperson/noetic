# 33: Decision-Based Context Compaction

> **Depends On:** `32-system-one-decisions` (`SystemOneClient` contract, the shared execution path), `11-context-layer-system` (`ContextLayer` contract, `projectHistory`), `12-builtin-context-layers` (`history()`, the layer this one runs after)
> **Exports:** `decisionCompaction()` (`@noetic-tools/context`)

---

A `projectHistory` layer that deletes stale tool traffic from the transcript instead of
summarizing it, using a System One model to judge what is still needed. It is the first
consumer of spec 32's contract and, like every other caller there, takes its client by
injection.

It ships `@public @unstable`. Its graduation criterion is its own and is deliberately not tied
to the protocol's: **measured false-deletion behaviour on real transcripts, and a
`keepThreshold` policy justified by it.** The calibration harness existing is not the bar; a
result from it is.

As a `projectHistory` hook it is a read-side projection of what the next model call sees; it
never mutates the item log.

## Delete, never summarize

Summarizing a transcript loses what an agent most needs verbatim: exact file paths, exact error
strings, constraints the user stated once. This layer only *removes* or *truncates* tool traffic.
Every item it keeps is byte-identical to what was logged; user and assistant prose is never
rewritten. Adapted, with attribution, from
[`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction) (MIT).

## Algorithm

1. **Pair.** Match `function_call` to `function_call_output` by `callId`.
2. **Pin.** The last `preserveExchanges` complete exchanges (default 1) are never scored,
   expanded to whole exchanges with the primitive `history()` uses. `preserveRecentMessages`
   is an item-count ceiling on the pinned region, so one 300-tool-call turn cannot pin
   everything; when fewer than `preserveExchanges` user messages exist (a spawned child, a
   scheduled step) the layer falls back to that trailing-item pin. A pair with *either* side
   pinned is excluded from scoring.
3. **Build state.** Render the transcript with tool *results* replaced by placeholders
   (`ok, 4213 chars (omitted)`): the judge decides relevance from the call and a size hint, not
   the payload. This is the layer's load-bearing assumption and it is unproven, inherited from
   `fast-jev-compaction` as a design choice, validated only once the calibration harness exists.
4. **Fit.** `maxStateTokens` bounds the state **plus the longest single question**, not the
   state alone, so fitting reserves question overhead before comparing: the budget is
   `maxStateTokens - tokens(longest question)`. Checking the rendered state by itself lets a
   31,950-token state with a 100-token question clear both limits and still exceed a 32,000
   per-question bound at the backend. If the state is over budget, apply progressively:
   truncate tool inputs 1000 → 200 → 60 chars; abridge long text head+tail; collapse old
   unpinned messages; fold runs of call-only messages. Record the stage reached. Sizing uses
   the client's own tokenizer where it exposes one, and a conservative `estimateTokens`
   otherwise, since a backend's tokenizer is not knowable from here and undercounting is the
   direction that fails.
5. **Score.** Two nouls per unpinned call (*should this call remain?* *should its result
   remain?*) in **one** request carrying the layer's `AbortSignal`. Calls that do not fit under
   `client.limits.maxRequestTokens` are left unscored.
6. **Decide.** `keepResult ≥ threshold` → keep both. Else `keepCall ≥ threshold` → keep the call,
   truncate the result to `truncateHeadChars`. Else drop both.
7. **Rebuild.** Reassemble in original order, then `stripUnresolvedToolCalls`, so no output
   survives without its call.

## Options

| Option | Default | Meaning |
|---|---|---|
| `client` | *required* | The `SystemOneClient` to judge with |
| `slot` | `HISTORY_WINDOW_SLOT + 5` | After `history()`; see below |
| `keepThreshold` | **required** | Noul probability at or above which an item is kept |
| `preserveExchanges` | `1` | Complete trailing exchanges never scored |
| `preserveRecentMessages` | `6` | Ceiling on the pinned region, in items; also the fallback pin |
| `triggerAtTokens` | `0.6 × budget` | Skip the layer below this |
| `truncateHeadChars` | `300` | Head kept when a result is truncated rather than dropped |
| `timeouts.projectHistory` | **required** | Hard outer bound; must exceed the backend's worst case |
| `enabled` | `() => true` | Kill switch, re-evaluated every turn |

**Which way `keepThreshold` points.** An item is kept when `P(needed) >= keepThreshold`, so
raising the bar keeps *less*:

| `keepThreshold` | Effect | Failure mode |
|---|---|---|
| low (≈0.2) | keeps almost everything | wastes tokens; recoverable, and visible in the bill |
| high (≈0.9) | keeps only near-certain items | deletes context the next call needed; **undetectable**, because the item is simply absent |

The two failures are not symmetric, so the safe direction is *down*. Authors start low and raise
it against measurement, watching false deletions rather than token savings. There is no default
because a midpoint would arbitrate that asymmetry with a statistic nobody has calibrated for
this task; picking one is the author's call, made with their own data.

## Where it runs

After `history()` (slot 280), so it judges exactly the window that will be sent and one request
covers it. Two consequences:

- Compaction only prunes what `history()` kept. Size `history({ maxItems })` generously when
  composing it; the ceiling is `maxItems × 4`.
- The delivered count is `≤ maxItems`, not `= maxItems`. `compaction.complete` carries the ratio
  of delivered items to `history()`'s cap so the gap is observable.

## One request, then fall back

Compaction is capped at a single evaluation. The state is re-sent with every batch, so a
K-batch compaction pays K× the state cost, and K grows precisely when the transcript is largest
and the time budget tightest. Scoring what fits and leaving the rest is strictly better than
multiplying cost to achieve zero.

## Shared primitive; what "pinned" means

`history()`'s exchange-expansion helper is extracted to a shared utility both layers import, so
they cannot drift in what they call an exchange. `HISTORY_WINDOW_SLOT` is private for the same
reason and gets the same treatment: this layer's default slot is defined relative to it, so
`history.ts` exports it alongside the helper. Otherwise an implementer either adds an
undocumented export or retypes `280`, which is the drift this paragraph exists to prevent. "Pinned" means *never scored or dropped by this
layer*, not a promise the exchange reaches the model, which a later windowing layer could still
slice. With the default ordering that cannot happen.

## Failure policy

Fails **open**: on error or timeout the projection is the input, unchanged. The lifecycle already
provides this: `projectHistoryLayers` catches, records a diagnostic, and carries the previous
items forward.

Timeouts must abort, not just stop waiting. The lifecycle's `withTimeout` is a `Promise.race`
that never cancels the loser, so a timed-out hook leaves its HTTP calls and retries running; every
turn against a slow backend, those orphans accumulate against the rate limit. The layer creates an
`AbortController` **at hook entry**, armed for 0.8× the registered `timeouts.projectHistory`,
and passes its signal through `client.evaluate({ signal })`, which cancels the request and its
pending retries. The registered value is required because the lifecycle default is 5s, far too
short for a network call with retries.

## Operability

- **Kill switch.** `enabled` is a predicate re-evaluated every turn. A predicate reading an
  environment variable or config store can be flipped fleet-wide mid-incident; the docs show
  that form as the default recipe. A hard-coded `() => false` is a composition change like any
  other.
- **Telemetry, as span events rather than framework events.** The layer records `compaction.complete` /
  `compaction.failed` / `compaction.timeout` via `ctx.trace.addEvent` with item counts in and
  out, tokens saved, the delivered-vs-cap ratio, latency, and error class. Never `state` or
  item content. A `projectHistory` hook receives `ExecutionContext`, which exposes only
  `trace.*`; the broadcaster behind `emitFrameworkEvent` needs a full `Context` no layer hook
  has. And `trace.addEvent` forwards to `ctx.span.addEvent`, a no-op without a tracing backend,
  so **compaction telemetry exists only when the host has configured one.** This is one of two
  facilities a layer hook cannot reach; see "One execution path".

## Opt-in

`ProjectionPolicy.overflow` keeps its existing values and default. Composing this layer is an
explicit act; no existing agent silently acquires a network dependency.

---


---

## Testing invariants

Beyond `.claude/rules/testing.md`, and in addition to spec 32's:

1. Property test over generated transcripts: **no `function_call_output` survives without its
   `function_call`**.
2. **Kept items are byte-identical** to their inputs, the anti-summarization invariant.
3. Fail-open: a throwing client yields the input items unchanged.
4. A timed-out compaction **aborts its in-flight request**, asserted through the real
   `projectHistoryLayers` wrapper with slow-preprocessing and slow-client doubles: the client's
   `signal` fires *before* the lifecycle's `withTimeout` rejects.
5. The single-request cap: against limits that cannot hold every question, exactly one
   `evaluate` call, under `maxRequestTokens`, with overflow calls left unscored and unmodified.
6. **Pinning survives its edge cases**: no user message at all falls back to the item pin and
   still scores something; one exchange of 300 tool pairs pins at most `preserveRecentMessages`
   items; no pair with either side pinned is scored.

---

## Rejected alternatives

- **Multi-batch compaction.** K batches re-send the state K times, worst exactly when the
  transcript is largest; the single-request cap degrades to the cheap path instead.
- **Compaction before `history()`, bounded to its prospective window.** Requires knowing
  `history()`'s private constants, coupling two layers the slot system keeps independent.
- **A default `keepThreshold`.** A midpoint arbitrates an asymmetric failure with an
  uncalibrated statistic; the harness is the precondition for any default.

---

## Future Considerations

- **Calibration harness.** An eval suite measuring a backend's calibration error on the user's
  own data. A precondition for a default `keepThreshold` and for graduating this layer.
- **Other context policies.** Compaction is one policy, not the only one spec 32's contract can
  carry. An admission or retention layer (what enters memory, what survives a session) would
  take a `SystemOneClient` by injection and reuse the shared execution path, fail-open
  semantics, and the same `ExecutionContext` limits, needing no bespoke integration.
