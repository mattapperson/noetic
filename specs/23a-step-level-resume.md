# Step-Level Resume

> **Status:** IMPLEMENTED. Two things landed differently from the original design — see "Divergences from the original design" at the end.
> **Depends On:** `23-durable-execution` (CheckpointSnapshot, CheckpointStore, restore flow), `01-step-type` (Step), `03-control-flow` (inParallel/conditional), `05-loop-and-until` (loop, schedule), `07-context-and-event-log` (Context, ItemLog)
> **Exports:** `StepLedgerEntry`, `StepLedgerEntrySchema`, `StepLedger`, `StepLedgerStore`, `StepLedgerWindow`, `createStepLedgerStore`, `StepLedgerRetention`, `StepLedgerStats`, `DEFAULT_STEP_LEDGER_RETENTION`, `resolveStepLedgerRetention`
> **Source of truth:** `packages/core/src/runtime/durable/step-ledger.ts`, `packages/core/src/interpreter/execute.ts`, `packages/core/src/runtime/context-impl.ts`, `packages/core/src/runtime/durable/harness-checkpoints.ts`

---

## Problem

`23-durable-execution` delivers context reconstruction: `harness.restore(executionId)` rebuilds an execution's item log, layer state, cwd, and identity. It deliberately stops there — "the caller resumes execution from whatever the frontier requires … for an interactive agent, this is typically re-issuing the most recent user turn."

Re-issuing the turn is acceptable when a turn is one LLM call. It is not acceptable when a turn fans out to N workers that each do externally-visible work. A host with at-least-once turn delivery (the Noetic platform's session DO is one) re-runs the whole turn after a crash, and every worker that already finished runs a second time.

The gap is that a restored context knows *what happened* but not *how far it got*.

## Prerequisite: the checkpoint firing boundaries do not exist

`23-durable-execution` § "Checkpoint lifecycle → Firing boundaries" states that `harness.checkpoint(ctx)` fires automatically at four points (post-`execute()`, post-`detachedSpawn()`, ask-user enqueue, post-`runAppendPipeline`).

None of them are wired. In the current implementation:

- `ContextImpl` accepts an optional `checkpointFn` (`runtime/context-impl.ts:105`) and `ctx.checkpoint()` calls it (`:206`), but **no construction site supplies it** — not `agent-harness.ts:696` (`createContext`), not `execute-action.ts:816` (spawn child), not `execute-control.ts:63` (inParallel child). `ctx.checkpoint()` is therefore a permanent no-op.
- No module in `packages/core/src` calls `harness.checkpoint(ctx)`. The only definition is the method itself (`agent-harness.ts:925`).

So today a snapshot exists only if the host calls `harness.checkpoint(ctx)` by hand. **Wiring the four boundaries is prerequisite work for everything below**, and is worth landing on its own — it makes `23`'s existing promises true regardless of whether this spec proceeds.

## Why the frontier is not sufficient

`captureCheckpoint` serialises the frontier (`harness-checkpoints.ts:51`); `restoreFromCheckpoint` never reads it back. Restoring it would not be enough anyway, for two reasons.

**The frontier records what is in flight, not what finished.** `execute()` pushes a frame before dispatch (`execute.ts:240`) and pops it in a `finally` (`:302`). A completed step leaves no trace. For an `inParallel` of 8 workers where 5 finished and 3 were mid-flight at snapshot time, the frontier holds the `inParallel` plus the 3 — the 5 completed ones are invisible.

**Skipping is not enough; the output is load-bearing.** Steps consume the previous step's output. A `callModel` step is non-deterministic, so re-running it to "catch up" produces a different value than the one the rest of the run already observed. Resume therefore has to *replay recorded outputs*, not skip work. It is memoization, not fast-forward.

## Design

### The ledger

One entry per successfully completed step, carried in the snapshot.

```typescript
interface StepLedgerEntry {
  path: string;          // execution path key — see below
  stepId: string;
  kind: Step['kind'];
  output: unknown;       // replayed verbatim on resume
  completedAt: string;   // ISO-8601
}
```

Failures are **not** recorded: a step that threw re-runs. Retry policies and `onError` handling stay exactly as they are today.

### Identity: the execution path key

`stepId` alone cannot key the ledger. A loop re-executes its body steps under the same ids on every iteration (`execute-control.ts:640` — `for (const bodyStep of step.steps)` inside `while (true)`), and `schedule` does the same on a timer. Keying by `stepId` would let iteration 1's output replay into iteration 2.

Dynamic `inParallel` fan-outs are already safe by accident: `buildPerItemStep` suffixes both the wrapper id and the template's node ids with the item index (`workflow-hydrator.ts:688`, `:691`), so `fan-item-0` and `fan-item-1` are distinct. Static `inParallel` steps and loops have no such disambiguation.

The key is the frontier stack plus a per-parent occurrence ordinal:

```
root/plan#0/review-loop#0/body-llm#2
```

`#n` is the n-th time that `stepId` has been dispatched under that parent frame. Derivation is nearly free — `execute()` already maintains the stack; the addition is an occurrence counter per `(parent frame, child stepId)` pair, incremented at `enterStep`.

**Determinism requirement.** The key must be identical on replay given identical control flow. Sequential constructs satisfy this trivially. Concurrent `inParallel` paths do **not** if the ordinal is assigned on completion — completion order varies run to run. Assign the ordinal from the `paths` array index at dispatch (`execute-control.ts:221`), never from settle order.

### Recording

Append on successful return, at the point `step_completed` is emitted (`execute.ts:306`) — *not* in the `finally` that pops the frontier, which also runs on failure.

### Replay

On `restore`, the ledger is loaded into the context. In `execute()`, before dispatch:

1. Compute the path key.
2. If an entry exists at that key **and** its `stepId` and `kind` match the step about to run, return `entry.output` without dispatching.
3. If an entry exists but diverges (different `stepId` or `kind` at that path), discard it and every entry whose path has it as a prefix, then run fresh.

Divergence handling mirrors the platform's tool fence, which found the same problem one layer up: `turn-tool-fencing.ts` matches a recorded call on name **and** args hash and re-executes on any mismatch, because a model that rewrote the call invalidated the prior attempt's record.

Replayed steps should emit a distinct `step_replayed` framework event rather than a synthetic `step_started`/`step_completed` pair, so traces and any attached UI can tell a resumed run from a fresh one instead of showing work that never happened.

### What must not be memoized

- **`schedule`** — a wall-clock scheduled step; replaying its output would collapse a schedule into a value.
- **Steps whose value *is* the effect**, where the effect is not durable.
- An explicit opt-out (`step.durable === false`) for authors who know their step must always run. No such field exists on `Step` today; it would be additive.

## The side-effect boundary

Memoizing an output replays a step's **value**, not its **effect**. A `runCode` step that wrote a file, or an `invokeTool` step that opened a PR, returns its recorded output on replay while the effect is not redone. That is correct only if the effect was durable at the moment it happened.

This is the same bet the Noetic platform's turn fence already makes, and the reason that fence sits at the **tool** boundary: tools are where effects live. That fence records a durable `tool.call_started` row *before* dispatch, so a crash mid-call is recoverable as a loud unknown-outcome rather than a silent re-run.

**Recommendation: core's ledger covers control flow and `callModel` steps; effects stay fenced at the tool/host boundary.** Core should not claim exactly-once for tool execution — it has no durable pre-dispatch record and no way to know whether a given tool is idempotent. Stating this explicitly matters, because "durable execution" invites the assumption that side effects are covered.

## Interaction with context layers

Layer state is already snapshotted (`layers`, keyed by `layerId`) and replayed into `layerStateStore` on restore. A replayed `callModel` step must therefore **bypass the layer lifecycle entirely** — no recall, no store, no append pipeline. Re-running `store` hooks against restored state would double-fold every observation the pre-crash run already folded.

The ledger and the layer snapshot must be captured atomically or they drift: a ledger newer than the layer state would replay steps whose folds are missing. Both live in one `CheckpointSnapshot` written through a single `StorageAdapter.set()`, so a single-key snapshot preserves this for free. **Sharding the ledger (below) breaks that atomicity** and needs an explicit ordering rule — write the ledger shard first, the snapshot second, and treat ledger entries beyond the snapshot's high-water mark as untrusted.

## Schema and migration

**No schema bump was needed.** Sharding the ledger under its own keys (below) kept it out of `CheckpointSnapshot` entirely, so `CheckpointSchemaVersion` stays `1` and a pre-ledger snapshot restores exactly as before — it simply recovers an empty ledger and resumes nothing. That is strictly better than the v1→v2 migration this section originally proposed.

## Size and retention

This is the part most likely to bite. Snapshots are keyed by `executionId` under a single key and **overwritten in full** on every capture (`23` § Idempotency). Adding step outputs makes each write proportional to the run so far: a 200-step run averaging 4 KB of output per step writes ~800 KB on its final capture, and rewrites the growing blob on every step — O(n²) bytes over the run.

**Per-append cost is resolved by sharding.** Entries live one key per step under
`execution:<id>:ledger:<seq>`, so an append is a single `set()` regardless of how long
the run is — O(1) per step rather than O(n²) over the run. `load()` reassembles via
`StorageAdapter.list(prefix)` followed by a single batch read (`storageGetMany`), not
one `get` per completed step: sharding trades an O(n²) write for an N-key read, and
that read must not become a round trip per step on the recovery path. Adapters that
implement `StorageAdapter.getMany` serve it in one query; the rest fall back to a
parallel `get` sweep. Because a batch read gives no ordering guarantee, `load()`
iterates the listed keys — whose zero-padded `<seq>` suffix is dispatch order — and
looks each value up, so a later entry at a path still wins over an earlier one.

Sharding bounds the cost of one append but not the total, so retention is bounded on two
axes. Both are configured together on the harness and validated at construction — a
non-positive cap is a `NoeticConfigError` (`STEP_LEDGER_RETENTION_INVALID`), never a
silent "records nothing":

```typescript
interface StepLedgerRetention {
  /** Largest output recorded, in UTF-8 bytes of its JSON encoding. Default 128 KiB. */
  maxEntryBytes?: number;
  /** Most entries retained per execution. Default 1000. */
  maxEntries?: number;
}

new AgentHarness({ /* … */ checkpointStore, stepLedgerRetention: { maxEntries: 5e3 } });
```

`Infinity` on either axis disables that cap.

1. **Per-entry size.** An output whose JSON encoding exceeds `maxEntryBytes` is not
   recorded at all — no spill to a side key, because moving the bytes elsewhere does not
   bound them and every real backend has a per-value limit the write would hit anyway.
   The cap is measured in UTF-8 bytes, decided from `String.length`'s 1–3 bytes-per-code-unit
   bracket so the common cases never encode the payload just to size it. An output that
   does not survive `JSON.stringify` at all (a cycle, a `BigInt`) is treated identically:
   nothing an adapter could persist, so nothing is recorded.
2. **Total entries.** Recording past `maxEntries` deletes the oldest entry, so resume is
   best-effort over a bounded **suffix** of the run: the tail replays, the head runs
   again. The bound is on the sequence *window* (`nextSeq - oldestSeq`), which is what
   makes eviction O(1) — an exact row count would need a `list()` per append, the very
   cost sharding removed. A gap from a failed write makes the window a slight
   over-estimate, so eviction fires marginally early, never late.

Both degradations reduce to the same thing: a step with no entry re-runs. That costs work
and re-does whatever effects the step has (see "The side-effect boundary"), never a
replayed value that disagrees with the recorded run. Retention is observable — `StepLedger.stats`
counts what was recorded, dropped, and evicted — and the first drop of each kind warns.

Sequence numbers are reserved synchronously, before the append's `await`. Concurrent `inParallel`
legs record through the one shared ledger, and a counter read after an await would let two
legs write the same key, silently losing a sibling's entry. `load()` therefore reports
`nextSeq` from storage rather than deriving it from the recovered entry count, which
retention's gaps would place *inside* the live window.

## Clearing a ledger

`harness.clearCheckpoint(executionId)` discards the snapshot **and** every ledger shard.
Hosts need it in two situations:

- **The workflow changed.** Replay happens at the coarsest completed granularity (see
  "Divergences" below), so an edit to a step *beneath* a recorded parent is invisible to
  divergence detection and the stale output wins. A host that edited the workflow must
  clear rather than resume onto the old ledger.
- **The execution reached a terminal state** — finished, or abandoned. `CheckpointStore.clear`
  alone strands the ledger's per-step keys, because nothing else enumerates them.

## Open questions

1. **`race` losers.** Losing paths are cancelled mid-flight. Do they record partial entries, and does a replayed race re-pick the same winner? Recommend recording only the winner and treating the race as a single memoized unit.
2. **`spawn` namespacing.** A spawn child gets its own `ContextImpl` with a fresh `id` (`execute-action.ts:816`). Does its ledger live under the child's execution id or under the parent path? Under the child id, a resumed parent will re-run the whole spawn unless the parent's ledger records the spawn's output — which it does, so the child's own ledger is only useful for resuming *inside* an interrupted spawn.
3. **Framework event replay.** Silent replay keeps traces honest but leaves a resumed UI blank for work that "already happened". `step_replayed` (above) is the proposed middle path; the UI contract needs a decision.
4. **Cross-harness boundaries.** Where a host builds a separate harness per sub-agent (the platform does), each gets its own execution id and ledger. A resumed parent will not skip a completed sub-agent through core's ledger alone — that must be fenced at the host's tool boundary. The platform already does this, which is why its fan-out is re-run safe today without any of this machinery.

## Test plan

- Loop body: two iterations, crash after iteration 2, resume replays both iterations' outputs in order and does not re-dispatch either.
- Static inParallel: 5 paths, crash with 3 complete; resume replays 3, dispatches 2.
- Divergence: ledger entry at a path whose `stepId` changed → entry and its subtree discarded, step runs fresh.
- Concurrent ordinal stability: an inParallel whose paths settle in a different order across runs produces identical path keys.
- Non-determinism: a `callModel` step with a scripted model returning different values per call; resume must surface the *recorded* value downstream.
- Layer non-double-fold: a folding layer plus a replayed step; layer state after resume equals layer state before crash.
- v1 snapshot loads under v2 with an empty ledger and resumes nothing.
- Retention config: defaults applied per axis; `Infinity` accepted; every non-positive or `NaN` cap throws `STEP_LEDGER_RETENTION_INVALID` at harness construction, not at first record.
- Per-entry cap boundary at N−1 / N / N+1 bytes, and a multi-byte payload that fits by code-unit count but not by byte count.
- Entry cap boundary: no eviction at the cap, oldest-first eviction one past it, and the retained set is the newest `maxEntries`.
- Bounded-suffix resume: a run longer than `maxEntries` resumes with the evicted head re-dispatched and the retained tail replayed, every output matching the original run.
- An oversized or unserialisable output is not recorded, and its step re-dispatches on resume while its neighbours still replay.
- Concurrent records (inParallel legs through one shared ledger) land on distinct keys.
- A resumed ledger never reuses a live sequence number, even when retention left a gap.
- `harness.clearCheckpoint` removes the snapshot and every ledger shard.

## Sizing

Prerequisite (wire the four firing boundaries) is small and independently valuable. The ledger itself is a moderate change concentrated in `execute()`, `harness-checkpoints.ts`, and the checkpoint schema, plus a new `step-ledger.ts`. The path-key work touches `ContextImpl`'s frontier bookkeeping and the inParallel dispatch site. The retention work (sharding) is the piece most likely to expand, and is the one worth prototyping first, since a design that is correct but writes O(n²) bytes will not ship.


## Divergences from the original design

Two things landed differently once the code was written.

**The ledger is sharded, not carried in the snapshot.** See "Schema and migration" and
"Size and retention" above: one key per entry removed both the O(n²) write amplification
and the need for a schema version bump. The atomicity caveat this spec raised still
applies in principle — the ledger and the layer-state snapshot are now separate writes —
but in practice a ledger entry newer than the snapshot only causes a step to replay whose
layer effects were also recorded by the same `execute()` call, since the post-step
checkpoint fires immediately after the ledger append.

**`detachedSpawn` is not a checkpoint boundary,** despite `23` listing one. A
`DetachedHandle`'s settle is only observable through `await()`, and calling that
internally would consume the result the caller is holding. The adapter's own
`listLive()`/`reattach()` manifest already covers detached children, so nothing is lost.
The other three boundaries (post-`execute`, post-`runAppendPipeline`, and the host-owned
ask-user enqueue) are wired.

**Replay happens at the coarsest completed granularity.** A composite step is an ordinary
`runCode` step in this framework — that is how the hydrator builds `sequence` — so a parent
that finished records its whole subtree's output, and a resumed run replays the parent
without descending. This is right for a true resume and wrong for a *changed* workflow:
editing a child under an unchanged parent has no effect on resume. A host that edited the
workflow must clear the ledger rather than resume onto it. Divergence detection therefore
catches a changed step at a recorded path, not a changed step beneath one.
