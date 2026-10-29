# 37 — Verification

> **Depends On:** `35-connections`, `36-connection-profiles` (senses, summaries, determinism), `08-runtime` (ArtifactStore), `23a-step-level-resume`, `26-json-workflow-runtime`, `34-custom-items`
> **Exports:** `step.verify`; `verifier()`, `net`, `ui`, `log`, `route`, `state`, `signal`, `event` (`@noetic-tools/verify`); `Verifier` and the OVP document types (`@noetic-tools/types/verify`); the `verify` JSON node; the `noetic:verification_run` item

---

An agent changes something and says it works. `step.verify` checks that from
outside the thing making the claim: it says what should become true, performs
an action on a real connection, watches what the connection's senses report,
and answers **yes**, **no**, **unknown** (could not tell) or **no-fault**
(nothing to prove, nothing wrong) — with the evidence, and with what it could
not see.

```ts
import { step } from '@noetic-tools/core';
import { net, ui } from '@noetic-tools/verify';

const checkout = step.verify({
  id: 'checkout',
  subject: app,
  expect: [net('POST /api/orders 201').once(), ui('heading "Order confirmed"')],
  never:  [net('5xx')],
  act: [
    step.call({ id: 'pay', connection: app, op: 'ui.tap', args: { element: 'button "Pay"' } }),
  ],
});
```

Its output's `outcome` is `pass`, `fail`, `partial` or `unknown`; a workflow
branches on it like any value. `verify` never throws for a `no` or an
`unknown` — those are answers.

Verification implements the
[Open Verification Protocol](https://github.com/reticlehq/reticle/blob/main/open-verification/SPEC.md)
(OVP v1) through its package `open-verification`, pinned exactly. Noetic does
not reinvent its rules: OVP's own `adjudicate()` decides every verdict, and a
verification run is an OVP `VerificationRun` any OVP tool can read and check.

## Writing a verify

| Field | Meaning |
|---|---|
| `subject` | The connection being checked — or a list (`[ios, android]`), which runs one verify per connection in parallel, with ids `<id>.<name>` and the worst outcome. |
| `expect` | What must become true. Each entry is a sense and a matcher (spec 36 § Senses), optionally a count. |
| `never` | What must not happen at any point while the action runs. |
| `act` | The action: a step, or an array of steps run in sequence. Must contain at least one operation with effects, or a model call. With a list subject, `act` is a function of each subject's name — `(subject) => step.call({ connection: subject, … })` — so each verify acts on its own subject; a fixed `act` that names one of the subjects is `VERIFY_INVALID`. |
| `witnesses` | Connections that can confirm from outside the subject — a database, a payment API (§ Witnesses). |
| `close` | When to stop watching. Defaults to the subject profile's default: quiet for 500 ms, at most 15 s. |
| `intent` | A sentence saying why, kept in the run record. |

**Matchers:**

| TypeScript | JSON | Means |
|---|---|---|
| `net('POST /api/orders 201')` | `{ "net": "POST /api/orders 201" }` | At least one matching request. |
| `.once()` / `.count(n)` | `"count": 1` | Exactly that many. |
| `.atLeast(n)` / `.atMost(n)` | `"atLeast": n` / `"atMost": n` | Bounds. |
| `state('cart.total').equals(42, { tolerance: 0.5 })` | `{ "state": "cart.total", "equals": 42, "tolerance": 0.5 }` | A measured value (OVP `measure`). |
| `event('device.app.crashed')` | `{ "event": "device.app.crashed" }` | An event of that type. |

`ui`, `log`, `route`, `state`, `signal` and `x-` senses (`{ "x-orders-db":
"orders.count", "count": 1 }`) work the same way. A matcher for a sense the
subject or a witness cannot perceive fails validation with
`CONNECTION_UNSATISFIED`; a matcher the sense's grammar cannot parse fails
with `VERIFY_INVALID`.

### In JSON

```json
{ "kind": "verify", "id": "checkout", "subject": "app",
  "expect": [ { "net": "POST /api/orders 201", "count": 1 }, { "ui": "heading \"Order confirmed\"" } ],
  "never":  [ { "net": "5xx" } ],
  "act": [ { "ui.tap": { "element": "button \"Pay\"" } } ] }
```

Steps in `act` run on the subject unless they name another connection.

### The full OVP form

`expect` and `never` lower to OVP documents: each `expect` entry becomes a
claim with one assertion (its sense as the channel, its matcher as the
predicate, a generated statement), and each `never` entry a blocking
constraint. A verify may give `claims` and `constraints` as OVP documents
directly instead — for multi-assertion claims or prose a team wants to keep —
and both forms validate to the same shape. The OVP types live at
`@noetic-tools/types/verify`, apart from Noetic's own `Verdict` (spec 05).

## How it runs

The order is what makes the answer honest:

1. **Declare.** The claims are recorded before anything happens, so they
   count as declared before the action (OVP-INTENT-3). A claim about an action
   that already ran cannot reach `yes`.
2. **Check before.** Each claim is evaluated once against the subject as it is
   now. If it already holds, a `yes` afterwards would prove nothing, so the
   verdict is `unknown` (OVP clause 10).
3. **Listen.** The verify starts listening on the senses its claims need and
   waits until the server confirms.
4. **Act.** `act` runs through the usual gates.
5. **Close.** Listening stops by `close` (§ Windows).
6. **Judge.** Each claim is judged by OVP's `adjudicate()` against only the
   evidence, gaps and anomalies on its own senses (§ Judging).
7. **Record.** The run document is stored as a blob, attached to the trace,
   and emitted as a `noetic:verification_run` item.

```ts
interface VerifyOutput {
  outcome: 'pass' | 'fail' | 'partial' | 'unknown';
  verdicts: Array<{ claim: string; verdict: 'yes' | 'no' | 'unknown' | 'no-fault'; ground: string; reasons: string[] }>;
  violations: ConstraintViolation[];
  gaps: BlindSpot[];
  repairs: Repair[];
  run: BlobRef;
}
```

`outcome` is OVP's `outcomeOf(run)`: a `never` that was broken makes it `fail`
whatever the claims say (OVP-INTENT-8), and anyone recomputing it gets the
same answer (OVP-VERDICT-4). If `act` throws, the run is still recorded and
the step fails with `verify_act_failed`.

## Windows

A window is the stretch of time a verdict is about. It closes by the first of:

| `close.until` | Closes when | OVP close condition |
|---|---|---|
| `'quiet'` | The subject's `ui.settle` reports quiet | `quiescence` |
| `'event'` | A named event arrives (`close.event`) | `signal` |
| `'done'` | Every long operation `act` started has finished | `ack` |
| `'exit'` | The process `act` started exits on its own | `exit` |
| — | The process was ended from outside | `terminated` |
| — | `close.timeoutMs` passes first | `budget-exhausted` |

`budget-exhausted` and `terminated` are never clean, so neither can support
`yes` or `no-fault` (OVP-REALITY-5, -7). A settle that cannot measure quiet —
a hidden tab — closes cleanly after `quietMs` with no events and records a
gap on `time`, rather than failing as a timeout (OVP-REALITY-6). If the
subject is replaced mid-window, the window ends and its evidence is marked as
belonging to a world that is gone.

## Judging

Each claim gets its own OVP `AdjudicationInput`:

- **evidence** — observations on the claim's senses only, from the subject
  and witnesses;
- **coverage** — gaps on those senses, plus any the server flags as affecting
  everything;
- **anomalies** — those between the claim's senses;
- **assertions** — the claim's matchers, three-valued: a matcher that cannot
  be evaluated is `undefined`, never `false` (OVP-INTENT-5);
- **before** — from step 2.

So a claim about the screen is never proved by an unrelated request, and a
problem on `log` never decides a claim about `ui`. `never` entries are checked
against every event as it arrives; the first that breaks one records a
violation at that moment. A `never` on a sense the subject can only read, not
listen to, adds a gap instead of passing silently (OVP-INTENT-7).

### Gaps

A gap (OVP blind spot) is something the verify could not see. Gaps on a sense a
claim needs keep it from `yes`. They come from the server's
`noetic://coverage` (spec 36) and from the harness itself:

| What happened | Gap |
|---|---|
| A listener overflowed or the server skipped events | `buffer-truncated` |
| The subject or a witness dropped, or its event stream ended | `channel-unobserved` |
| A sense is declared but nothing on this server reports it | `channel-unobserved` |
| A long operation was still running at close | `still-in-flight` |
| A secret or sensitive value was withheld | `redacted` |
| A settle could not measure quiet | `channel-unobserved` on `time`, not affecting other claims |
| `act` changed a connection the verify is not watching | `effect-elsewhere` |
| A needed blob was dropped by artifact retention | `buffer-truncated` |

### Anomalies

Anomalies — two senses that cannot both be right — come from the server's
`noetic.detect` (spec 36), from OVP's `witnessDisagreement` when a witness
cannot confirm what the subject claims, and from the harness when evidence
belongs to a replaced subject or predates its latest edit. The harness detects
nothing else; knowing what a request or a render means is the server's job. A
disagreement decides a claim only when one of its senses is independent
(OVP-CHAN-2), which `adjudicate()` checks. `witnessDisagreement` compares
senses within one claim, so corroboration needs a claim that reads both the
subject and a witness: the full OVP form, one claim with an assertion on each.
Each `expect` entry is its own one-sense claim, judged on its own.

## Witnesses

A witness is a connection that can look and cannot touch: a database, a
payment provider's API. Listed in `witnesses`, it may run only its profile's
operations without effects; everything else on it is refused. Its senses are
`x-` senses (`x-orders-db`) declared with their true independence and grade,
since OVP's `state` and `storage` cannot be declared independent
(OVP-CHAN-1). Each witness closes by its own condition — by default, two reads
in a row that agree — so replication lag is not mistaken for a missing write.
A witness that could not look adds a gap; it is never evidence that something
did not happen.

## Resume

A verify that stopped before judging reopens its window on resume only if the
subject and witnesses kept their identity and every needed event stream can be
resumed; otherwise it starts again from Declare under the subject's resume
rule (spec 35 § Durability). The interrupted attempt stays in the run record.

## Under the hood

`@noetic-tools/types/verify` defines the `Verifier` contract and the OVP
document types, field for field as `open-verification` defines them, without
importing it; a test in `@noetic-tools/verify` checks the two agree.
`@noetic-tools/verify` implements the contract with `open-verification`, and
the harness registers it once:

```ts
new AgentHarness({ verification: verifier(), /* … */ });
```

Core owns the `verify` step and node and gives the verifier what it needs —
running `act`, listening, reading, evaluating expressions — without importing
`@noetic-tools/verify` or `open-verification`. The OVP `Claim` and
`Constraint` shapes a `verify` node carries are Zod mirrors in
`@noetic-tools/types/verify`, kept equal to OVP's own schemas by a test in
`@noetic-tools/verify`; `bun run gen:schema` inlines them into the workflow
schema, so the published schema never points at another host. Senses are translated to OVP
channel ids at this boundary.

| OVP | Noetic |
|---|---|
| Subject | The subject connection's identity |
| Channel and descriptor | Sense, as the server declares it |
| Capability, receipt | Operation, receipt |
| Locate | Locators and `ui.find`, which never choose |
| Window | § Windows |
| Blind spot | Gap |
| Witness | Witness |
| Determinism, resume strategy | The connection's determinism (spec 35 § Durability) |

## Errors

| Code / kind | When |
|---|---|
| `VERIFY_NOT_CONFIGURED` | The harness has no verifier. |
| `VERIFY_INVALID` | `act` contains nothing that acts, a matcher cannot be parsed, or a witness is asked to act. |
| `verify_act_failed` | `act` threw; the run is recorded with the failure as evidence. |

## Future Considerations

- Mutation runs (OVP §10.2): break the feature on purpose and check the verify
  notices.
- Revising a verdict when late evidence lands (OVP-VERDICT-5).
- Running OVP's conformance suite against a Noetic harness.
- A `noetic verify` command and HTTP endpoint for CI.
- Exporting a workflow as an OVP `Flow`.
