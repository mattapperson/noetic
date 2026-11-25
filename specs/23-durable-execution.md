# Durable Execution

> **Depends On:** `07-context-and-event-log` (Context, ItemLog), `08-runtime` (AgentHarness, SubprocessAdapter, StorageAdapter), `21-tasks` (planner/implementer subprocess pattern), `22-cli-architecture` (CLI subprocess wiring)
> **Exports:** `CheckpointSnapshot`, `CheckpointSnapshotSchema`, `CheckpointSchemaVersion`, `CheckpointStore`, `createCheckpointStore`, `FrontierFrame`, `CwdSnapshot`, `ItemLogSnapshot`, `PendingAskUserSnapshot`, `RestoreContextOptions`, `createFileStorage`, `DurableOutboundQueue`, `createDurableOutboundQueue`, `reattachLiveChildren`, `PendingSpend`, `SpendSettlement`, `SpendKind`, `ReconcileSpendOptions`, `WriteOffSpendOptions`
> **Source of truth:** `packages/core/src/runtime/checkpoint-store.ts`, `packages/core/src/runtime/durable/harness-checkpoints.ts`, `packages/core/src/runtime/file-storage.ts`, `packages/core/src/types/checkpoint.ts`, `packages/core/src/runtime/durable/spend-log.ts`, `packages/core/src/harness/spend.ts`, `packages/core/src/harness/model-price.ts`, `packages/types/src/types/spend.ts`, `packages/core/src/adapters/node/durable-outbound-queue.ts`, `packages/core/src/adapters/node/agent-ipc-{client,server,protocol}.ts`, `packages/cli/src/cli/reattach-live-children.ts`
> **Docs:** `packages/web/content/docs/framework/durability.mdx`

---

## Overview

Hosts crash. Tabs close. Users `kill -9` the TUI. The long-running children those hosts launched — planner subprocesses, implementer worktree agents, custom out-of-process sub-agents — keep running. Durable execution is the contract that lets a restarted host rediscover those children, rebuild the parent context they belong to, and resume as if nothing happened.

Four subsystems participate:

1. **Checkpoint store** — `harness.checkpoint(ctx)` serialises the execution's frontier, layer state, cwd, ask-user queue, item log, and the stored state of the channels it used (see `06-channels`, Lifecycle) to a `StorageAdapter`. `harness.restore(executionId, opts?)` reverses it, with `opts` carrying back the host wiring a snapshot cannot serialise.
2. **Subprocess adapter durability** — `adapter.listLive()` and `adapter.reattach(handleId)` persist and recover the handle manifest for every child the adapter launched.
3. **Durable IPC** — `DurableOutboundQueue` numbers every outbound IPC frame with a monotonic seq, persists them through a `StorageAdapter`, and resumes from the client's last-acked offset on reconnect. Protocol v2 frames (`durable`, `durableResume`, `durableAck`) carry the wire envelope.
4. **Spend log** — a record of every paid provider call, written before it is sent, so a call cut off by a crash or a cancel is settled at its real cost later, or held at a bound until it is (see § Paid dispatches).

Durability follows storage. A zero-config harness has no storage adapter, so every surface is a no-op and behaviour is ephemeral. A harness given `environment.storage.adapter` gets a `CheckpointStore` over that adapter by default, so a later harness built over the same storage resumes this one's executions — step-level resume (`23a-step-level-resume`) included — with no further wiring. The harness option `durability: false` turns every durability surface off, keeping the adapter for layer persistence only. Durability never leans on in-memory state: a run retried in place and a session turn read what storage holds (`23a-step-level-resume` § Storage is the only record). A CLI configured with `createFileStorage({root: '~/.noetic/checkpoints'})` and `createLocalSubprocessAdapter({storage: fileStorage})` gets full durable execution.

## `CheckpointSnapshot` schema

```typescript
const CheckpointSchemaVersion = 3;

interface CheckpointSnapshot {
  schemaVersion: 3;
  executionId: string;
  threadId?: string;
  resourceId?: string;
  frontier: FrontierFrame[];
  layers: Record<string, unknown>;        // layerId → serialised state
  cwd: CwdSnapshot | null;
  askUser: PendingAskUserSnapshot[];
  itemLog: ItemLogSnapshot;               // the run baseline — see below
  occurrences: Record<string, number>;    // dispatch counts at the same moment
  customItemTypes?: string[];             // custom item types the context accepted (spec 34)
  state?: unknown;                        // ctx.state, when it survives JSON encoding
  usage?: { tokens: TokenUsage; cost: number };
  channels?: ChannelSnapshot[];           // stored state of channels the execution used; topics skipped
  capturedAt: string;                     // ISO-8601
}

type ChannelSnapshot =
  | { name: string; mode: 'value'; value?: unknown; hasValue: boolean }
  | { name: string; mode: 'queue'; capacity: number; queue: unknown[] }; // oldest first

interface FrontierFrame {
  stepId: string;                         // points at a registry entry
  input: unknown;                         // serialisable input to the step
  state?: unknown;                        // optional per-frame state snapshot
}

interface CwdSnapshot {
  current: string | null;                 // active cwd
  previous?: string | null;               // enables `cd -` parity after restore
}

interface PendingAskUserSnapshot {
  id: string;
  input: unknown;                         // AskUserInput payload
  createdAt: number;                      // epoch ms
}

interface ItemLogSnapshot {
  items: unknown[];                       // re-parsed via ItemSchemaRegistry on load
}
```

`schemaVersion` is a literal, not a range. `restore()` validates the observed version via the Zod schema; a mismatch surfaces `NoeticConfigError` with `code: 'CHECKPOINT_SCHEMA_MISMATCH'` and a hint pointing to `CheckpointStore.clear()`. Future bumps must enumerate a migration path; the framework does not silently coerce.

Version history:

- **v2 → v3** — `itemLog` holds the run baseline (the log when the run in flight began) instead of the log at capture time, and `occurrences` records the dispatch counts from that same moment. A resumed run's replayed steps put their items back (`23a-step-level-resume` § The run baseline); a v2 log already holds them, so restoring it would duplicate history. No migration — discard and start fresh.
- **v1 → v2** — built-in layer ids changed (`working-context` → `scratchpad`, `static-content` → `instructions`, `observational-context` → `observations`, `file-reference` → `filesystem`, `history-window` → `history`, and `durable-task-state` → `task-state`). `layers` is keyed by layer id, so a v1 snapshot carries state under ids no current layer reads; restoring it would silently drop that state. No migration — discard via `CheckpointStore.clear()` and start fresh.

`frontier` is intentionally permissive: frame `state` is `unknown` because each step's state is user-defined. Callers that need specific shape guarantees parse at the call site.

`layers` is keyed by `layerId`; `restore()` re-inserts each entry into `harness.layerStateStore` under the original `executionId` so projections observe continuity. Layers that didn't publish state at snapshot time are absent from the record (not `null`).

`itemLog.items` is serialised as `unknown[]` and re-parsed on load via `harness.itemSchemas.parseMany(...)` — the same gate production traffic passes through, so extension item shapes are validated identically.

`itemLog` and `occurrences` are the **run baseline**: the item log and dispatch counts as they stood when the outermost `run()` on the context began, or the live values when no run is in flight. `layers`, `channels`, `state`, and `usage` are live. Replay rebuilds the rest of the log from the step ledger, while it redoes none of the live parts — see `23a-step-level-resume` § The run baseline.

## Checkpoint lifecycle

### Firing boundaries

`harness.checkpoint(ctx)` fires automatically:

1. **Run start** — when the outermost `run()` on a root context begins, after the context fixes its baseline. A run whose first step dies still leaves a snapshot.
2. **Post-`execute()`** — after each step completes, anywhere in the tree. `inParallel` paths and `spawn` children checkpoint through their parent to the root, so their usage, state, and layer folds roll into what a resumed root restores.
3. **Post-`runAppendPipeline`** — after the append pipeline resolves. Layer state can mutate as items land, and the snapshot must follow that mutation.
4. **Run end** — when the outermost run finishes, capturing the live log and counts as the next run's starting point. A run that fails skips this, so its start stays the resume point.

Ask-user enqueue is the host's boundary: the code-agent host pushes pending prompts through the store. `detachedSpawn()` is not a boundary — a `DetachedHandle`'s settle is only observable through `await()`, which would consume the result the caller holds; the adapter's `listLive()`/`reattach()` manifest covers detached children.

Captures for one execution are serialised: each waits for the one before it, so an older snapshot can never land after a newer one. Any caller may additionally invoke `harness.checkpoint(ctx)` explicitly.

### Idempotency

Snapshots are keyed by `executionId` under a single storage key (`execution:<id>:snapshot`). Successive snapshots for the same execution overwrite the prior record. There is no journaling and no CRDT merge; what a run did since its start lives in the step ledger, one key per step. Writes are single-key `StorageAdapter.set()` operations, which the file-backed adapter implements via write-temp-then-rename for atomicity on POSIX filesystems.

### Failure handling

A failing `store.save` is logged via `console.warn` and swallowed. **A failing checkpoint never aborts an otherwise-successful step.** Durability is a best-effort recovery mechanism, not a correctness invariant of the current turn. Because history is rebuilt from the step ledger, a stale snapshot costs only the live parts (layer folds, state, usage) since its capture. A run whose end-of-run snapshot fails keeps its ledger, since the stored snapshot still points at that run's start.

## One writer per turn

Two harnesses on one storage can reach for the same thread's turn: a host that restarted while the old process was still alive, or two workers handed the same message. A **turn lease** makes exactly one of them its writer.

The lease needs storage that can compare-and-set:

```typescript
interface StorageAdapter {
  // Store `next` only when what is stored equals `prev` (`null`: nothing stored).
  swap?<T>(key: string, prev: T | null, next: T): Promise<boolean>;
}
```

`swap` is optional. The check and the write must be one atomic step for every process sharing the storage, and values compare by their JSON encoding. A harness whose storage has no `swap` behaves as it always has: durable, with nothing stopping a second harness from driving the same turn.

With `swap`, every session turn (`harness.execute()`) runs under a lease:

- **The record.** `turn-lease:<threadId>` holds `{ term, holder, heldUntil }`. `term` goes up by one each time the lease is taken, and never goes back: where what is stored cannot be read as a lease, the next term is above its `term` if it has one, and the clock in epoch ms if not, so earlier entries in the ledger never outrank the new holder.
- **Taking it.** Before a turn reads anything, the harness swaps the record to `term + 1`. A lease another harness holds is waited on for up to `waitMs` (default: one `ttlMs` and a second more), which is long enough to take over from a holder that died; if it is still held then, the turn fails with `lease_lost`. The swap compares against the stored value exactly as read, so a record this version cannot parse is taken over rather than left to wedge the thread.
- **Keeping it.** The holder renews every third of `ttlMs` (default 30 s) while the turn runs, and hands the lease back when the turn ends, whether it finished or failed. One renewal runs at a time, and the hand-back waits for one in flight.
- **Fencing.** Every step-ledger entry carries its writer's term, and a sequence number is claimed with `swap` rather than set. A harness that finds a higher term in its way has been replaced: it stops with `lease_lost` and its context is aborted. An entry from a lower term is a replaced harness's late write, and the current holder overwrites it. On load, an entry with a lower term than one before it in sequence order is ignored.
- **Before paying.** The lease is read back from storage before each paid dispatch. A harness whose stored term is no longer its own stops there, before it spends again.
- **The thread record.** `session:<threadId>` carries the term of the last turn that wrote it. The turn's own writes (recording the turn, storing its history, parking) go through `swap`, carry the lease's term, and are refused when the record already holds a higher one. Every other write to the record (usage, kept steers, a seeded history) is a compare-and-set that is tried again on what the other writer left, so no writer drops another's fields.
- **Everything else.** A harness that knows it lost its lease writes no checkpoint, no pending entry, and deletes no ledger entry.

Time decides only when a quiet holder may be replaced; the term decides whose writes count. A holder whose clock runs behind can go on believing it holds a lease another harness took. Its writes to the thread record are refused by the term, and it stops at its next paid dispatch or its next conflicting ledger write. Between those points it can still do work that is thrown away: one model round at most, since each round begins with a paid dispatch.

Each harness needs its own `holder` name. The default is a random id; two harnesses given the same name would take each other's lease without waiting.

`harness.run(step, input, ctx)` on a context the host built itself takes no lease; the host owns that execution's identity.

Settings live under `environment.storage.lease`: `holder` (default: a random id per harness), `ttlMs`, `waitMs`, and `now`.

### Fail-stop

Under a lease, a durable write that fails stops the turn instead of being logged. A step-ledger entry or the thread record that cannot be written raises `ledger_write_failed`: the turn ends there, with everything before it recorded, rather than running on with work no resume could replay.

Without a lease the rule in § Failure handling stands: writes are best-effort.

The ledger's retention caps (`23a-step-level-resume` § Retention) are a policy, not a failure. An entry dropped for size or count is still dropped, and its step runs again on resume.

## Parked turns

A turn that reaches a `wait` step holds its process until the event comes. What it waits for is already in storage: the wait's pending entry carries the connection, the event, the cursor and the deadline (`35-connections` § Durability). A **parked** turn gives the process up.

Parking is on when `environment.storage.park` is set and the turn runs under a lease.

**When a turn parks.** The harness tracks the steps in flight. A turn parks once every innermost one has been a resumable wait for `graceMs` (default 100): a `wait` on an event whose manifest says `replay: 'durable'`, with its deadline still ahead; a `call` waiting on a long operation whose id is on record; or a held tool call. A step doing anything else — a model call, user code, a tool, a wait on an event that cannot be replayed — keeps the turn live. So does a step between two children.

**What parking does.**

1. The turn's record gains `parked: { until }`, the earliest deadline among its waits.
2. Its context is aborted, its connections are released, and its lease is handed back.
3. Its checkpoint, ledger and pending entries stay; they are what the turn resumes from.
4. `getAgentResponse()` resolves with `parked: { wakeAt }`, an empty `text`, and the items so far. The runner emits `{name}:turn_parked` in place of `turn_completed`.

A parked turn is rows in storage and nothing else. It survives the process ending, a deploy, and a move to another machine.

**Waking.** `harness.wake()` resumes stored turns by delivering their own message ids again, which is what resumes a cut-off turn (`23a-step-level-resume` § Sessions):

- `wake()` looks at every stored thread. A parked turn is resumed once its `until` has come. A turn cut off by its process dying is resumed at once. A turn that failed or was cancelled in a live process is marked `stopped` and left alone, or every routine wake would run it again.
- `wake({ threadId })` resumes that thread's turn whether or not it is due. A host calls it when it knows the event a parked turn waits for has arrived.
- A turn another harness holds, or one already running here, is left alone.
- An answer to a held call that lands while the turn's harness still holds the lease cannot wake it. That harness checks for one as soon as it has parked and released, and wakes the turn itself.
- `options` are the `execute()` options the turn runs with; a stored turn keeps none of its own, so a connection it waits on must be one the harness defines.

A woken turn replays its ledger, so no finished model call is made again, and its wait listens from the recorded cursor until the recorded deadline. If nothing has arrived it parks again, with the same `until`. If the deadline has passed, the wait fails as it would have live.

`harness.getNextWakeTime()` resolves the earliest time the harness has something to do: the earliest `until` among parked turns, or the next event of a scheduled source a trigger listens to, such as a `cron()` tick (`35-connections` § Triggers). A turn this harness is running counts too, one lease period ahead: should the process running it be gone, that is when its lease has run out and it can be picked up. Listeners hear that time as the turn begins, so a host that sleeps between requests has an alarm set for a turn that a deploy cuts off. It resolves `undefined` when there is none of these. A host with no process of its own between events schedules its next `start()` and `wake()` from it, and awaits `harness.waitForIdle()` before it lets its process go.

`harness.onWakeTimeChange(listener)` calls `listener` with that time whenever it changes, and returns a function that stops it. The first call comes when the harness starts. After that the harness checks when a turn parks or ends, when a trigger is added or removed, and when a trigger reads an event of a scheduled source; it calls the listener only when the time differs from the one last heard.

- A parking turn waits for the listener before it answers. If the listener throws, the turn's response rejects with that error: a turn nothing will wake does not look safely parked. The turn's record stays parked, so a later `wake()` still resumes it.
- Anywhere else, a listener that throws is logged and the harness goes on.
- The listener is told; it does not take over. Auto-wake, below, is unchanged by it.

**The clock.** `AgentHarness({ now })` is the clock wait deadlines, leases and wake times are read from. It defaults to `Date.now`.

**Auto-wake.** A harness wakes the turns it parked, unless `park.autoWake` is `false`. For each parked turn it keeps a watcher:

- a timer for the turn's `until`;
- a listener on each event the turn waits for, on the same harness connection, from the cursor the wait recorded;
- a poll, every `taskPollMs` (default 5 s), of each long operation one of its calls waits on. An operation has no event to listen for, so its state is read; the turn is woken when the state changes from the one it last woke for. An operation that goes back to `working` and then asks again is news again: a second question wakes the turn as the first did.

Either one calls `wake({ threadId })` with the options the turn ran with. A watcher knows the event's type but not the wait's `filter`, which is code in the flow, so it wakes on any event of that type; a turn whose filter turns the event down parks again. The watcher remembers the last cursor it saw, so each event wakes the turn at most once, and it waits `wakeDebounceMs` (default 250) after the first event so a burst wakes it once.

A watcher stands in for one turn. Before it wakes the thread it checks that the thread's parked turn is still that one: a turn another harness woke, which then failed or parked anew, is not woken by a watcher left over from before. When a wake cannot be done for a while (the runner is still closing the turn out) the watcher tries again, and if every try fails it goes back to watching.

A watcher lives in the process. When the process ends the parked turns stay in storage, and the next process rebuilds a watcher for each one its first `wake()` finds. So a long-lived host calls `wake()` once, at boot.

A host with no process between requests sets `autoWake: false` and wakes turns itself: `wake()` from an alarm it sets in `onWakeTimeChange()`, and `wake({ threadId })` when an event arrives.

### A message for a parked thread

A thread has one turn in flight. A message that arrives while that turn is parked must not start another, which would abandon the parked one:

- `next-turn` (the default) is kept in storage and runs as the next turn once the parked turn ends.
- A steer (`between-rounds`, `next-item`) is kept and wakes the turn. A turn stuck on held tool calls offers it to the context layers at the `held` steer point (`08-runtime` § Steers): applied, the held calls are skipped and the round goes on with the message.
- `interrupt` replaces the turn, as it does a running one. Its checkpoint, ledger and held calls are cleared.

Messages still queued in the process when a turn parks are moved to storage the same way. So is a message that reaches the runner while the turn is still closing out its park, and one that arrives for a thread whose turn is stuck (§ Versions): neither starts a turn.

Details that keep a parked turn whole:

- **Its messages come back together.** `wake()` hands the turn all its message ids as one arrival. A re-delivery of some of a turn's messages resumes that turn; it does not start another.
- **An answer that lands as the turn parks is not lost.** A decision that arrives while the turn is still coming to rest wakes it once it has.
- **A flow cannot catch its way out of a park.** Parking cancels the wait with `cancelled`. A flow that catches that and returns is parked all the same: its return value is discarded, and the woken turn goes back to the wait. A wait that really runs out of time fails with a timeout, which a flow may catch.
- **A filter is work.** While a `wait`'s `filter` runs on an event, the turn does not park.
- **`harness.abort({ threadId })` drops a parked turn.** Its checkpoint, ledger, held calls and pending entries are cleared, on whichever harness is asked.
- **A harness that was replaced says nothing about the turn.** It does not mark it stopped; the turn is the new holder's.

## Versions

A flow changes while turns are in flight. `AgentHarnessOpts.version` names the flow a harness runs: any string the host changes when the flow changes, such as a release tag or a hash. Old versions do not stay deployed; a turn moves forward to the version that resumes it.

- **Recorded.** The turn record stores the version the turn began under. Every ledger entry stores the version that recorded it.
- **Resume keeps what still matches.** The ledger matches per step, by id, kind and input hash (`23a-step-level-resume` § Identity). A turn resumed under another version replays every entry the new flow still agrees with and runs live from the first difference.
- **A recorded effect is not thrown away unasked.** An entry is marked `effect` when its step had a lasting effect: a `call` to a connection operation declared `once` or `effects`, or a `durable: true` tool, called by a model or by an `invokeTool` step. When a resume would discard such an entry recorded under a different version, the turn stops with `turn_stuck`, naming the step's path and both versions. Nothing is redone.
- **Stuck turns wait for the host.** The turn record is marked `stuck`. `harness.wake()` skips it, and a re-delivery of its message stops the same way. `turn_stuck`, `lease_lost` and `ledger_write_failed` end the turn whichever step they surface in: a `run` step neither retries them nor wraps them in `step_failed`.

```typescript
harness.listStuckRuns(): Promise<StuckTurn[]>;   // { threadId, executionId, path, from, to }

// the host's decision, passed to execute() on the stuck thread
harness.execute({ type: 'noetic:decision', action: 'continue' | 'restart' | 'abandon' }, { threadId });
```

| Action | What happens |
|---|---|
| `continue` | The host accepts the difference. The turn resumes on this harness's version and the step that no longer matches runs again. |
| `restart` | The ledger, held calls and pending entries of the turn are cleared and it runs from the top on this harness's version. Every step runs again, effects included. The snapshot is kept: it holds the turn's input. |
| `abandon` | The turn is dropped and its checkpoint cleared. Its trail is kept. The thread's next message starts a fresh turn. |

What marks an entry as an effect, and what keeps the mark:

- A durable tool a model calls marks its own call record and its round's record, which is what a cut-off step has on record.
- An entry replayed on a resume keeps its mark, so the parent that then records over it is marked too.
- `turn_stuck` reaches the harness from anywhere: a path of `inParallel` (it is not folded into `fork_partial`), a `settle` merge, a loop's `onError` (which may not retry or skip it), a `step_failed` cause.

What settling does, precisely:

- `continue` lets the turn go past the one step that was named. Another recorded effect further on that no longer matches stops the turn again. The choice is kept until the turn ends, so a host that dies part way through going on does not find the same step stuck.
- `restart` puts a trail mark down for every entry before it clears the ledger: what the first run did still happened.
- A message that arrives for a stuck thread is kept in storage and runs after the turn is settled (§ A message for a parked thread). It does not replace the stuck turn; `interrupt` does.

A decision for a thread with no stuck turn is refused with `decision_refused`. The decision is never written to the conversation, and other input passed beside it is delivered after it, so `abandon` and the next message can go in one call.

A harness whose `agentGraph` runs a JSON workflow, and that names no version, takes `workflow-<hash>`. The hash covers every document the graph runs: the root `hydrateWorkflow` returned, a `workflow({ document })` or `workflow({ ref })` step, and either of those as one step of several or nested inside other steps. It also covers the named workflows those were given, since a subflow `ref` runs one of them. Keys are sorted before hashing, so the same document is the same version whatever order its keys come back in from a database. Editing any of it is a new version. An explicit `version` wins.

The named workflows are read when the harness is built. `dynamicWorkflow` and `parseAndRunWorkflow` run a document that arrives at run time, on a context the harness or the host already made, and are not versioned this way: a host that runs its own document with `parseAndRunWorkflow` and edits it between runs names the `version` itself.

A harness with neither behaves as it did before versions: a resumed turn discards whatever no longer matches and runs it again. An entry recorded under no version never makes a turn stuck.

An author keeps an effect step matching across edits with `replayKey`, which keys its entry by a stable name instead of its position (`23a-step-level-resume` § `replayKey` and `durable: false`).

## The trail

The trail is what a run did, step by step, kept after the ledger that produced it is gone.

```typescript
harness.getAuditTrail(scope: { threadId } | { executionId }): Promise<TrailMark[]>;

interface TrailMark {
  executionId: string;
  path: string;        // the step's ledger path
  stepId: string;
  kind: string;
  completedAt: string; // ISO time
  version?: string;    // the flow version the step ran under
  term?: number;       // the lease term of the harness that ran it
  holder?: string;     // that harness's name in the lease
  receipt?: unknown;   // the `receipt` field of the step's output, when it has one
}
```

- A live ledger entry is read as a mark. When an entry is pruned (`23a-step-level-resume` § Retention) it leaves a mark behind under `execution:<id>:trail:<seq>`, without its output or items.
- Marks do not count toward `maxEntries`.
- A mark is kept under the sequence number of the entry it came from, and no new entry is given a number a mark already has.
- A thread's trail covers every turn it began, in order: its record keeps each turn's execution id in `executions`.
- Only `forget` deletes a mark (§ Forgetting), unless the host passes `keepTrail`. `clearCheckpoint`, an abandoned turn, and ledger pruning leave them.

## Restore flow

`harness.restore(executionId, opts?)` reverses a snapshot:

1. Reads the snapshot via `checkpointStore.load(executionId)`, and the step ledger (`23a-step-level-resume`). Returns `null` only when neither is recorded; with a ledger but no snapshot it takes the ledger-only path below.
2. Validates `schemaVersion` (throws `CHECKPOINT_SCHEMA_MISMATCH` on mismatch). A mismatched snapshot is never bypassed in favour of the ledger — the host clears and starts fresh.
3. Replays `layers` into `harness.layerStateStore` keyed by the original `executionId`, so context projectors and `ctx.context[layerId]` accessors observe continuity across the restart.
   Refills `channels` into the harness's channel store — value-mode values and queued items — for every channel with no live state, and records the execution as a user of each (see `06-channels`, Lifecycle). A snapshot without `channels` restores no channel state.
4. Re-parses `itemLog.items` through `harness.itemSchemas`, widened to accept `customItemTypes`, to recover typed `Item[]`. A custom item declared on a step outside the harness's `agentGraph` is accepted this way: the step that declares it has not run again yet.
5. Calls `harness.createContext({...opts, state: opts?.state ?? snapshot.state, threadId, resourceId, cwdInit: snapshot.cwd?.current})`, makes the context accept `customItemTypes`, then appends the parsed items, producing a fresh context seeded with the snapshot's item log, state, identity, and cwd. A run that rebuilds a context from storage before a retry accepts `customItemTypes` the same way.
6. Seeds the context's dispatch counts from `occurrences` and its tokens and cost from `usage`.
7. Overrides the returned context's `.id` to the original `executionId` so downstream adapter-correlation keeps working.
8. Attaches the recovered step ledger (`23a-step-level-resume`) keyed to that same id.
9. Holds the execution's pending paid calls on the context — `heldCost` is set before `restore` returns — and starts reconciling them in the background (§ Paid dispatches).

**Ledger-only restore.** A run whose snapshot writes failed (a save failure is swallowed, see above) leaves its step ledger behind. `restore` then builds the context as `createContext(opts)` would — empty item log, no restored layer or channel state, the harness's root cwd, a fresh thread id — overrides its `id` to `executionId`, and attaches the recovered ledger. Recorded steps replay; the rest run fresh. Layer `init` runs normally on the first `run()`, since there is no restored state for it to keep.

The returned `Context` stands where the interrupted run began: its item log and dispatch counts are that run's baseline, with the live layer state, channels, state, and usage. The caller resumes by running the same step on the same input — every recorded step replays and the run continues live from the first that was not. A context restored after a finished run stands after it, so the next step dispatched — a new user turn — runs fresh.

`harness.execute()` sessions do this themselves: a re-delivered cut-off turn resumes on its recorded execution (`23a-step-level-resume` § Sessions).

### Host context wiring is the caller's to supply

A snapshot recovers **data**. It cannot recover the **live objects** a host attached when it built the original context — event broadcasters, message queues, abort registrations. Restoring without them hands the host a bare context, and the failure is silent: nothing throws, streaming and mid-turn injection simply stop, on exactly the runs that already crashed once.

`restore()` therefore takes a second argument:

```typescript
interface RestoreContextOptions {
  parent?: Context;
  rollUpUsage?: boolean;
  state?: unknown;                        // wins over the snapshot's state when given
  contextLayers?: ContextLayer[];
}
```

It is `createContext`-shaped on purpose — a host passes back the same wiring it passed the first time:

```typescript
const restored = await harness.restore(executionId, {
  _broadcaster: session.broadcaster,   // internal seam, core-only
  state: session.state,
});
```

Two rules govern it:

- **Snapshot-owned fields are not accepted.** `items`, `threadId`, `resourceId`, and `cwd` always come from the persisted record. They are absent from `RestoreContextOptions` so a caller cannot pass a value that would be ignored; core spreads `opts` first and overwrites them second, so the snapshot wins regardless.
- **Post-construction decoration stays the host's job.** Fields a host `Object.assign`s onto a context, and abort registration, are applied to the context `restore()` returns — its `id` is already the original `executionId`, so anything keyed by execution id lands correctly.

## `CheckpointStore` API

```typescript
interface CheckpointStore {
  save(snapshot: CheckpointSnapshot): Promise<void>;
  load(executionId: string): Promise<CheckpointSnapshot | null>;
  list(): Promise<ReadonlyArray<{ executionId: string }>>;
  clear(executionId: string): Promise<void>;
}

function createCheckpointStore(opts: { storage: StorageAdapter }): CheckpointStore;
```

`CheckpointStore` is a typed wrapper over the harness's `StorageAdapter`. It owns the key layout (reserving the `execution:<id>:` prefix), validates every load through `CheckpointSnapshotSchema`, and surfaces typed errors for schema-version drift. Future sharded schemes (splitting frontier, layers, and item log under separate keys) can be added without bumping `schemaVersion` by reserving auxiliary suffixes under the same prefix — `CheckpointKeys` enumerates the suffix constants.

`list()` scans the storage for the execution prefix so hosts can inventory every known execution on boot. It returns only execution ids; callers that need the full snapshot pair it with `load`.

`clear(executionId)` deletes the snapshot. Used by `restore()` callers who catch `CHECKPOINT_SCHEMA_MISMATCH` and want to start fresh.

## Paid dispatches

The step ledger records work that finished. A model call in flight when the host dies, or when `cancel(ctx)` cuts it off, finished nothing, yet the provider may have billed it — a cut-off stream is billed for every token generated, including tokens generated after the client went away. Without a record written before the call, a restarted host cannot tell whether the call was billed or for how much, so a host with a spending limit must either hold its whole remaining budget as unknown or block on a person.

Every paid provider call therefore leaves a **dispatch record** in the harness's storage before it is sent: each `callModel` round on the OpenRouter client, and each native `decide()` call (an estimated `decide()` is `callModel` rounds, recorded as such). A harness with no checkpoint store records nothing.

### The record

```typescript
interface PendingSpend {
  id: string;                  // dispatch id
  unreadable?: true;           // the stored value no longer reads — see below
  kind: 'model' | 'decide';
  model: string;
  requestHash: string;         // hash of the request body sent
  inputTokens: number;         // the most prompt tokens the call can cost — see § Ceilings
  maxOutputTokens?: number;    // the request's output cap, when it set one
  executionId?: string;        // the root context's id
  threadId?: string;
  path?: string;               // ledger key: `<step path>/round#<n>`, or the decide step's path
  generationId?: string;       // the provider's id, saved as soon as headers arrive
  sentAt: string;              // ISO-8601
  ceiling?: number;            // USD the call can have cost at most — see below
}
```

A `spend:<id>` value that does not read as a record — torn by a crash mid-write, corrupted, or hand-edited, including one a store reads as nothing while its key still lists (`createFileStorage` reads an unparsable file that way) — is still evidence that a paid call was sent, so it is never skipped. It is listed as an **unreadable dispatch**:

```typescript
{
  id: string;                  // from the key
  unreadable: true;
  executionId?: string;        // kept when the damaged value still names one as a non-empty string
  threadId?: string;           // likewise
  // Placeholders for the fields the record lost:
  kind: 'model'; model: 'unknown'; requestHash: ''; inputTokens: 0;
  sentAt: '1970-01-01T00:00:00.000Z';
}
```

Nothing else in the damaged value is trusted. The placeholders keep `PendingSpend` one shape, so host code that reads `kind`, `model`, or `ceiling` compiles unchanged; code that trusts those fields checks `unreadable` first. An unreadable dispatch has no ceiling and no generation id, so it is treated as an unbounded hold that can never be priced (§ Ceilings, § Reconciliation): `pendingSpend` lists it, `restore()` holds it and `spend_pending` flags it `{ id, unreadable: true, unbounded: true }`, it adds nothing to `heldCost` or `until.maxCost`, and reconciliation leaves it held. It leaves storage only through `writeOffSpend`, which deletes it and charges the assumed cost like any write-off. One that names no execution may be any execution's: it is listed, held, and flagged with every execution, and a write-off charges the context it was last held on.

Records live under `spend:<id>`, outside the `execution:<id>:` prefix, so `clearCheckpoint`, an abandoned session turn, and every other discard leave them alone. A record leaves storage only when it is settled or written off; `forget` settles a thread's or execution's records before it deletes anything (§ Forgetting). Evidence of spend is never discarded with the run that made it.

**Lifecycle of one dispatch:**

1. **Before send** — the record is written (awaited). A failed write is logged and the call goes ahead: like a checkpoint, the record is best-effort and never blocks the call.
2. **Headers arrive** — the OpenRouter client's response hook reads `x-generation-id` and saves it to the record before the body is read. The model client and the decisions client share that hook, and each request carries its dispatch id in an `x-noetic-dispatch` header, so a `callModel` round and a native `decide()` both save their id when headers arrive. A stream that carries the id only in its `response.created` event saves it from there. A call cut off before any response byte has no id.
3. **Response complete** — the round's cost is counted, and then the record is deleted. The cost reaches the run through `LLMResponse.cost`, including when the loop rejects the response and asks again (a terminal status in a 2xx body, or no output), since the provider billed it. A call that throws instead of returning carries what its rounds spent on the error, and the step charges it to its context. A cancel that lands after the response arrived still counts that response's cost. A 2xx response that fails to parse was billed, so its record stays. A call the provider refused with an HTTP error status (400 or above) and no id is deleted too, as is one aborted before it was sent: nothing was generated.
4. **Anything else** — cancel, a steer that stops the stream, an idle timeout, a dropped connection — leaves the record. It becomes **pending**: held at its ceiling and reconciled in the background straight away.

A dispatch in flight in this harness is never pending: `pendingSpend` and `reconcileSpend` skip it, so its cost is counted once, by the call itself. Run one harness per storage at a time when reconciling; a second harness cannot see the first's live calls. A harness that finds a priced dispatch's record already gone from storage does not charge it: another harness settled it.

A crash in the few milliseconds between a response completing and the run recording it leaves no record and no ledger entry: the round is asked again, and the first bill is lost. Every earlier moment is covered.

### Ceilings

A pending dispatch's ceiling is an upper bound on what the provider can bill for it: its model's published price applied to its token bounds.

```
inputTokens = UTF-8 bytes of the request body + 1,024 + 4,096 × media parts
prompt      = min(inputTokens, context length)
ceiling     = prompt price × prompt + completion price × output cap + request price
output cap  = maxOutputTokens ?? the model's published max completion tokens
```

With neither output cap, the prompt and output share the context, so the ceiling is the dearer end of that trade: `max(prompt price × prompt + completion price × (context length − prompt), completion price × context length) + request price`.

The request body is what was sent: for a `callModel` round, its instructions, input, tools (each input schema as the JSON Schema the wire carries), and output format; for a native `decide()`, its state and questions. `inputTokens` bounds the prompt on three assumptions:

- **At most one token per UTF-8 byte of text.** Byte-level BPE tokenizers (GPT, Claude, Llama 3) and SentencePiece with byte fallback (Gemini, Mistral) never emit more tokens than the text has bytes, and the JSON body holds every byte of the prompt's text. A character-count estimate is not a bound: a provider's native tokenizer can count far more tokens than chars / 4.
- **At most 1,024 tokens of the provider's own framing per request**: chat template, role markers, the preamble a provider adds for tool use.
- **At most 4,096 tokens per media part** (`image_url`, `input_image`, `file`, `input_file`, `input_audio`, `input_video`, `video_url`). An image sent by URL is a few bytes of body that cost hundreds of tokens. A long PDF or audio file sent by URL can exceed this allowance, and its call then exceeds its ceiling.

A prompt longer than the context is refused or trimmed by the provider, so the context length caps it. The context length is the widest the model publishes, its own or its top provider's, since OpenRouter may route to any provider.

Prices come from the provider's model metadata (`GET /models/{author}/{slug}`), looked up once per model per harness and only when something is held, so a healthy call makes no extra request. Each price is the dearest the model publishes under any condition: the prompt price is the highest of the prompt and cache-write prices, the completion price the highest of the completion and reasoning prices, each across the base pricing and every override (long-context and time-of-day tiers).

The ceiling does not cover fees outside these prices: per-image prices above the media allowance, server-tool fees (web search, and the fetched content a server tool adds to the prompt), or a fallback provider that charges more than the model's published price or allows more output than its top provider. A record with no output cap anywhere, or a model with no published price, has no ceiling: it is flagged `unbounded: true` on `spend_pending`, listed by `pendingSpend`, and adds nothing to `heldCost`, so `until.maxCost` cannot see it either. A host with a budget that sees an unbounded or unreadable dispatch holds the rest of its allowance itself, or writes the dispatch off at an amount it asserts. Set `params.maxTokens` on paid steps to keep every ceiling finite.

### Reconciliation

```typescript
interface AgentHarness {
  pendingSpend(executionId?: string): Promise<PendingSpend[]>;
  reconcileSpend(opts?: { executionId?: string; patienceMs?: number }): Promise<SpendSettlement[]>;
  writeOffSpend(id: string, opts: { assumedCost: number }): Promise<SpendSettlement | undefined>;
}

interface SpendSettlement {
  id: string;
  executionId?: string;
  threadId?: string;
  cost: number;                // USD the provider billed, or the written-off amount
  inputTokens: number;
  outputTokens: number;
  model?: string;              // the dispatch's model
  path?: string;               // ledger key of the round or step that made the call
  writtenOff?: true;
  unbounded?: true;            // written off at 0: nothing bounded the call (§ Forgetting)
}
```

- `pendingSpend` lists unsettled dispatches, all of them or one execution's, each with its ceiling, and every unreadable dispatch (§ The record).
- `reconcileSpend` prices each pending dispatch that has a generation id through the provider's generation lookup (`GET /generation?id=`). The lookup answers 404 until the provider has priced the call — 7 to 32 seconds in practice — so it polls, backing off from 1 s to 10 s, for up to `patienceMs` (default 60 s). A priced call, cancelled or not, settles at the provider's `total_cost`. A dispatch with no id cannot be priced: it stays held until written off. A call already being looked up is joined, not looked up twice. The poll timers do not keep a host process alive.
- `writeOffSpend` settles one pending dispatch at an amount the host asserts, for a call that can never be priced. It is the only way an unreadable dispatch is settled.

Reconciliation runs on its own: after `restore()` for the restored execution, and for each dispatch the moment it is left pending — which covers `cancel(ctx)`, rounds a graceful stop cuts off at its deadline (`08-runtime` § Graceful Stop; `drain_finished.cutOff` names each by `dispatchId` and `generationId`), steers, and errors. A host can call `reconcileSpend()` again at any time, for example at boot for every execution.

**Where a settlement goes.** A settlement is charged once:

1. To the dispatch's root context while a run is in flight on it — through `recordUsage`, so `cost`, `billedCost`, `tokens`, and a session turn's usage pick it up.
2. Otherwise to the thread's stored session, when the dispatch's thread has one: `SessionUsage.cost` and `billedCost` grow.
3. Otherwise to the root context this harness restored or ran it on, when it has one.

The record is deleted before the charge, so a crash mid-settlement can lose a settlement but never count one twice. A settlement whose delete fails charges nothing and leaves the dispatch held, for a later reconcile. Every settlement is returned by `reconcileSpend`, whoever it was charged to.

### Held spend

Until settled, a pending dispatch is **held** at its ceiling:

- `Context.heldCost` is what the root context's pending dispatches are held at. `restore()` sets it from storage before it returns, taking over holds this harness kept on the execution's earlier context; a dispatch left pending in this harness adds to it; a settlement takes its ceiling back off.
- `SessionUsage.heldCost` and `HarnessResponse.heldCost` report the same beside `cost` and `billedCost`, for the thread's or turn's pending dispatches this harness knows of.
- The until `Snapshot` carries `heldCost`, and `until.maxCost` stops at `cost + heldCost`, so a resumed run cannot overspend the budget its cut-off attempt may already have used.

`heldCost` is a bound, not a bill: it never enters `cost` or `billedCost`.

### Events

| Event | When | Data |
|---|---|---|
| `{name}:spend_pending` | A dispatch is left pending, or `restore()` finds one | `{ id, kind, model, generationId?, ceiling?, unbounded? }`, or `{ id, unreadable: true, unbounded: true }` for an unreadable dispatch |
| `{name}:spend_settled` | A pending dispatch is settled or written off | `{ id, cost, writtenOff? }` |

Both go to the broadcaster of the dispatch's root context, else its thread's session.

### What stays bounded, not priced

- A call cut off before any response byte has no generation id, and is held at its ceiling.

## Forgetting

A host that is done with a thread or an execution tells the harness, and the harness deletes what it keeps for it. A host never builds a storage key itself: it finds what is stored with the listing calls and discards it with `forget`.

```typescript
interface AgentHarness {
  forget(scope: { threadId: string } | { executionId: string }, options?: ForgetOptions): Promise<ForgetReport>;
  listStoredThreads(options?: { prefix?: string }): Promise<string[]>;
  listStoredExecutions(options?: { prefix?: string }): Promise<StoredExecution[]>;
}

interface ForgetOptions {
  keepTrail?: boolean;  // keep the trail marks (§ The trail). Default false: keep nothing.
  patienceMs?: number;  // how long to wait for the provider to price a pending call. Default 60 000.
  waitMs?: number;      // how long to wait for another harness's lease on the thread to run out. Default 0.
}

interface ForgetReport {
  threadId?: string;
  executionIds: string[];       // every execution forgotten
  spend: SpendSettlement[];     // every pending dispatch settled or written off, priced ones first
}

interface StoredExecution {
  executionId: string;
  parts: ExecutionPart[];       // what is stored for it
  resumable: boolean;           // a snapshot or ledger entries are stored: `restore()` can rebuild it
}

type ExecutionPart = 'snapshot' | 'ledger' | 'trail' | 'held' | 'intent' | 'pending' | 'other';
```

A scope with neither a `threadId` nor an `executionId` is refused with `NoeticConfigError` `INVALID_FORGET_SCOPE`: a forget never falls back to the default thread.

### What a thread's forget deletes

`forget({ threadId })` covers every execution the thread ran: the turn in flight, parked, stopped, or stuck, and every turn that finished. The thread's record lists them in `executions`, the ids of every turn it began, oldest first, so a turn that has dropped out of the remembered `done` turns is still found. A record written before `executions` was kept names only its remembered turns and its turn in flight; executions older than those are not found. For each execution it deletes what an execution's forget deletes (below). Then it deletes, in order:

1. Context-layer state kept at the thread's scope key, `layers/<layerId>/<threadId>/`, for every layer that may keep state there: the harness's thread-wide `contextLayers`, every layer this harness has kept durable state for, and every layer the thread's record names in `layers` (the record keeps those ids as turns begin and end, so a harness that never ran the thread still finds them). A key that also lies under another stored thread's scope key — thread `a/b`'s `layers/<id>/a/b/` while forgetting `a` — is left to that thread. A layer that writes storage of its own outside these keys deletes it itself.
2. The thread's display output (`output:<threadId>`), after any write still queued for it has landed.
3. The thread's record (`session:<threadId>`): its history, usage, turn, remembered turns, and kept steers.
4. The thread's turn lease (`turn-lease:<threadId>`).

The lease goes last, while the forget still holds it (below). A forget cut off part way leaves the thread listed by `listStoredThreads`, so a later sweep finishes it. The harness also stops watching a parked turn of the thread and drops the thread's session and display output from memory.

### What an execution's forget deletes

`forget({ executionId })` deletes everything under `execution:<id>:` — the checkpoint snapshot (through the configured `CheckpointStore`), the step ledger, held calls and their intents, pending entries, the trail unless `keepTrail`, and any other key there. Core keeps layer state durably only at thread, resource, and global scope, so an execution has none to delete. A thread's record is not touched: forgetting the execution of a thread's turn leaves the thread naming an execution with nothing stored, and the turn starts over on its next delivery. Forget the thread for that.

A key under `execution:` is read as the execution its part's suffix names (`:snapshot`, `:ledger:`, `:trail:`, `:held:`, `:intent:`, `:pending:`). Any other key belongs to the longest execution id that other keys name and that it starts with, else to the id before its first colon; so `execution:a:b:custom` is execution `a:b`'s when `a:b` has records of its own.

An execution's forget also covers the connection-pool leases (`35-connections` § Pools and leases) of its run: a lease this harness still holds for it — a failed run keeps its lease for a resume — is released, which hands its connection back to the provider, and every stored lease record of the run is deleted, those a crashed process left included. A lease record names the run that holds it; one written before it did is the run's when its holder is the run (`<executionId>`) or one of its parallel paths (`<executionId>:path:…`). A thread's forget does this for each execution it forgets.

Deleting goes through the `StorageAdapter`, so storage that keeps a large value elsewhere (a spilled object, `25-platform-packages` § Values larger than a row) deletes it with its key.

### Spend is settled before anything is deleted

A forget never discards evidence of spend unaccounted for. Before it deletes anything it settles every pending dispatch (§ Paid dispatches) that names the thread, or one of the executions it forgets:

1. Each is priced through the provider's generation lookup, waiting up to `patienceMs`, as `reconcileSpend` does. A lookup already running for the dispatch, with a patience of its own, is waited on no longer than `patienceMs`.
2. Each the provider did not price is written off at its ceiling. One with no ceiling — its model publishes no price, its request set no output cap, or its record is unreadable — is written off at 0 and its settlement carries `unbounded: true`, so the host knows the bill was unknown.
3. A dispatch whose record could not be deleted, so it could not be settled, stops the forget with `ledger_write_failed` (`path` is `spend:<id>`) before anything is deleted, and the thread's lease is handed back.

Each settlement is charged as any other (§ Reconciliation) and returned in `ForgetReport.spend`, with the dispatch's `model` and `path`, so a host can attribute it. A settlement that lands after the thread's record is gone — a reconcile on another harness — charges nothing to it: a usage write never creates a thread's record. An unreadable record that names no execution and no thread is left alone: it is not known to be the thread's.

### A live turn is not forgotten, and none starts meanwhile

- A thread whose turn is running in this harness — in flight, queued, or being delivered — or an execution with a run in flight in this harness, is refused with `lease_lost`. So is a second forget of a thread this harness is already forgetting.
- While this harness forgets a thread, a message sent to it on this harness waits for the forget to end, then starts the thread afresh; a `wake()` skips it.
- On storage with `swap`, a thread's forget takes the thread's lease (§ One writer per turn) before anything else, waiting up to `waitMs` for a lease another harness holds; a lease still held elsewhere after that is refused with `lease_lost`. It renews the lease for as long as it runs, so another harness cannot start a turn of the thread meanwhile, and checks it still holds it before each execution it deletes and before deleting the record and the lease. A forget that finds the lease lost stops with `lease_lost`. A forget that fails hands the lease back. Taking the lease raises its term, so a harness that stalled mid-turn and comes back loses its next write and stops.
- On storage without `swap`, nothing fences another process. The host must make sure no other harness runs the thread.

### Listing what is stored

- `listStoredThreads` lists every thread with a record, a lease, or display output stored: any one of them is something a forget deletes. `prefix` narrows to thread ids that start with it.
- `listStoredExecutions` lists every execution with anything stored under `execution:<id>:`, or a snapshot in the configured `CheckpointStore`, with the parts stored. `resumable` is what a host checks to decide whether a run can be picked up: a trail alone is history, not a checkpoint. `prefix` narrows to execution ids that start with it.

Neither reads values, only keys. Both are empty without storage, except that a non-durable harness lists the threads whose display output it holds in memory.

## Subprocess adapter durability contract

### `reattach(handleId)` and `listLive()`

Every `SubprocessAdapter` implements two durability hooks:

```typescript
interface SubprocessAdapter {
  // ... standard methods ...
  reattach(handleId: string): Promise<SubprocessHandle | null>;
  listLive(): Promise<ReadonlyArray<SubprocessHandle>>;
}
```

- `listLive()` enumerates every handle the adapter currently treats as live. Used by host recovery to rediscover running children on startup.
- `reattach(handleId)` rebinds to a persisted handle, returning `null` when the id is unknown or the underlying execution is gone.

### Manifest shape (local adapter)

The local OS-process adapter persists one manifest entry per live handle:

```typescript
interface LocalSubprocessManifest {
  handleId: string;
  stepId: string;
  serializedInput: unknown;
  executionId: string;                    // context the step runs in
  parentExecutionId?: string;             // context that created it (see 04-spawn)
  pid: number;
  pidStarttime: string;                   // ps -p <pid> -o lstart= snapshot
  socketPath: string;
  cwd: string;
  metadata: Record<string, unknown>;      // caller-attached tags
}
```

Entries live under the harness's `StorageAdapter`, default root `~/.noetic/subprocess/` (via `createFileStorage({root: resolveSubprocessRoot()})`). On `reattach(handleId)` the adapter:

1. Loads the manifest entry.
2. Re-queries `pidStarttime` against `ps -p <pid> -o lstart=`. A mismatch means the pid was recycled and the original child is gone — the handle is marked `stopped` and the manifest cleared. A match means the original child is still alive.
3. Rebinds the unix-domain socket at `socketPath` so the IPC server resumes accepting frames.
4. Returns a rehydrated `SubprocessHandle` whose `status` reflects current liveness.

`listLive()` scans the manifest prefix and filters by liveness. Stale entries (pid gone or starttime drift) are pruned as they are detected.

### Manifest shape (in-memory adapter)

The in-memory adapter is the default zero-config backend and the framework's test double. When constructed without a `storage` option it keeps handles in a `Map` and returns the empty set from `listLive()`; `reattach` always returns `null`. When given a `storage: StorageAdapter` it additionally persists each handle's step request and metadata, and implements `reattach(handleId)` as an **idempotent replay** of the persisted step request — "reattach" here means "re-execute the step from the original input", not "resume mid-flight". This semantics is honest about the in-memory adapter's role (fast, deterministic, in-process) and matches the test double's purpose: verify the surface area without simulating a real OS process.

### Host recovery

On CLI startup, the host calls:

```typescript
import { reattachLiveChildren } from '@noetic-tools/cli';

const { handles, contexts } = await reattachLiveChildren(harness);
```

The helper enumerates `harness.subprocess.listLive()`, invokes `harness.restore(executionId)` per handle that carries an `executionId`, and returns a `Map<handleId, Context>` keyed by handle id so the TUI can target each restored context with its pending ask-user replay and live chat. When no durable storage is configured, both the handle list and the map are empty — the call is a cheap no-op.

## Durable IPC

### `DurableOutboundQueue`

When an IPC server wants its outbound frames to survive parent crashes (so chat can resume exactly where the peer left off), it wraps its send path in a `DurableOutboundQueue`:

```typescript
interface DurableOutboundQueue {
  append(frame: string): Promise<{ seq: number; frame: string }>;
  frameRange(startSeq: number): Promise<ReadonlyArray<{ seq: number; frame: string }>>;
  ackUpTo(throughSeq: number): Promise<void>;
  lastAckedSeq(): number;
  headSeq(): number;
  close(): Promise<void>;
}

function createDurableOutboundQueue(opts: {
  storage: StorageAdapter;
  socketPath: string;
}): Promise<DurableOutboundQueue>;
```

The queue is a pure transport primitive. It knows nothing about frame shape; frames are opaque strings (encoded by the server before enqueue). Each queue is namespaced under `durableOutboundQueue:<socketId>:` where `socketId` is a stable derivation of `socketPath` with reserved filesystem chars escaped.

Storage layout:

```
durableOutboundQueue:<socketId>:meta         → { lastAckedSeq, headSeq }
durableOutboundQueue:<socketId>:frame:<seq>  → "<frame string>"
```

Invariants:

- `headSeq` is the highest seq ever assigned. Appends start at `headSeq + 1`. Monotonic across the queue's lifetime; never reused even after full compaction.
- `lastAckedSeq <= headSeq`. No frame with `seq <= lastAckedSeq` is persisted.
- `ackUpTo(seq)` advances `lastAckedSeq` and deletes every frame in `(previousAck, seq]`.

Recovery: on load, the queue walks the `frame:` prefix and merges with the cached `meta` doc. A crash between frame write and meta flush leaves a frame whose seq is above the cached `headSeq`; the scan detects it and bumps `headSeq = max(cachedHead, scannedSeq)`.

### Protocol v2 frames

The on-wire protocol is newline-delimited JSON validated by Zod at both ends. Protocol v1 covered basic subscribe / send / hello / item / event / status / ack / error / bye frames. Protocol v2 adds three frames for the durable outbound path:

```typescript
// Server → Client: wrap an outbound frame with its assigned seq.
// The inner frame is carried as unknown to dodge recursive Zod schemas; the
// client re-parses it as a ServerFrame after unwrapping.
interface DurableFrame {
  type: 'durable';
  seq: number;
  frame: unknown;
}

// Client → Server: "I've seen up to seq N — replay anything past that".
// ackedThrough: 0 means "replay every still-persisted frame".
interface DurableResumeFrame {
  type: 'durableResume';
  ackedThrough: number;
}

// Client → Server: "I've processed every durable frame with seq ≤ N —
// you may compact them from the queue".
interface DurableAckFrame {
  type: 'durableAck';
  throughSeq: number;
}
```

`PROTOCOL_VERSION = 2` in `agent-ipc-protocol.ts`. The new frames are backwards compatible: servers and clients that do not opt into durable delivery neither emit nor receive them, and v1 peers continue to interoperate against the unwrapped frames.

### Server integration

A server that composes a `DurableOutboundQueue` wraps every non-handshake outbound frame:

1. Encode the original frame (e.g. an `item`, `event`, `status`, or `askUserRequest`) as a JSON string.
2. `const { seq } = await queue.append(encoded)`.
3. Send `{ type: 'durable', seq, frame: originalFrameObject }` on the socket.

On a client reconnect that carries a `durableResume { ackedThrough }` handshake, the server replays `queue.frameRange(ackedThrough + 1)` in order before resuming live emission. On a `durableAck { throughSeq }` the server calls `queue.ackUpTo(throughSeq)` to compact.

### Client integration

Clients track the highest seq they have successfully processed. On every reconnect they send `durableResume { ackedThrough: <last processed seq> }` immediately after the server's `hello`. For each `durable` frame received, they re-parse `frame` as a `ServerFrame`, apply it, and eventually send a `durableAck` once the frame is durably consumed by the application (persisted to the chat JSONL, rendered to the TUI, etc.).

## Host-restart recovery flow

End-to-end restart sequence for a CLI host:

1. **Boot** — CLI constructs `harness` with a durable `StorageAdapter` (e.g. `createFileStorage({root: '~/.noetic/checkpoints'})`), a durable `SubprocessAdapter` (e.g. `createLocalSubprocessAdapter({storage: createFileStorage({root: '~/.noetic/subprocess'})})`), and a `CheckpointStore`.
2. **Reattach** — calls `reattachLiveChildren(harness)`. The helper lists `harness.subprocess.listLive()`, calls `harness.restore(executionId)` per handle carrying an `executionId`, and returns the handles + restored contexts.
3. **Reopen sockets** — for each handle the host reopens the unix-socket IPC client against `manifest.socketPath`. The client sends `durableResume { ackedThrough: <persisted last-ack> }` after the handshake; the server replays missed frames in order.
4. **Replay ask-user** — snapshots with non-empty `askUser` arrays are re-delivered to the TUI modal queue so pending prompts resume from the pre-crash UI state.
5. **Resume** — each restored context continues to receive frames from the IPC server. User input on the restored chat flows through `harness.execute` as normal.

When any piece of the chain is misconfigured (no storage, no checkpoint store, no durable adapter), the corresponding recovery step returns an empty set or null and the system degrades gracefully to "fresh start".

## Storage layout

The CLI's durable execution uses three distinct on-disk roots so tools and operators can locate each concern independently:

| Concern | Default root | Owner | Shape |
|---|---|---|---|
| Subprocess handle manifests | `$HOME/.noetic/subprocess/` | `SubprocessAdapter.reattach`/`listLive` | One JSON file per manifest key. |
| Checkpoint snapshots | `$HOME/.noetic/checkpoints/` | `CheckpointStore.save`/`load` | One JSON file per `execution:<id>:snapshot` key. |
| Durable IPC outbound queues | `$HOME/.noetic/subprocess/` (or a caller-supplied storage) | `DurableOutboundQueue.append`/`frameRange` | One JSON file per `frame:<seq>` + one per `meta`. |

Subprocess and IPC queue storage share a root because the adapter already provides a `StorageAdapter` and wiring a second one would force callers to coordinate two storage adapters per launch. Keeping the checkpoint-snapshot root distinct makes "discard all recovery data" a single directory removal.

A thread's display output (`08-runtime` § Display output) is kept in the harness's `StorageAdapter` under `output:<threadId>`, one key per thread holding every snapshot. It is outside the `execution:<id>:` and `session:<threadId>` keys: `clearCheckpoint`, an abandoned turn and ledger pruning leave it alone, `restore()` never reads it, and nothing replays from it. `forget({ threadId })` deletes it (§ Forgetting).

Both root defaults respect `NOETIC_HOME` (if set, the roots become `$NOETIC_HOME/subprocess` and `$NOETIC_HOME/checkpoints`), so embedders that run under sandboxed or isolated home directories can relocate them with a single env var.

## Guarantees and limitations

**What durable execution guarantees:**

- Every completed step, every finished model-loop round, every spawned child, and every ask-user prompt survives a host crash when durable storage is configured. A new harness over the same storage resumes the execution, replaying what finished and sending the first unfinished model call exactly the history it had.
- Restart rediscovers running children and rebuilds the parent context for each.
- IPC replay is exactly-once at the frame level when the client tracks `durableAck` correctly — no losses, no duplicates.
- Schema version drift surfaces as a typed error, not silent corruption.
- On storage with `swap`, one harness at a time writes a thread's turn (§ One writer per turn), and a failed durable write stops the turn (§ Fail-stop).
- With parking on, a turn waiting on a replayable event holds no process, and resumes on any harness over the same storage with no finished model call made again (§ Parked turns).
- Every paid model call is recorded before it is sent. A call cut off after its response headers arrived is settled at the provider's exact cost once the provider has priced it; one cut off earlier is held at its ceiling. Neither is dropped by a discard (§ Paid dispatches).

**What durable execution does not guarantee:**

- **LLM mid-stream.** A round cut off mid-stream is asked again on resume; the rounds before it replay. Its first bill is settled from its dispatch record, not lost.
- **Prices for every cut-off call.** A call cut off before any response byte has no generation id, so it can only be bounded, never priced: it stays held until written off.
- **The tool interrupted mid-round.** The one tool call running when the host died runs again on resume, with the same idempotency key. Calls that had finished do not, in a recorded round or a cut one.
- **Non-idempotent `runCode` bodies.** A crash between a step's side effect and its ledger append re-runs the step body, whose side effects already landed. The framework cannot make arbitrary user code idempotent; use stable step ids and idempotent bodies where durability matters.
- **Third-party state outside the framework.** If a `runCode` mutates an external database, the database's state is not part of the snapshot. Callers that need cross-system consistency must integrate with their database's own transaction / idempotency primitives.
- **Adapter-specific identity drift.** The local adapter's `reattach` verifies `pidStarttime` against `ps`, which is a best-effort check; a truly adversarial pid recycle within `<1s` can evade detection. Out-of-the-box this is safe enough for interactive workloads; production-critical usage should run the child under a supervisor that owns pid identity.

## Examples

### Survive a host crash: file-backed storage

```typescript
import { AgentHarness, createFileStorage, createCheckpointStore } from '@noetic-tools/core';
import { createLocalSubprocessAdapter } from '@noetic-tools/core/adapters/node';

const storage = createFileStorage({ root: `${process.env.HOME}/.noetic/checkpoints` });
const subprocess = createLocalSubprocessAdapter({
  storage: createFileStorage({ root: `${process.env.HOME}/.noetic/subprocess` }),
});
const checkpointStore = createCheckpointStore({ storage });

const harness = new AgentHarness({
  name: 'durable-agent',
  agentGraph: myAgent,
  params: {},
  environment: {
    subprocess,
    storage: { checkpointStore },
  },
});
```

Any `detachedSpawn` through this harness lands a manifest entry; any `execute()` turn lands a checkpoint. Restart the process, construct the same harness, call `reattachLiveChildren(harness)`, and every live child comes back with its parent context rebuilt.

### Durable IPC server

```typescript
import { createDurableOutboundQueue } from '@noetic-tools/core/adapters/node';

const queue = await createDurableOutboundQueue({ storage, socketPath });

// On each outbound frame:
const encoded = JSON.stringify(frame);
const { seq } = await queue.append(encoded);
socket.write(encodeFrame({ type: 'durable', seq, frame }));

// On client durableAck:
await queue.ackUpTo(ack.throughSeq);

// On client durableResume:
for (const entry of await queue.frameRange(resume.ackedThrough + 1)) {
  socket.write(encodeFrame({ type: 'durable', seq: entry.seq, frame: JSON.parse(entry.frame) }));
}
```

The queue is transport-agnostic — any framed byte stream (unix socket, WebSocket, TCP) can use the same pattern.

## Future Considerations

- **LLM mid-stream resume.** If providers expose resumable streams, durable execution can carry an in-flight stream id across the restart boundary. Today the cut-off round is asked again.
- **Checkpoint coalescing.** Snapshots after every step boundary may become a bottleneck for very tight turns. A configurable debounce window (e.g. "don't snapshot more than once per 50ms") would reduce I/O without losing recovery guarantees — the next snapshot simply includes both changes.
- **Adapter-level durability for distributed backends.** `AgentHarness` already takes any `CheckpointStore`, so a distributed backend (Temporal event store, Inngest step state, etc.) plugs in by implementing that surface against its own persistence layer — the schema is portable. No separate harness class is needed.
- **Handle manifest GC.** Today stale manifests are pruned when `reattach` or `listLive` detects liveness drift. A periodic GC pass that compacts manifests older than the oldest live `lastSeenAt` would bound disk usage on long-running hosts.
