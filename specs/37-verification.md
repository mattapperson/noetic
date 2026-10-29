# 37 — Verification

> **Depends On:** `35-connections` (connections, receipts, subscriptions, identity, blobs), `36-connection-profiles` (channels, determinism, coverage, fixtures), `08-runtime` (AgentHarness, ArtifactStore), `23a-step-level-resume` (ledger), `26-json-workflow-runtime` (WorkflowDocument), `33-expressions` (Expression), `34-custom-items` (custom items)
> **Exports:** `Verifier`, `VerifierContext`, `VerifyStepConfig`, `VerifyOutput`, `step.verify`, `claim()`, `constraint()`, `witness()`, `verifier()` (`@noetic-tools/verify`); the `verify` JSON node; the `noetic:verification_run` custom item

---

An agent changes something and says it works. **Verification** checks that
claim from outside the thing making it: it declares what should become true,
performs an action against a real surface, watches what the surface's channels
report within a bounded window, records what it could not see, and returns a
verdict that can say "I could not tell" as plainly as "yes" or "no".

Noetic does not invent this model. It implements the
[Open Verification Protocol](https://github.com/reticlehq/reticle/blob/main/open-verification/SPEC.md)
(OVP v1) using its published package `open-verification` for the vocabulary,
the schemas and the normative adjudication function. Connections (spec 35) are
OVP realms and witnesses; profiles (spec 36) declare OVP channels, coverage,
anomaly detection and determinism; this spec connects them and makes
verification a first-class workflow step. A product like Reticle — a proof
layer that drives web and desktop apps and reports evidence-backed verdicts —
is a workflow over connections and `step.verify`.

## Why OVP

- **It already solves the hard parts.** Channel independence and grade,
  verdicts that can be `unknown`, coverage and blind spots, window close
  conditions, claims declared before the action, and a normative adjudication
  order with published test vectors.
- **It is realm-blind.** Capabilities are declared in domain language and
  refused when undeclared, which matches connections serving browsers, devices,
  chat workspaces and services through one contract.
- **Interoperability.** A verification run Noetic produces is an OVP
  `VerificationRun` any OVP consumer can read and recompute.

`open-verification` is pinned exactly. This spec cites OVP requirements by
identifier (`OVP-CHAN-2`) so the two can be checked against each other. Where
Noetic deliberately differs from OVP, the difference is named in
§ Deviations; there are no silent ones.

## Packages and contract

`@noetic-tools/types` defines the `Verifier` contract and structural types for
the OVP documents a workflow writes and reads — `Claim`, `Assertion`,
`Predicate`, `Constraint`, `Verdict`, `BlindSpot`, `ConstraintViolation`,
`Repair`, `VerificationRun` — field for field as `open-verification` defines
them, with no import of it. `@noetic-tools/verify` depends on
`@noetic-tools/types` and `open-verification`, implements the contract, and
carries a drift-gate test asserting the structural types and OVP's inferred
types are mutually assignable. `bun run gen:schema` inlines OVP's JSON Schemas
from the `open-verification` package (a development dependency of the schema
script, not of any package's source) into the published workflow schema, and
the existing drift gate covers them, so the workflow schema never `$ref`s an
external host.

```ts
interface Verifier {
  verify(config: VerifyStepConfig, ctx: VerifierContext): Promise<VerifyOutput>;
}

interface VerifierContext {
  /** Runs the step's `act` under the gate chain; returns its output and every receipt it produced. */
  runAct(): Promise<{ output: unknown; receipts: ReadonlyArray<ConnectionReceiptRecord> }>;
  /** Opens a step-scoped subscription on a slot (35 § Step-scoped subscriptions). */
  subscribe(slot: string, req: { type: string; arguments?: Record<string, unknown> }): Promise<StepSubscription>;
  /** Reads a resource or calls a read-only operation on a slot or witness. */
  read(slot: string, request: { resource: string } | { op: string; args: unknown }): Promise<unknown>;
  /** Evaluates an `expr` assertion with core's expression engine and limits (spec 33). */
  evaluateExpression(expr: Expression, input: unknown): Promise<unknown>;
  /** Identity, channels, coverage and determinism of a bound slot or witness. */
  describe(slot: string): ConnectionDescription;
  artifacts: ArtifactStore;
  signal: AbortSignal;
}
```

The harness registers a verifier:

```ts
import { verifier } from '@noetic-tools/verify';
const harness = new AgentHarness({ verification: verifier(), /* … */ });
```

`@noetic-tools/core` owns the `verify` step variant and JSON node, builds the
`VerifierContext`, and dispatches to the registered verifier, as it dispatches
ACP steps to a registered agent. Core never imports `@noetic-tools/verify` or
`open-verification`. A `verify` step on a harness with no verifier fails with
`VERIFIER_NOT_CONFIGURED` before the run starts.

## The mapping

| OVP | Noetic |
|---|---|
| Subject (`surface`, `instance`, `epoch`) | The identity of the `verify` step's **one** subject slot (`35-connections` § The contract). |
| Channel descriptor (independence, grade) | The slot's declared channels (spec 36 § Channels). The harness never upgrades a declaration. |
| Capability | A declared operation; undeclared ones are refused by the gate chain. |
| Action and receipt | An `effects` operation and its `receipt`. |
| Locate | `ui.find`, which returns every candidate and never chooses (`ambiguous`). |
| Window and close condition | § Windows. |
| Observation | An event, a resource read, or a read-only operation output, on its declared channel. |
| Coverage, blind spots | The server's `noetic://coverage` (spec 36 § Coverage) plus the harness's own gaps (§ Coverage). |
| Detect, anomalies | The server's `noetic.detect` (spec 36 § Anomaly detection), OVP's `witnessDisagreement`, and the harness's identity anomalies. |
| Witness | A connection bound read-only (§ Witnesses). |
| Determinism, resume strategy | The slot's declared determinism (`35-connections` § Durability). |
| Verification run | The `verify` step's output and the `noetic:verification_run` artifact. |

## `step.verify`

```ts
import { step } from '@noetic-tools/core';
import { claim, constraint, witness } from '@noetic-tools/verify';

const checkout = step.verify({
  intent: 'Paying completes the order once',
  subject: app,                         // exactly one connection slot
  witnesses: [witness(ordersDb)],
  claims: [
    claim('one-order', 'one order request succeeds', [
      { id: 'post-201', reads: 'exactly one POST /api/orders answered 201', channels: ['net'],
        predicate: { kind: 'count', match: { channel: 'net', summary: 'POST /api/orders 201' }, op: 'exactly', value: 1 } },
    ]),
    claim('confirmed', 'the confirmation is shown', [
      { id: 'heading', reads: 'heading "Order confirmed" is present', channels: ['ui'],
        predicate: { kind: 'present', match: { channel: 'ui', summary: 'heading "Order confirmed"' } } },
    ]),
  ],
  constraints: [
    constraint('no-5xx', 'no request fails with a server error', ['net'],
      { kind: 'absent', match: { channel: 'net', summary: 'response 5xx' } }),
  ],
  act: step.sequence([findPay, tapPay]),
  close: { until: 'quiet', quietMs: 500, timeout: 15e3 },
});
```

`claim(id, statement, assertions)` and `constraint(id, statement, channels,
predicate, severity?)` build OVP `Claim` and `Constraint` documents exactly;
`declaredAt` is set by the step, never by the author. Predicates are OVP's
`count`, `present`, `absent` and `measure`, with the channel inside `match` and
`valueContains` only beside a `summary` (OVP-INTENT-6). An assertion may
instead carry `{ expr }` — an expression over the window's observations,
evaluated through `VerifierContext.evaluateExpression`. To OVP it is an
implementation predicate; the assertion still names its `channels`.

The step runs in a fixed order:

1. **Declare.** Claims and constraints are recorded with
   `declaredAt: 'before-action'` in a pre-dispatch ledger entry before anything
   is performed (OVP-INTENT-3). A claim made later about an earlier action is
   `after-action` and cannot reach `yes` (clause 8).
2. **Typecheck.** Every assertion's `channels` and every constraint's
   `channels` must be declared by the subject or a witness; every operation
   `act` will perform statically must be declared by the subject. A claim that
   fails gets `unknown` on ground `channel-not-observed` and is excluded from
   the run (OVP-CHAN-4); an undeclared operation fails the step before acting
   with `VERIFY_UNDECLARED_CAPABILITY`, the separate typecheck failure OVP names
   `undeclared-capability` (OVP §11a.1). Operations chosen at run time by a
   model inside `act` are refused at dispatch by the gate chain instead.
3. **Before.** Each assertion with a `present`, `absent`, `count` or `measure`
   predicate is evaluated once against an immediate read of its channels, to
   supply `consequenceHeldBefore` (clause 10). Channels that cannot be read
   on demand leave it `undefined`. `checkBefore: false` skips this per claim.
4. **Open the window.** Step-scoped subscriptions open on the subject's and
   each witness's event types for the claims' channels and wait for `ready`.
5. **Act.** `act` runs through `VerifierContext.runAct` under the gate chain.
   If it produced no receipt, every claim is treated as `after-action`: nothing
   was done, so nothing can be proved about doing it.
6. **Close.** The subject's window closes by `close` (§ Windows); each witness
   closes by its own condition.
7. **Collect.** Observations, coverage and anomalies are assembled and
   **scoped per claim** (§ Adjudication).
8. **Adjudicate.** OVP's `adjudicate()` decides each claim; constraints are
   evaluated over the whole window (§ Constraints). The verifier never
   re-implements the order and never overrides a ground.
9. **Record.** The `VerificationRun` is written to the artifact store,
   attached to the run's trace, and emitted as a `noetic:verification_run`
   custom item (`34-custom-items`).

```ts
interface VerifyOutput {
  outcome: 'pass' | 'fail' | 'partial' | 'unknown';   // OVP outcomeOf(run)
  verdicts: Array<{ claim: string; verdict: 'yes' | 'no' | 'unknown' | 'no-fault'; ground: string; reasons: string[] }>;
  violations: ConstraintViolation[];
  coverage: Coverage[];
  repairs: Repair[];
  run: BlobReference;        // the full OVP VerificationRun document
  cost: { tokens?: number; durationMs: number; operations: number };
}
```

`outcome` is OVP's `outcomeOf(run)`, so a blocking violation makes it `fail`
ahead of every verdict (OVP-INTENT-8) and any consumer recomputing it gets the
same answer (OVP-VERDICT-4). `verify` never throws for a `no` or an `unknown`:
those are answers. It fails only for configuration errors or when `act` itself
throws (`verification_act_failed`), and then the run is still recorded with the
failure as evidence. A workflow branches on `outcome` with `conditional` or
`routeSwitch`.

## Windows

A window is the bounded stretch of time a verdict is about (OVP §5). The
subject's window opens when its subscriptions are ready and closes by the first
of:

| `close.until` | Closes when | OVP close condition |
|---|---|---|
| `quiet` | `ui.settle` returns `closedBy: 'quiescence'` on the subject | `quiescence` |
| `signal` | A named event arrives (`close.signal`) | `signal` |
| `ack` | Every task `act` started completes | `ack` |
| `exit` | The process `act` started exits by its own choice | `exit` |
| — | The subject's process was ended from outside | `terminated` |
| — | `close.timeout` passes first | `budget-exhausted` |

- `ui.settle`'s own `closedBy` values are OVP close conditions (spec 36), so
  the mapping is the identity.
- `budget-exhausted` and `terminated` are never clean closes; neither can
  support `yes` or `no-fault` (OVP-REALITY-5, -7).
- **Unmeasurable settles.** When `ui.settle` returns `unmeasurable: true` —
  a hidden tab never flushes the frame quiescence is read from — the window
  closes **cleanly** with the condition that could not be measured
  (`quiescence`) once `close.quietMs` passes with no event on the subject's
  observed channels, and a non-impeaching blind spot on `time` is recorded. It
  never closes as `budget-exhausted` for this reason (OVP-REALITY-6).
- An instance whose identity changes mid-window ends the window; observations
  before the change carry the old identity, and adjudication sees
  `evidence-superseded` or `evidence-predates-edit` (§ Anomalies).

## Adjudication

Each claim is adjudicated with its own `AdjudicationInput`, scoped to what it
reads:

- **`channels`**: the run's channel descriptors.
- **`evidence`**: observations on the claim's assertions' channels only, from
  the subject and witnesses.
- **`coverage`**: the window's coverage, with blind spots on other channels
  removed unless flagged impeaching by the server.
- **`anomalies`**: those whose `between` intersects the claim's channels.
- **`assertionsHeld`**: the three-valued result of its assertions
  (OVP-INTENT-5).
- **`consequenceHeldBefore`**: from step 3, or `undefined`.

A claim reading only `ui` is therefore never proved by unrelated `net`
evidence, and an anomaly on `log` never decides a claim about `ui`.

### Constraints

A constraint must hold throughout the window, not only at its end
(OVP-INTENT-7). The verifier evaluates its predicate against every event on its
channels as it arrives; the first event that breaks it records a
`ConstraintViolation` at that event's time. A constraint over a channel the
subject can observe only by reading resources — with no events to watch
continuously — adds an impeaching blind spot on that channel rather than
reporting that the constraint held.

## Coverage

Blind spots come from two places, each on the channel it falls on, and
relevance is decided by the adjudicator (OVP-EVID-1):

- **The server.** `noetic://coverage` (spec 36 § Coverage) reports the realm's
  blind spots for the window, passed through unchanged.
- **The harness.** What the harness can see about its own observation:

| Harness condition | Blind spot |
|---|---|
| A step-scoped subscription overflowed or received a truncated batch | `buffer-truncated` |
| An event type the claim needs has replay `none` and its subscription restarted mid-window | `buffer-truncated` |
| The subject or a witness became unavailable, or a subscription was terminated | `channel-unobserved` |
| A declared channel has no event or readable part on this instance | `channel-unobserved` |
| A task `act` started was still running when the window closed | `still-in-flight` |
| A sensitive field, a redacted body or a scrubbed secret was withheld | `redacted` |
| A settle could not measure its condition | `channel-unobserved` on `time`, non-impeaching |
| `act` reached a connection that is neither subject nor witness | `effect-elsewhere` |
| A blob needed as evidence was dropped by artifact retention | `buffer-truncated` |

`Coverage.observed` lists only the channels the window actually watched. A
channel whose blind spots cannot be enumerated is left out of `observed` rather
than reported with an empty list (OVP-EVID-2).

## Anomalies

- **From the server.** A server implementing `noetic.detect` (spec 36 §
  Anomaly detection) reports anomalies with their kind, tier and the two
  channels between which they fall, setting the tier honestly
  (OVP-REALITY-3). They decide nothing alone: a disagreement convicts only when
  one of its channels is independent, which `adjudicate()` checks
  (OVP-CHAN-2).
- **From witnesses.** OVP's `witnessDisagreement(actor, witness)` turns the
  subject's claim and a witness's silence into a `claim-uncorroborated`
  anomaly (OVP §10.1).
- **From identity.** The harness reports `evidence-superseded` when every
  observation belongs to a replaced instance, and `evidence-predates-edit` when
  every observation predates the subject's current epoch (OVP-SUBJ-2).

The harness detects nothing else itself. Detecting `no-effect`,
`duplicated-effect` or the others needs to know what a request or a render is,
which is the realm's knowledge, not the harness's.

## Witnesses

A witness is a connection that can look and cannot touch (OVP §10.1): a
database, a payment provider's API, a log store.

- **Binding.** `witness(slot)` binds a slot read-only. Its operations are
  deny-by-default: only operations its profile declares without `effects` are
  callable, through the gate chain; every other tool on its server is refused,
  so a witness cannot act (OVP CONFORMANCE §2).
- **Its own subject and channels.** A witness is recorded in the run with its
  own identity and channel descriptors. Its channels must not collide with the
  subject's: a witness observing a database declares an `x-` channel
  (`x-orders-db`) with its true independence and grade, because OVP's
  `state` and `storage` are actuation-derived and cannot be declared more
  trustworthy (OVP-CHAN-1).
- **Its own window.** Each witness closes by its own condition — `close` on the
  `witness()` binding, by default polling its read until two consecutive reads
  agree or its timeout passes — so replication lag is not mistaken for a
  missing write. A witness that times out contributes a blind spot.
- A witness that could not look contributes nothing but a blind spot; an
  unreachable witness is never evidence that the write did not happen.

## Resume

A `verify` step is resumable like any step. If the process stops before
adjudication, resume reopens the window only when the subject and every witness
kept their identity and every needed event type has `durable` or `session`
replay; otherwise the step runs again from Declare under the subject's resume
strategy (`35-connections` § Durability). The interrupted attempt is kept in
the run's record beside the new one, never edited.

## Fixtures and flows

- **Fixtures.** A slot may name a fixture applied after provisioning or reset
  (spec 36 § Fixtures), so a suite does not prove the login fifty times. A
  fixture is reused across leases, which OVP's `fixtureIsUsable` does not allow
  (§ Deviations).
- **Flows.** A workflow of `connectionCall`s and `verify`s can be exported to
  an OVP `Flow` with `exportFlow(document, { name, version })`: each
  `connectionCall` with effects becomes an `Action`, each `subflow` an
  `Invoke`, and the `verify` claims become `expects`. `mayRebind` is `false`.
  A document that uses model-chosen actions (`callModel` inside `act`) cannot
  be exported and says so.

## JSON workflows

```json
{
  "kind": "verify", "id": "checkout",
  "intent": "Paying completes the order once",
  "subject": "app", "witnesses": ["ordersDb"],
  "claims": [
    { "id": "one-order", "statement": "one order request succeeds",
      "assertions": [
        { "id": "post-201", "reads": "exactly one POST /api/orders answered 201", "channels": ["net"],
          "predicate": { "kind": "count", "match": { "channel": "net", "summary": "POST /api/orders 201" }, "op": "exactly", "value": 1 } } ] }
  ],
  "constraints": [
    { "id": "no-5xx", "statement": "no request fails with a server error", "channels": ["net"], "severity": "blocking",
      "predicate": { "kind": "absent", "match": { "channel": "net", "summary": "response 5xx" } } }
  ],
  "act": { "kind": "sequence", "id": "pay", "steps": [] },
  "close": { "until": "quiet", "quietMs": 500, "timeout": 15000 }
}
```

Claims, assertions, predicates and constraints are OVP's documents; the
workflow schema inlines OVP's JSON Schemas for them (§ Packages and contract),
without `declaredAt`, which the step sets. A witness slot is declared in the
manifest with `"witness": true`. Document validation warns, rather than fails,
when a claim's channels are not among the subject's or a witness's
`observes`, since such a claim adjudicates to `unknown` rather than erroring.

## Deviations from OVP

| Where | OVP | Noetic | Why |
|---|---|---|---|
| Fixtures | `fixtureIsUsable` requires the same `surface`, `instance` and `epoch`. | A fixture is usable on any instance with the same `surface` and `epoch`. | Leases are fresh instances by design (OVP-SUBJ-1), so OVP's rule would make fixtures unusable for pooled verification. Epoch matching keeps OVP's protection against state from rewritten code. |

## Errors

| Code / kind | When |
|---|---|
| `VERIFIER_NOT_CONFIGURED` (config) | A `verify` step or node runs on a harness with no registered verifier. |
| `VERIFY_UNDECLARED_CAPABILITY` (config) | `act` statically performs an operation the subject does not declare. |
| `VERIFY_MULTIPLE_SUBJECTS` (config) | A `verify` names more than one subject slot. |
| `verification_act_failed` (kind) | `act` threw; the run is recorded with the failure as evidence. |

## Future Considerations

- Mutation runs (OVP §10.2): a `mutate` operation in the profiles and a
  `step.mutationRun` that grades whether a flow notices a broken feature.
- Revising a verdict when late evidence lands after its window closed
  (OVP-VERDICT-5).
- Running OVP's own conformance suite against a Noetic harness acting as an
  OVP implementation.
- A `noetic verify` CLI and an HTTP endpoint that run a saved flow against a
  provisioned lease, for CI and editor integrations.
