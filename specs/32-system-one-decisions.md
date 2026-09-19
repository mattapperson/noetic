# 32 — System One Decisions

> **Depends On:** `01-step-type` (Step union), `11-context-layer-system` (`ContextLayer` contract, `projectHistory`), `16-semantic-conditions` (`Condition`, `semanticSwitch`), `05-loop-and-until` (`UntilPredicate`), `17-eval-and-optimization` (scorers), `23a-step-level-resume` (ledger), `14-design-decisions` (`@unstable` on a public surface)
> **Exports:** `SystemOneClient`, `SystemOneLimits`, `DecisionQuestion`, `DecisionAnswer`, `DecideResult` (`@noetic-tools/types`); `noul()`, `choice()`, `score()`, `jev()`, `openSystemOne()` (`@noetic-tools/system-one`); `step.decide()` (`@noetic-tools/core`); `decisionCompaction()` (`@noetic-tools/context`); `decisionCondition()`, `decisionSwitch()`, `until.decided()` (`@noetic-tools/core`); `decisionScorer()` (`@noetic-tools/eval`)

---

An agent loop makes dozens of small decisions per turn that have nothing to do with generating
prose: *is this request urgent? which sub-agent handles it? is the loop done? is this stale
transcript entry still worth its tokens?* Today each one costs a full autoregressive round trip.
`aiCondition` sends a system prompt, waits for a chat completion, `JSON.parse`s the reply, and
on any malformed output silently returns `false` — a 1–3 second, cents-scale, untyped answer to
a yes/no question.

A **System One model** answers the same question in 70–500ms, returns a *typed* value with a
probability attached, and charges for input only. The vendor's central claim — which this spec
relies on but has not independently measured — is that evaluating N questions against one
state costs about the same wall-clock as evaluating one. If so, batching every decision in a
turn into a single call is the cheap path rather than the expensive one.

For compaction the economics are lopsided either way. At $0.042 per million input tokens a
25k-token judging request costs about a tenth of a cent; every 10k stale tokens it removes from
the *next* frontier-model call, at roughly $10 per million, saves about ten cents. On any turn
where it removes anything it pays for itself many times over, and below `triggerAtTokens` it
does not run at all.

This spec defines how Noetic consumes that capability without binding itself to one vendor.

---

## Naming and stability

Every public identifier is named for the **capability**, not the provider: `step.decide()`,
`SystemOneClient`, `decisionCompaction()`. The package, `@noetic-tools/system-one`, is named
for the wire protocol (`POST /v1/systemone`) exactly as `@noetic-tools/acp` is named for the
Agent Client Protocol; `jev()` is one provider among several, the way `claudeCode()` is one
ACP adapter. Provider factories *are* vendor-named because an author choosing between them
needs to know which backend they are getting.

Every surface here ships tagged **`@unstable`** alongside `@public`: it may change shape or be
removed in a minor release (`14-design-decisions`, `commit-conventions.md`). The protocol is
young, with one commercial implementation and one community reimplementation, and `step.decide`
joining core's `Step` union would otherwise be a promise retractable only by a major bump. The
tag is a commitment to resolve that uncertainty, not a permanent hedge:

| Surface | Graduates when |
|---|---|
| `SystemOneClient`, `step.decide` | The vendor API is stable **or** a second independent `/v1/systemone` implementation ships |
| `@noetic-tools/system-one` | `@typesafe-ai/sdk` reaches 1.0 |
| `decisionCompaction()` | The calibration harness exists and a default `keepThreshold` can be justified from measurement |

Graduation removes one JSDoc tag and changes no import path.

---

## Architecture

```
@noetic-tools/types          SystemOneClient contract + question/answer types (no I/O)
        ▲            ▲
        │            │
@noetic-tools/       @noetic-tools/core        step.decide → calls the contract,
  system-one           (never imports              never the implementation
  (SDK adapter,         system-one)
   providers)
        ▲
        │ injected by the author
   @noetic-tools/context   decisionCompaction()
   @noetic-tools/eval      decisionScorer()
```

`core`, `context`, and `eval` **never import `@noetic-tools/system-one`**; each takes the
client by injection. All three edges are `[[boundaries]]` rules in `.sentrux/rules.toml` with a
`reason`, mirroring the boundaries `@noetic-tools/agent-plugins` carries. An agent that composes
`step.decide` without constructing a client pulls in no transport, and swapping hosted inference
for a self-hosted endpoint is a one-line change to the wiring.

It is not a one-line change to *behaviour*. The contract guarantees the shape of an answer,
never its distribution: no backend publishes a calibration guarantee, and the reference
self-hosted implementation warns its probabilities are order-dependent and uncalibrated. Any
threshold — `keepThreshold`, a confidence gate — is **backend-relative and must be re-validated
after a swap**.

---

## The contract — `@noetic-tools/types`

### Questions

```typescript
/**
 * @public A value that can cross the wire. Not `unknown`: functions, symbols and
 * `undefined` do not survive serialization, and every backend's request type is
 * JSON-constrained.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** @public Free-form material a question or its criteria are expressed as. */
export type DecisionState = string | { [key: string]: JsonValue } | JsonValue[];

/** @public A yes/no proposition. Answered with a probability in [0,1]. */
export interface NoulQuestion {
  readonly type: 'noul';
  readonly instructions: DecisionState;
  /** Optional prose pinning what `true` and `false` mean at the boundary. */
  readonly criteria?: { readonly true: string; readonly false: string };
}

/** @public Pick exactly one option. `O` is the literal union of option keys. */
export interface ChoiceQuestion<O extends string = string> {
  readonly type: 'choice';
  readonly instructions: DecisionState;
  /** Option key → description. `null` means "the key speaks for itself". */
  readonly criteria: Readonly<Record<O, string | null>>;
}

/** @public Rate against ordered levels, lowest first. */
export interface ScoreQuestion {
  readonly type: 'score';
  readonly instructions: DecisionState;
  /** At least two levels, enforced by the type. */
  readonly criteria: readonly [DecisionState, DecisionState, ...DecisionState[]];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion<string> | ScoreQuestion;
```

### Answers

```typescript
export interface NoulAnswer {
  readonly type: 'noul';
  /** Probability the proposition is true, in [0,1]. */
  readonly noul: number;
}

export interface ChoiceAnswer<O extends string = string> {
  readonly type: 'choice';
  readonly choice: O;
  readonly probabilities: Readonly<Record<O, number>>;
  /** Concentration of the distribution in [0,1]. NOT the winning probability. */
  readonly confidence: number;
}

export interface ScoreAnswer {
  readonly type: 'score';
  /**
   * Probability-weighted mean of the level numbers — NOT an index. It is
   * continuous and routinely lands between levels (`1.3` from
   * `0×0.0 + 1×0.70 + 2×0.30`), so `criteria[answer.score]` is always wrong.
   */
  readonly score: number;
  /** Level number (stringified) → that level's description. */
  readonly legend: Readonly<Record<string, string>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer<string> | ScoreAnswer;
```

`confidence` is surfaced, documented as "validate against your own data", and never silently
gated on. `DecisionState` is a type-level guarantee only: the adapter also validates `state`,
`instructions` and `criteria` with Zod where they cross into a backend (type-safety rule 7) and
raises `NoeticConfigError` `DECISION_STATE_NOT_SERIALIZABLE` naming the offending path.

### Client

```typescript
export interface DecisionRequest {
  readonly state: DecisionState;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
  readonly signal?: AbortSignal;
}

export interface DecisionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** USD. Left undefined by the adapter; pricing is owned by the eval cost scorer. */
  readonly cost?: number;
}

export interface DecisionResponse {
  readonly model: string;
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  readonly usage: DecisionUsage;
}

/** @public Declared capabilities, so a caller can size a request without hard-coding vendor numbers. */
export interface SystemOneLimits {
  /** Max tokens for `state` plus the longest question, per request. */
  readonly maxStateTokens: number;
  /** Max tokens for the whole request. */
  readonly maxRequestTokens: number;
  /** Max options in a single `choice`. */
  readonly maxChoiceCardinality: number;
}

export interface SystemOneClient {
  readonly model: string;
  readonly limits: SystemOneLimits;
  evaluate(request: DecisionRequest): Promise<DecisionResponse>;
}
```

`limits` lives on the contract because backends differ: hosted Jev allows 255 choice options,
the reference self-hosted build allows 64.

---

## `@noetic-tools/system-one` — the client package

Also known as the **Jev** / `/v1/systemone` protocol; if you arrived from TypeSafe's docs or
from `openjev-sglang`, this is that protocol.

Depends on `@noetic-tools/types`, `zod` (dependency and `^4` peer, as `acp` declares it), and
the vendor's official `@typesafe-ai/sdk`. By convention it is the only Noetic package that
depends on that SDK, as `agent-plugins` is for the MCP SDK; note this is convention, not a gate —
sentrux checks source imports, not `package.json` dependencies.

### The adapter

The official SDK is zero-runtime-dependency, ships typed request/response shapes, a typed error
hierarchy, a retry policy, an injectable `fetch`, and a `baseURL` that reaches self-hosted
endpoints too. What Noetic keeps for itself is the **vendor-neutral `SystemOneClient` contract**:
core and the layers know only that contract, and this package is the adapter between it and
one concrete SDK. A future OpenRouter provider is a second adapter behind the same interface.

The adapter is a real translation layer, not a re-export, because the two type hierarchies are
incompatible in both directions under `strict`: the SDK's `instructions` is optional and
nullable where Noetic's is required, and Noetic's `DecisionState` is not assignable to the SDK's
`EntryType`. Owning that mapping is what contains a pre-1.0 SDK's churn to this package.

### Question builders

Noetic's own, constructing Noetic's types:

```typescript
noul('Does this message express urgency?')
noul('Is the task complete?', { true: 'all subtasks done', false: 'any subtask open' })

choice('Which queue handles this?', {
  billing: 'payment, invoices, refunds',
  technical: 'bugs, outages, errors',
  other: null,
})

score('How severe is this incident?', [
  'cosmetic, no user impact',
  'degraded for some users',
  'total outage',
])
```

Option keys survive as a literal union into the answer type: `answers.queue.choice` is
`'billing' | 'technical' | 'other'`, not `string`. The conformance test pins this.

### Providers

```typescript
/** Hosted inference. Reads TYPESAFE_API_KEY when apiKey is omitted. */
jev(opts?: { apiKey?: string; model?: string; baseUrl?: string; fetch?: typeof fetch })

/** Any endpoint speaking the same wire format (e.g. openjev-sglang). */
openSystemOne(opts: { baseUrl: string; model: string; limits?: Partial<SystemOneLimits>; ... })
```

Both construct the SDK client eagerly, so a missing key fails once, loudly, at the composition
call site — as `createOpenRouterEmbed` does — with the SDK's `TypeSafeError` mapped to
`NoeticConfigError` `SYSTEM_ONE_MISSING_API_KEY`. They differ only in base URL, model id,
declared `limits`, and whether a key is required.

### Error mapping

`NoeticError` is a closed union, so this adds exactly one member. Author mistakes use
`NoeticConfigError`, whose `code` is free-form.

```typescript
| {
    kind: 'system_one_failed';
    /** Provider label for diagnostics, e.g. 'jev' — never the base URL or key. */
    provider: string;
    status?: number;
    /** Whether the SDK had exhausted its retries on this class. */
    retryable: boolean;
    retryAfter?: number;
    cause?: Error;
  }
```

The SDK owns retry and backoff; the adapter only translates:

| SDK error | Raised as | Retried by the SDK |
|---|---|---|
| `AuthenticationError` | `NoeticConfigError` `SYSTEM_ONE_UNAUTHORIZED` | no |
| `UnprocessableEntityError` / `BadRequestError` | `NoeticConfigError` `SYSTEM_ONE_INVALID_REQUEST` | no |
| `RateLimitError` | `system_one_failed` `retryable: true` | yes |
| `InternalServerError` / `APIConnectionError` / `APITimeoutError` | `system_one_failed` `retryable: true` | yes |
| `PermissionDeniedError` / `NotFoundError` | `system_one_failed` `retryable: false` | no |
| `APIUserAbortError` | rethrown as the runtime's cancellation | n/a |

A contract-conformance test — the drift gate a pre-1.0 dependency needs, and one that runs
without credentials — asserts that the adapter satisfies `SystemOneClient`, that each SDK error
class maps to the documented kind, and that the worked example above compiles as a type-level
fixture in both directions. That last assertion is what an SDK bump breaks first.

---

## `step.decide` — the step primitive

```typescript
step.decide({
  id: 'triage',
  client: jev(),
  state: (input, ctx) => input.ticket,
  questions: {
    urgent: noul('Does this express urgency?'),
    queue: choice('Which queue handles this?', {
      billing: 'payment, invoices, refunds',
      technical: 'bugs, outages, errors',
    }),
  },
})
```

Adds `kind: 'decide'` to the `Step` union. The output is a typed record keyed by question id —
`type DecideResult<QS> = { [K in keyof QS]: AnswerFor<QS[K]> }` — so `result.urgent.noul` is
`number` and `result.queue.choice` is `'billing' | 'technical'`.

`client` and `questions` are `Lazy`, resolvable from `ctx` like `step.acpAgent`'s `agent`.
`state` is not: it is a two-argument projector `(input, ctx) => DecisionState`, because it exists
to read the current turn's input and `Lazy` resolution is ctx-only.

**Not `step.callModel`.** `CallModelRequest` is shaped around items, tools, streaming, and
output codecs. A decision has none of those and no output tokens to bill; a separate step kind
keeps both abstractions honest.

**Usage.** `trackDecisionUsage(ctx, response.usage)` mirrors `trackUsage`, so decisions appear in
session cost alongside model calls.

**Observability.** Emits `decide.start` / `decide.complete` framework events carrying question
ids, model, latency, and per-question `confidence` — never the state.

**Durable resume.** `decide` joins the memoized set alongside `callModel` (`23a`): a resumed run
replays the recorded answers and routes exactly as the pre-crash run did. The ledger's replay
check compares only `stepId` and `kind`, which is tolerable for prose-producing steps and not for
one whose job is control flow off live input — so a `decide` entry also records a hash of the
resolved `state` and `questions`, and a mismatch re-runs instead of replaying.

---

## `decisionCompaction()` — the context layer

A `projectHistory` layer: a read-side projection of what the next model call sees. It never
mutates the item log.

### Delete, never summarize

Summarizing a transcript loses what an agent most needs verbatim — exact file paths, exact error
strings, constraints the user stated once. This layer only *removes* or *truncates* tool traffic.
Every item it keeps is byte-identical to what was logged; user and assistant prose is never
rewritten. Adapted, with attribution, from
[`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction) (MIT).

### Algorithm

1. **Pair.** Match `function_call` to `function_call_output` by `callId`.
2. **Pin.** The last `preserveExchanges` complete exchanges (default 1) are never scored,
   expanded to whole exchanges with the primitive `history()` uses. `preserveRecentMessages`
   is an item-count ceiling on the pinned region, so one 300-tool-call turn cannot pin
   everything; when fewer than `preserveExchanges` user messages exist (a spawned child, a
   scheduled step) the layer falls back to that trailing-item pin. A pair with *either* side
   pinned is excluded from scoring.
3. **Build state.** Render the transcript with tool *results* replaced by placeholders
   (`ok, 4213 chars (omitted)`): the judge decides relevance from the call and a size hint, not
   the payload. This is the layer's load-bearing assumption and it is unproven — inherited from
   `fast-jev-compaction` as a design choice, validated only once the calibration harness exists.
4. **Fit.** If the rendered state exceeds `client.limits.maxStateTokens`, apply progressively:
   truncate tool inputs 1000 → 200 → 60 chars; abridge long text head+tail; collapse old
   unpinned messages; fold runs of call-only messages. Record the stage reached.
5. **Score.** Two nouls per unpinned call — *should this call remain?* *should its result
   remain?* — in **one** request carrying the layer's `AbortSignal`. Calls that do not fit under
   `client.limits.maxRequestTokens` are left unscored.
6. **Decide.** `keepResult ≥ threshold` → keep both. Else `keepCall ≥ threshold` → keep the call,
   truncate the result to `truncateHeadChars`. Else drop both.
7. **Rebuild.** Reassemble in original order, then `stripUnresolvedToolCalls`, so no output
   survives without its call.

### Options

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

`keepThreshold` has no default because the failure directions are asymmetric: too low silently
deletes context the next call needed, undetectably; too high only wastes tokens. A midpoint
would arbitrate that with an uncalibrated statistic. Authors start conservatively (≈0.9, the
vendor's "act automatically" tier) and lower it against measurement.

### Where it runs

After `history()` (slot 280), so it judges exactly the window that will be sent and one request
covers it. Two consequences:

- Compaction only prunes what `history()` kept. Size `history({ maxItems })` generously when
  composing it; the ceiling is `maxItems × 4`.
- The delivered count is `≤ maxItems`, not `= maxItems`. `compaction.complete` carries the ratio
  of delivered items to `history()`'s cap so the gap is observable.

### One request, then fall back

Compaction is capped at a single evaluation. The state is re-sent with every batch, so a
K-batch compaction pays K× the state cost — and K grows precisely when the transcript is largest
and the time budget tightest. Scoring what fits and leaving the rest is strictly better than
multiplying cost to achieve zero.

### Shared primitive; what "pinned" means

`history()`'s exchange-expansion helper is extracted to a shared utility both layers import, so
they cannot drift in what they call an exchange. "Pinned" means *never scored or dropped by this
layer* — not a promise the exchange reaches the model, which a later windowing layer could still
slice. With the default ordering that cannot happen.

### Failure policy

Fails **open**: on error or timeout the projection is the input, unchanged. The lifecycle already
provides this — `projectHistoryLayers` catches, records a diagnostic, and carries the previous
items forward.

Timeouts must abort, not just stop waiting. The lifecycle's `withTimeout` is a `Promise.race`
that never cancels the loser, so a timed-out hook leaves its HTTP calls and retries running; every
turn against a slow backend, those orphans accumulate against the rate limit. The layer creates an
`AbortController` **at hook entry**, armed for 0.8× the registered `timeouts.projectHistory`,
and passes its signal through `client.evaluate({ signal })`, which cancels the request and its
pending retries. The registered value is required because the lifecycle default is 5s, far too
short for a network call with retries.

### Operability

- **Kill switch.** `enabled` is a predicate re-evaluated every turn. A predicate reading an
  environment variable or config store can be flipped fleet-wide mid-incident; the docs show
  that form as the default recipe. A hard-coded `() => false` is a composition change like any
  other.
- **Telemetry — span events, not framework events.** The layer records `compaction.complete` /
  `compaction.failed` / `compaction.timeout` via `ctx.trace.addEvent` with item counts in and
  out, tokens saved, the delivered-vs-cap ratio, latency, and error class — never `state` or
  item content. A `projectHistory` hook receives `ExecutionContext`, which exposes only
  `trace.*`; the broadcaster behind `emitFrameworkEvent` needs a full `Context` no layer hook
  has. And `trace.addEvent` forwards to `ctx.span.addEvent`, a no-op without a tracing backend —
  **compaction telemetry exists only when the host has configured one.** Framework-event parity
  for layer hooks would be an `ExecutionContext` change belonging to spec 11.

### Opt-in

`ProjectionPolicy.overflow` keeps its existing values and default. Composing this layer is an
explicit act; no existing agent silently acquires a network dependency.

---

## Decision-backed upgrades to existing surfaces

Each is additive and non-breaking.

### `decisionCondition()`, and a faster `aiCondition`

```typescript
decisionCondition({ client, prompt: 'Is this a refund request?', threshold: 0.5 })
```

Returns a `Condition<I>`, composable with `when`, `anyCondition`, `allCondition`. `aiCondition`
gains an optional `client`; when supplied it takes the decision path, retiring the silent
`return false` on parse failure — there is no parse step, and a transport failure throws.

### `decisionSwitch()`

A sibling to `semanticSwitch`, backed by `choice` instead of cosine similarity. It understands
per-case *criteria* and returns `confidence`, enabling escalation:

```typescript
decisionSwitch({
  client,
  cases: {
    refund: { criteria: 'wants money back', step: refundFlow },
    bug:    { criteria: 'reports broken behaviour', step: bugFlow },
  },
  minConfidence: 0.7,   // below this, fall through to `default`
  default: askAHuman,
})
```

`semanticSwitch` stays; it needs no inference provider and runs offline.

### `until.decided()`

```typescript
loop({ until: until.decided({ client, prompt: 'Has the user’s question been fully answered?' }) })
```

An `UntilPredicate` judging the snapshot's `lastText`. Composes with `any`/`all`, so it pairs
naturally with `maxSteps` as a safety bound.

### `decisionScorer()`

An eval scorer using `score` against an ordered rubric: the weighted-mean level becomes
`ScoreResult.score`, and the distribution and `confidence` go in `metadata`, so regression runs
can flag *judge* instability separately from *agent* regression.

---

## JSON workflow

`kind: 'decide'` joins the `WorkflowNode` union. The node names its client by key, resolved from
a `systemOneClients` registry on the hydration context — the same open-registry shape as
`acpAgents` — so a document can never name a base URL or carry a key.

### State in, string out

The JSON runtime is string-in, string-out, so the node needs no `state` field: its state is its
string input. Its output is `stringifyResult(DecideResult)`, the hydrator's existing convention
shared with `invokeTool` and `runCode`, which preserves every answer, `confidence`, and
`probabilities`.

Routing on it is a change to `conditional`, not `decide`. A route is today a bare substring
(`match: string`, `includes` on the lowercased input). It becomes a predicate union mirroring the
`UntilPredicate` kinds in the same file:

```typescript
{ kind: 'outputContains', value: string }          // today's behaviour; a bare string means this
{ kind: 'outputEquals',   value: string }
{ kind: 'field', path: string, equals: JsonValue } // path 'queue.choice', equals 'billing'
{ kind: 'field', path: string, gte: number }        // path 'queue.confidence', gte 0.7
```

`field` predicates parse the input as JSON and read a dotted path; non-JSON input or a missing
path is "no match". This gives JSON authors the confidence-gated escalation `decisionSwitch()`
offers in TypeScript, on any string-output node. Schema changes require `bun run gen:schema` in
the same commit.

### Stability for JSON consumers

A JSON author sees no JSDoc tag, so the `@unstable` promise travels in the artifact, derived from
one list and gated by a test:

```typescript
/** Node kinds whose shape is not settled, mapped to what would graduate them. */
export const UNSTABLE_WORKFLOW_NODES: Readonly<Record<string, string>> = {
  decide: 'the protocol has a stable vendor API or a second independent implementation ships',
};
```

A helper emits, for each listed kind, a `description` prefixed `UNSTABLE:` with the same
`Graduates when:` clause the JSDoc convention uses — the channel editors actually surface on
hover — and an `x-noetic-stability: "unstable"` annotation for tooling (Zod 4's `.meta()`
carries both through `toJSONSchema`). The schema drift-gate test asserts both published copies
carry them for every listed kind and for no other. Graduating a node deletes one map entry.

---

## Testing invariants

Beyond `.claude/rules/testing.md`:

1. Every error kind in the mapping table has a negative test asserting `e.noeticError.kind`.
2. Property test over generated transcripts: **no `function_call_output` survives without its
   `function_call`**.
3. **Kept items are byte-identical** to their inputs — the anti-summarization invariant.
4. Fail-open: a throwing client yields the input items unchanged.
5. A timed-out compaction **aborts its in-flight request**, asserted through the real
   `projectHistoryLayers` wrapper with slow-preprocessing and slow-client doubles: the client's
   `signal` fires *before* the lifecycle's `withTimeout` rejects.
6. The single-request cap: against limits that cannot hold every question, exactly one
   `evaluate` call, under `maxRequestTokens`, with overflow calls left unscored and unmodified.
7. The **contract-conformance test**: adapter satisfies `SystemOneClient`; each SDK error class
   maps to its kind; the worked example compiles in both directions. This is the drift gate.
8. Live-provider tests use `test.skipIf(!process.env.TYPESAFE_API_KEY)`; the unit tier runs
   against a fake client and is always on. Being skip-gated, the live tier is not the drift gate.
9. **Resume replays only on matching content**, through the real ledger: same `stepId`/`kind`
   with different resolved `state` re-calls the backend; identical content replays with zero
   calls and a `step_replayed` event.
10. **Pinning survives its edge cases**: no user message at all falls back to the item pin and
    still scores something; one exchange of 300 tool pairs pins at most `preserveRecentMessages`
    items; no pair with either side pinned is scored.

---

## Rejected alternatives

Recorded so the reasoning is auditable without being re-argued. The full record is in the
refinement ledger.

- **Vendor-named API** (`step.jev`, `JevClient`). Rejected for backend-agnostic naming; a second
  provider must not force a rename.
- **Hand-rolled HTTP transport.** The official SDK is zero-dependency, already ships the
  machinery, and reaches self-hosted endpoints via `baseURL`.
- **Re-exporting the SDK's question builders.** Provably fails to typecheck against the contract
  in both directions, and a re-export has no seam to absorb pre-1.0 churn.
- **Lazy `jev()` construction.** Would move a missing credential into a fail-open hook and make
  it a permanent silent no-op; the repo's factories fail eagerly.
- **Multi-batch compaction.** K batches re-send the state K times, worst exactly when the
  transcript is largest; the single-request cap degrades to the cheap path instead.
- **Compaction before `history()`, bounded to its prospective window.** Requires knowing
  `history()`'s private constants, coupling two layers the slot system keeps independent.
- **A default `keepThreshold`.** A midpoint arbitrates an asymmetric failure with an
  uncalibrated statistic; the harness is the precondition for any default.
- **Deriving a per-attempt SDK timeout from the signal.** Redundant: the signal already cancels
  request and retries at the deadline, and `AbortSignal` exposes no remaining-time property.
- **A `select` field on the JSON `decide` node.** A fourth string-collapse convention that
  discards every unselected answer and all `confidence`.
- **Withholding unstable nodes from the hosted JSON Schema.** The `/unstable`-subpath mistake in
  JSON form: documents fail validation, need a second `$schema`, then a rewrite at graduation.
- **Tool-call guardrails.** The `beforeToolCall` contract denies on timeout, so a fail-closed
  gate backed by a hosted model makes third-party latency a hard ceiling on tool execution.
  Revisiting needs a bounded staleness cache or allowlist bypass — its own spec.

---

## Future Considerations

- **OpenRouter provider.** A second adapter behind the same contract; no contract change
  anticipated.
- **Batching across a turn.** A turn-scoped collector deferring every `decide` and condition
  into one request would make decisions nearly free. Needs a scheduling primitive Noetic lacks.
- **Local-first backend.** A llama.cpp-class backend would remove the network dependency for
  offline agents, at the cost of a second transport that does not speak `/v1/systemone`.
- **Calibration harness.** An eval suite measuring a backend's calibration error on the user's
  own data. A precondition for a default `keepThreshold` and for graduating the compaction
  layer.
- **Cancellation reaching layer hooks.** `ExecutionContext` carries no abort signal, so a
  cancelled execution mid-compaction runs until the layer's own deadline. A gap in the hook
  contract; belongs in `11-context-layer-system`.
