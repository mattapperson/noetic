# Step-Level Resume

> **Depends On:** `23-durable-execution` (CheckpointSnapshot, CheckpointStore, restore flow), `01-step-type` (Step), `03-control-flow` (inParallel/conditional), `05-loop-and-until` (loop, schedule), `07-context-and-event-log` (Context, ItemLog)
> **Exports:** `StepLedgerEntry`, `StepLedgerEntrySchema`, `StepLedger`, `StepLedgerStore`, `StepLedgerWindow`, `createStepLedgerStore`, `StepLedgerRetention`, `StepLedgerStats`, `DEFAULT_STEP_LEDGER_RETENTION`, `resolveStepLedgerRetention`
> **Source of truth:** `packages/core/src/runtime/durable/step-ledger.ts`, `packages/core/src/interpreter/execute.ts`, `packages/core/src/runtime/context-impl.ts`, `packages/core/src/runtime/durable/harness-checkpoints.ts`, `packages/core/src/harness/model-rounds.ts`, `packages/core/src/harness/thread-record.ts`, `packages/core/src/runtime/durable/session-store.ts`

---

## Problem

`23-durable-execution` rebuilds an execution's context: `harness.restore(executionId)` returns its item log, layer state, cwd, and identity. A restored context knows *what happened*, but not *how far it got*.

That gap matters as soon as a run is more than one model call. A loop on its twentieth iteration, a fan-out of eight workers with five finished, an agent on its fifth tool round — when the host dies or the network drops, re-running from the top pays for every finished call again, re-runs every finished tool, and produces different answers than the ones the rest of the run already saw.

Step-level resume closes the gap. A run cut off on one harness resumes on a new harness built over the same storage: every step that finished replays its recorded result instantly and for free, and the run continues live from the first step that did not finish.

## Why the frontier is not enough

The checkpoint frontier records which steps were **in flight**; a finished step leaves no trace in it. For an `inParallel` of 8 workers with 5 finished, the frontier holds the `inParallel` and the 3 in flight — the 5 finished ones are invisible.

Skipping finished steps would not be enough anyway. Steps consume the previous step's output, and a `callModel` step re-run to catch up returns a different value than the one the rest of the run observed. Resume therefore *replays recorded outputs*. It is memoization, not fast-forward.

## The ledger

One entry per successfully completed step:

```typescript
interface StepLedgerEntry {
  path: string;          // ledger key — the execution path, or `key:<replayKey>`
  stepId: string;
  kind: string;          // Step['kind'], or 'callModel:round' for a model-loop round
  output: unknown;       // replayed verbatim
  inputHash?: string;    // hash of the step's input when it ran
  items?: Item[];        // items the step appended to its context's item log
  completedAt: string;   // ISO-8601
  streamed?: number[];   // indices into `items` that `step.emitItems` emitted — streamed again on replay under `emitItemsOnReplay`
}
```

`streamed` marks which of `items` a step emitted through `emitItems` (`01-step-type` § Emitting items) rather than appended any other way. A replay always re-appends `items` quietly. When the harness sets `emitItemsOnReplay`, it also streams the `streamed` ones as `item_appended`. Indices travel with the items: an enclosing step's record takes its children's emitted items along with their marks, so an outer entry that replays wholesale still streams what its inner steps emitted.

Failures are not recorded: a step that threw runs again. Retry policies and `onError` handling are unchanged.

Entries are stored one key per entry under `execution:<id>:ledger:<seq>`, so an append is a single `set()` however long the run is. `load()` lists the prefix and reads every key in one batch (`storageGetMany`): adapters that implement `StorageAdapter.getMany` serve it in one query, the rest fall back to a parallel `get` sweep. `load()` walks the keys sorted — the zero-padded `<seq>` suffix is dispatch order — so a later entry at a path wins over an earlier one.

Sequence numbers are reserved synchronously, before the append's `await`. Concurrent `inParallel` legs record through one shared ledger, and a counter read after an await would let two legs write the same key. `load()` reports `nextSeq` from the stored keys rather than from the entry count, which pruning gaps would place inside the live set.

## Identity

### The execution path

`stepId` alone cannot key the ledger: a loop re-executes its body under the same ids every iteration. The key is the parent step's path plus the step's id and a per-parent occurrence ordinal:

```
/plan#0/review-loop#0/body-llm#2
```

`#n` is the n-th time that `stepId` has been dispatched under that parent path. `execute()` takes the ordinal at dispatch, from one counter per `(parent path, step id)` kept on the context.

Paths form a tree: each lane holds the counters for the steps dispatched beneath it and builds its path string only when something reads it — a ledger key, a checkpoint baseline, a child context's prefix. A run without a ledger never builds one, so deep recursion stays linear in depth. When a step settles, the counters beneath it are dropped, since nothing dispatches under a finished path again; its own counter, held by its parent, stays for the next dispatch of the same step id. A baseline lists every counter live when it is taken, in the flat `<parent path>/<step id>` form.

**Every dispatch runs on its own lane.** `ContextImpl.enterStep` returns a *lane*: a view of the context that shares everything (state, item log, usage, abort, ledger) except its execution path and the record of items appended through it. `execute()` hands the lane to the step, so whatever the step dispatches — through the interpreter or by calling `harness.run(child, input, ctx)` on the context it was given — hangs under that step's path. Concurrent dispatches on one context therefore cannot interleave each other's paths, and the in-flight frontier is a set of frames, so frames may settle in any order. `inParallel` and `spawn` children get their own `ContextImpl`, prefixed with the dispatching lane's path plus `[i]`.

**Determinism.** A path depends only on the parent's path, the step id, and the dispatch ordinal, never on settle order:

- `inParallel` paths take their `[i]` from the `paths` array index at dispatch.
- Concurrent calls with different step ids under one parent always get distinct, stable paths (`/left#0`, `/right#0`).
- Concurrent calls with the same step id under one parent are numbered in dispatch order (`/worker#0`, `/worker#1`). That is stable across a resume only when dispatch order is; when it is not, give the step a `replayKey`.

**A failed dispatch gives its ordinal back.** A resumed run never sees a failed attempt — nothing records a failure — so if a retry took the next ordinal, every later dispatch would sit one position past where the resume looks for it. When a step throws, its lane returns the ordinal (and drops the counters beneath it) as long as no later dispatch of the same key has taken the next one. A retry then runs at the failed attempt's path.

### The input hash

A path names *where* a step ran, not *what* it ran on. Every entry therefore records a hash of the step's input (`hashStepInput`: a 53-bit hash of its JSON encoding, computed once per dispatch on contexts with a ledger), and replay requires the new dispatch's input to hash the same. A replayed output becomes the next step's input after a JSON round trip, and `JSON.stringify` gives the same text for a value and its round-tripped copy, so a resumed run hashes the inputs the first run did.

The hash is what keeps a resumed context from answering the wrong question: a new user turn dispatched where an earlier one was recorded has a different input, so it runs fresh. An input that cannot be encoded has no hash; an entry recorded without one matches on identity alone.

### `replayKey` and `durable: false`

Two per-step fields, on every step kind (`StepReplay` in `packages/types/src/types/step.ts`):

```typescript
interface StepReplay<TContext, I> {
  durable?: boolean;                                    // default true
  replayKey?(input: I, ctx: Context<TContext>): string;
}
```

- **`replayKey`** replaces the path with a content key. The ledger records and looks the step up under `key:<replayKey(input, ctx)>`, so a leaf call finds its output wherever it runs — the fix for concurrent workers pulling timing-dependent batches from a shared queue. Keys are scoped to the execution, not to a parent: two dispatches that compute the same key share one entry, so the key must encode everything that makes the call distinct.
- **`durable: false`** keeps the step out of the ledger: no entry is replayed, none is recorded, and the step runs again on every resume. The opt-out is per step and does not propagate — children of a non-durable parent resolve their own keys. Its effects re-run with it, including channel sends and `ctx.state` writes, which the checkpoint already restored.

`execute()` resolves the key once per dispatch (`resolveLedgerKey`): none when `durable === false` or the kind is `schedule`; `key:<replayKey>` when a `replayKey` is set; the path otherwise. A `replayKey` that throws costs that dispatch its durability, never its run: the interpreter warns and executes the step without replay or recording.

JSON workflow nodes carry both: `durable` as a boolean, and `replayKey` in a declarative form (`true`, or `{ from: [...] }`) that the hydrator builds into the function (`26-json-workflow-runtime` § Replay keys).

## Recording and replay

**Recording.** On successful return, `execute()` records the step's output, its input hash, and the items it appended to its context's item log through its lane. Each lane's record also feeds its parent lane's, so a composite step's entry holds everything appended beneath it on the same context.

**Replay.** Before dispatch, `execute()` looks the key up:

1. If an entry exists at that key and its `stepId`, `kind`, and input hash match, the step does not run. Its recorded items are appended to the step's item log — through the step's lane, so the lanes above it note them too — and its recorded output is returned. The interpreter emits `step_replayed` rather than `step_started`/`step_completed`, so traces show a resumed run honestly. Replay does not emit `item_appended`: rebuilding history is quiet.
2. If an entry exists but diverges, it is discarded and the step runs fresh. A diverging path entry also discards every entry beneath it (paths starting with `<path>/` or `<path>[`): the subtree belongs to a run that no longer exists. A diverging `key:` entry discards only itself.
3. If recorded items no longer parse through the context's item schemas, the step runs fresh rather than half-replaying its history.

**Replay happens at the coarsest completed granularity.** A composite step is an ordinary step — the hydrator builds `sequence` as a `runCode` — so a parent that finished records its whole subtree's output and items, and a resumed run replays the parent without descending. Divergence detection therefore catches a changed step *at* a recorded path, not a changed step *beneath* one: a host that edited a workflow clears rather than resumes (`harness.clearCheckpoint`).

### What must not be memoized

- **`schedule`** — replaying its output would collapse a schedule into a value.
- **Steps marked `durable: false`** — see above.

## The run baseline

The checkpoint and the ledger divide the work. The ledger records what each finished step produced, including the items it added to history; the checkpoint records where the run started from.

A `CheckpointSnapshot`'s `itemLog` and `occurrences` are the run's **baseline**: the item log and dispatch counts as they stood when the outermost `run()` on the context began. Everything else in the snapshot — layer state, channels, `ctx.state`, usage — is live, captured at each checkpoint, because replay does not redo those: a replayed step neither folds into layers, nor writes state, nor spends tokens.

- **Run start.** When the outermost `run()` on a root context begins, the context fixes its baseline and queues a checkpoint. A run whose first step dies still leaves a snapshot to restore.
- **During the run.** Every completed step checkpoints its root — including steps on `inParallel` paths and `spawn` children, whose contexts checkpoint through their parent. Captures for one execution are serialised, so an older snapshot can never land after a newer one on a networked adapter.
- **A run that finishes** becomes the next run's starting point: the context drops its baseline, checkpoints the live log and counts, and — once that snapshot has landed — drops every positional ledger entry, which no later resume can reach. `key:` entries stay.
- **A run that fails** keeps its baseline and its ledger: it is what a resume repeats.

Restoring therefore stands the context where the interrupted run began, and re-running the same step on the same input replays every recorded step — each putting its items back on the log in order — and continues live from the first one that was not recorded. Because history is rebuilt from the ledger rather than read from the snapshot, it is correct on every context: an `inParallel` path or `spawn` child, whose log the snapshot never held, and a root whose latest snapshot failed to save.

The ledger and the snapshot are separate writes. A crash between a step's ledger append and the checkpoint after it replays that step with its items (from the entry) but without the layer folds and usage it produced (from the snapshot that did not land). The gap is one step wide.

## Model-loop rounds

One `callModel` step can run many rounds — the model asks for tools, the harness runs them, the model answers again. The step records only when the loop ends, so the loop records each finished round itself (`harness/model-rounds.ts`) under `<step path>/round#<n>`, with kind `callModel:round`, the step's input hash, and an output carrying what the round added: the model's output and tool-result items, the conversation input entries they became, and the round's usage and cost. Items the round appended to the item log (messages injected between rounds) ride in the entry's `items`.

A resumed loop replays rounds in order and stops at the first one it does not find; every round after that runs live, because a recorded round belongs to the conversation the earlier recorded rounds built. A replayed round runs none of its tools and adds its recorded usage to the step's response — it was paid for once. When the step finishes and records, its rounds are pruned with the rest of its subtree. A `durable: false` step's rounds are not recorded.

An abort that lands mid-call is not a round: the step surfaces cancellation, and the round is not recorded.

## Storage is the only record

Durability never leans on what a harness holds in memory. Everything that decides how a run or a session resumes is read from storage at the moment it is needed, so a harness that served the last run and a harness built a moment ago behave the same:

- **A run retried in place.** When a run starts on a context whose last run never finished, the context rebuilds from storage before the run begins: its item log and dispatch counts from the stored snapshot's baseline, its replayable entries from the stored ledger. A retry on the same context object therefore replays exactly what a new harness's `restore` would. Without a stored snapshot (its save failed), the baseline the context fixed when the failed run began stands in.
- **Sessions.** Every turn reads the thread's history and in-flight turn from its stored record; seeding history and settling a turn's usage are read-modify-writes of that record. A harness keeps no thread history of its own while durability is on.

Memory holds only what the current dispatch is doing, and copies of stored values that sync reads need (`getUsage()`), refreshed whenever the record is read or written.

## Usage on replay

Replayed work keeps its figures and costs nothing now, so usage reports both. `tokens`, `usage`, and `cost` are what the work cost — replayed steps contribute their restored or recorded spend, so budgets such as `until.maxCost` stop a resumed run where an uninterrupted one would. `billedCost` is what was actually paid now: an `LLMResponse` reports `cost` less what its replayed rounds supplied, a `Context` counts only this attempt's live calls (a restored context starts at 0), and `HarnessResponse` and `SessionUsage` carry the same split. A charge recorded with `recordUsage` is billed at its `cost` unless it gives a `billedCost`.

Session totals add each turn's increase in usage rather than its context's totals, because a resumed turn's context starts with the spend its cut-off attempt left in the snapshot.

## Sessions

`harness.execute()` runs each turn of a thread on a fresh execution. With durability on, each thread keeps a stored record under `session:<threadId>` (`runtime/durable/session-store.ts`): the history after the thread's last finished turn, what its turns have spent, and the turn in flight.

- Every turn reads the thread's history from the record. `seedSessionHistory` writes to it.
- Before a turn runs, the record names the turn's execution and the ids of the messages it delivers.
- When a turn finishes, the record stores the new history, clears the turn, and the turn's checkpoint and ledger are discarded.
- When a turn is cut off, its record stays. If the same message ids arrive again — a host with at-least-once delivery re-sends what it never saw answered — the turn resumes on its recorded execution: finished steps replay and the turn continues. Different messages abandon the cut-off turn: its checkpoint is cleared and they start a fresh turn.

Resuming a turn therefore requires the host to pass stable `messageId`s to `execute()`. A turn that finished is not replayed when re-delivered; it runs again as a new turn.

## The side-effect boundary

Replaying an output replays a step's **value**, not its **effect**. A `runCode` step that wrote a file, or an `invokeTool` step that opened a PR, returns its recorded output on replay while the effect is not redone — correct only if the effect was durable when it happened.

Within a model loop, a recorded round's tools do not run again. A tool interrupted mid-round, before its round recorded, runs again on resume. Core has no durable pre-dispatch record of a tool call and no way to know whether a tool is idempotent, so it does not claim exactly-once tool execution: fence effects whose duplication matters at the tool or host boundary.

## Interaction with context layers

Layer state is captured live and replayed into `layerStateStore` on restore. A replayed step therefore **bypasses the layer lifecycle** — no recall, no store, no append pipeline. Re-running `store` hooks against restored state would double-fold every observation the interrupted run already folded.

## Retention

Bounds are configured on the harness and validated at construction — a non-positive cap is a `NoeticConfigError` (`STEP_LEDGER_RETENTION_INVALID`), never a silent "records nothing":

```typescript
interface StepLedgerRetention {
  /** Largest entry, in UTF-8 bytes of the JSON of its output plus items. Default 128 KiB. */
  maxEntryBytes?: number;
  /** Most live entries per execution. Default 1000. */
  maxEntries?: number;
}

new AgentHarness({ /* … */ environment: { storage: { adapter, stepLedgerRetention: { maxEntries: 5e3 } } } });
```

`Infinity` on either axis disables that cap.

1. **Per-entry size.** An entry whose output plus items exceeds `maxEntryBytes` is not recorded — every real backend has a per-value limit the write would hit anyway. The cap is decided from `String.length`'s 1–3 bytes-per-code-unit bracket, so the common cases never encode the payload just to size it. An output that does not survive `JSON.stringify` at all is treated the same way.
2. **Live entries.** Once `maxEntries` are live, nothing more is recorded. A resume walks the run from the top, so the head of the ledger is what it reads first: keeping the head and dropping what follows keeps every replayed value consistent with the ones before it.
3. **Pruning.** When a step records, every entry beneath it is deleted: a resumed run replays the parent without descending, so they will never be read. The live count therefore tracks the open part of the run — the in-flight frontier and the finished siblings along it — rather than its length, and a parent may always record, since it frees its children.

Every degradation reduces to one thing: a step with no entry re-runs. That costs work and repeats the step's effects, but never replays a value that disagrees with the recorded run. Retention is observable — `StepLedger.stats` counts what was recorded, dropped (oversize, unserialisable, full), and pruned — and the first drop of each kind warns.

## Clearing a ledger

`harness.clearCheckpoint(executionId)` discards the snapshot **and** every ledger shard. Hosts need it when the workflow changed (see "coarsest completed granularity" above) and when an execution is abandoned; `CheckpointStore.clear` alone strands the ledger's shards.

## Schema

The ledger lives under its own keys, outside `CheckpointSnapshot`. The baseline semantics of the snapshot's `itemLog` and `occurrences` are `CheckpointSchemaVersion` 3 (`23-durable-execution` § Version history).

## Test plan

- Loop body: crash mid-loop on one harness; a new harness over the same storage replays every finished iteration and sends the cut-off iteration exactly the history it was sent before.
- A run that dies on its first step can be restored.
- A new question on a restored context runs fresh, and the item log holds every turn once.
- A recorded step whose input changed runs fresh.
- An `inParallel` path resumes with its own history.
- Snapshot writes failing mid-run: the resumed call still sees the full history.
- A retried transient failure inside a loop leaves the run where a resume expects it.
- A cost budget and `ctx.state` carry over a resume.
- A finished run leaves no positional entries; `durability: false` writes nothing to storage and restores nothing, even with an adapter and a store.
- A failed run retried on the same context rebuilds from storage and replays like a new harness.
- Usage on replay: `cost` keeps the work's cost; `billedCost` counts only what was paid now.
- Two harnesses taking turns on one thread both read its history from storage; a seeded history is stored.
- Model loop: a tool loop cut off mid-round resumes on a new harness with every finished round replayed, every tool run exactly once, and replayed usage counted; a `durable: false` step records no rounds.
- Sessions: a new harness continues a thread with its history; a re-delivered cut-off turn resumes on its execution; a different message after a cut-off turn starts fresh.
- Static inParallel: 5 paths, crash with 3 complete; resume replays 3, dispatches 2.
- Divergence: an entry at a path whose `stepId` changed is discarded with its subtree.
- Concurrent ordinal stability: concurrent `execute()` calls on one context get the same paths whichever settles first, and a resume replays both.
- Layer non-double-fold: layer state after resume equals layer state before the crash.
- Retention: defaults per axis; `Infinity` accepted; non-positive or `NaN` caps throw at construction; byte cap boundary at N−1 / N / N+1 and for multi-byte payloads; recording stops at the live cap; pruning frees the cap; a resumed ledger never reuses a sequence number.
- `durable: false` writes no entry and re-runs; a durable child under a non-durable parent still replays; `replayKey` hands each worker its own batch's output; a throwing `replayKey` skips the ledger without failing the step; `schedule` resolves no key.
- `harness.clearCheckpoint` removes the snapshot and every shard.
- Ledger entries with no snapshot restore a context with the original id; no snapshot and no ledger restores `null`; an unknown snapshot version throws `CHECKPOINT_SCHEMA_MISMATCH` even with a ledger.

## Future Considerations

- **Mid-stream resume.** A model stream cut off mid-response re-issues that round. Providers that expose resumable streams would let a round resume where its stream stopped.
- **Pre-dispatch tool records.** Recording a tool call before it runs would turn a tool interrupted mid-round into a loud "unknown outcome" instead of a silent re-run.
- **Re-delivered finished turns.** Remembering recently finished message ids per thread would let a session answer a re-delivery of a finished turn with its recorded response instead of running it again.
