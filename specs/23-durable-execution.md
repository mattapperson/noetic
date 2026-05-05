# Durable Execution

> **Depends On:** `07-context-and-event-log` (Context, ItemLog), `08-runtime` (AgentHarness, SubprocessAdapter, StorageAdapter), `21-tasks` (planner/implementer subprocess pattern), `22-cli-architecture` (CLI subprocess wiring)
> **Exports:** `CheckpointSnapshot`, `CheckpointSnapshotSchema`, `CheckpointSchemaVersion`, `CheckpointStore`, `createCheckpointStore`, `FrontierFrame`, `CwdSnapshot`, `ItemLogSnapshot`, `PendingAskUserSnapshot`, `createFileStorage`, `DurableOutboundQueue`, `createDurableOutboundQueue`, `reattachLiveChildren`
> **Source of truth:** `packages/core/src/runtime/checkpoint-store.ts`, `packages/core/src/runtime/file-storage.ts`, `packages/core/src/types/checkpoint.ts`, `packages/core/src/adapters/node/durable-outbound-queue.ts`, `packages/core/src/adapters/node/agent-ipc-{client,server,protocol}.ts`, `packages/cli/src/cli/reattach-live-children.ts`
> **Docs:** `packages/web/content/docs/framework/durability.mdx`

---

## Overview

Hosts crash. Tabs close. Users `kill -9` the TUI. The long-running children those hosts launched — planner subprocesses, implementer worktree agents, custom out-of-process sub-agents — keep running. Durable execution is the contract that lets a restarted host rediscover those children, rebuild the parent context they belong to, and resume as if nothing happened.

Three subsystems participate:

1. **Checkpoint store** — `harness.checkpoint(ctx)` serialises the execution's frontier, layer state, cwd, ask-user queue, and item log to a `StorageAdapter`. `harness.restore(executionId)` reverses it.
2. **Subprocess adapter durability** — `adapter.listLive()` and `adapter.reattach(handleId)` persist and recover the handle manifest for every child the adapter launched.
3. **Durable IPC** — `DurableOutboundQueue` numbers every outbound IPC frame with a monotonic seq, persists them through a `StorageAdapter`, and resumes from the client's last-acked offset on reconnect. Protocol v2 frames (`durable`, `durableResume`, `durableAck`) carry the wire envelope.

Durability is opt-in and composable. A zero-config harness has no `CheckpointStore` and in-memory adapters with no storage, so every surface is a no-op and all existing behaviour is preserved bit-identically. A CLI configured with `createFileStorage({root: '~/.noetic/checkpoints'})` and `createLocalSubprocessAdapter({storage: fileStorage})` gets full durable execution.

## `CheckpointSnapshot` schema

```typescript
const CheckpointSchemaVersion = 1;

interface CheckpointSnapshot {
  schemaVersion: 1;
  executionId: string;
  threadId?: string;
  resourceId?: string;
  frontier: FrontierFrame[];
  layers: Record<string, unknown>;        // layerId → serialised state
  cwd: CwdSnapshot | null;
  askUser: PendingAskUserSnapshot[];
  itemLog: ItemLogSnapshot;
  capturedAt: string;                     // ISO-8601
}

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

`frontier` is intentionally permissive: frame `state` is `unknown` because each step's state is user-defined. Callers that need specific shape guarantees parse at the call site.

`layers` is keyed by `layerId`; `restore()` re-inserts each entry into `harness.layerStateStore` under the original `executionId` so projections observe continuity. Layers that didn't publish state at snapshot time are absent from the record (not `null`).

`itemLog.items` is serialised as `unknown[]` and re-parsed on load via `harness.itemSchemas.parseMany(...)` — the same gate production traffic passes through, so extension item shapes are validated identically.

## Checkpoint lifecycle

### Firing boundaries

`harness.checkpoint(ctx)` is invoked automatically at four well-defined boundaries on the happy path:

1. **Post-`execute()`** — after each step completes. This catches the item-log mutations the step produced and the layer-state writes those items triggered.
2. **Post-`detachedSpawn()`** — after the adapter's handle is returned. Keeps the parent's view of running children consistent with the adapter's manifest.
3. **Ask-user enqueue** — when a pending prompt is added to the ask-user queue. A restarted host can replay the modal to the TUI without losing state.
4. **Post-`runAppendPipeline`** — after the append pipeline resolves. Layer state can mutate as items land, and the snapshot must follow that mutation.

Any caller may additionally invoke `harness.checkpoint(ctx)` explicitly (e.g. after a long-running tool call settles). Snapshots are cheap: a few kilobytes per execution, one `StorageAdapter.set()` call.

### Idempotency

Snapshots are keyed by `executionId` under a single storage key (`execution:<id>:snapshot`). Successive snapshots for the same execution overwrite the prior record. There is no journaling, no CRDT merge, and no append-only log of snapshots. Writes are single-key `StorageAdapter.set()` operations, which the file-backed adapter implements via write-temp-then-rename for atomicity on POSIX filesystems.

### Failure handling

A failing `store.save` is logged via `console.warn` and swallowed. **A failing checkpoint never aborts an otherwise-successful step.** The rationale: durability is a best-effort recovery mechanism, not a correctness invariant of the current turn. If the snapshot write fails, the host simply loses the ability to resume from this exact point; on restart it re-issues the most recent turn and the item log's dedupe catches any duplicate writes.

## Restore flow

`harness.restore(executionId)` reverses a snapshot:

1. Reads the snapshot via `checkpointStore.load(executionId)`. Returns `null` if no snapshot is recorded.
2. Validates `schemaVersion` (throws `CHECKPOINT_SCHEMA_MISMATCH` on mismatch).
3. Replays `layers` into `harness.layerStateStore` keyed by the original `executionId`, so memory projectors and `ctx.memory[layerId]` accessors observe continuity across the restart.
4. Re-parses `itemLog.items` through `harness.itemSchemas` to recover typed `Item[]`.
5. Calls `harness.createContext({items, threadId, resourceId, cwdInit: snapshot.cwd?.current, memory: harness._memory})` to produce a fresh context seeded with the snapshot's item log, identity, and cwd.
6. Overrides the returned context's `.id` to the original `executionId` so downstream adapter-correlation keeps working.

The returned `Context` is API-compatible with the pre-crash one: layer state is accessible, item log is replayed in order, cwd is restored, identity matches. The caller resumes execution from whatever the frontier requires — for an interactive agent, this is typically re-issuing the most recent user turn; for a long-running runner, it is the runner loop's own resume logic.

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
  executionId: string;
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
import { reattachLiveChildren } from '@noetic/cli';

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

Both root defaults respect `NOETIC_HOME` (if set, the roots become `$NOETIC_HOME/subprocess` and `$NOETIC_HOME/checkpoints`), so embedders that run under sandboxed or isolated home directories can relocate them with a single env var.

## Guarantees and limitations

**What durable execution guarantees:**

- Every completed step, every spawned child, and every ask-user prompt survives a host crash when durable storage is configured.
- Restart rediscovers running children and rebuilds the parent context for each.
- IPC replay is exactly-once at the frame level when the client tracks `durableAck` correctly — no losses, no duplicates.
- Schema version drift surfaces as a typed error, not silent corruption.

**What durable execution does not guarantee:**

- **LLM mid-stream.** A crash mid-stream forces a turn re-issue on restart. The item log's response-id dedupe guards against double-recording an identical response; a different response wins as a new turn.
- **Non-idempotent `step.run` bodies.** A crash between step completion and the following checkpoint write can replay a step body whose side effects already landed. The framework cannot make arbitrary user code idempotent; use stable step ids and idempotent bodies where durability matters.
- **Third-party state outside the framework.** If a `step.run` mutates an external database, the database's state is not part of the snapshot. Callers that need cross-system consistency must integrate with their database's own transaction / idempotency primitives.
- **Adapter-specific identity drift.** The local adapter's `reattach` verifies `pidStarttime` against `ps`, which is a best-effort check; a truly adversarial pid recycle within `<1s` can evade detection. Out-of-the-box this is safe enough for interactive workloads; production-critical usage should run the child under a supervisor that owns pid identity.

## Examples

### Survive a host crash: file-backed storage

```typescript
import { AgentHarness, createFileStorage, createCheckpointStore } from '@noetic/core';
import { createLocalSubprocessAdapter } from '@noetic/core/adapters/node';

const storage = createFileStorage({ root: `${process.env.HOME}/.noetic/checkpoints` });
const subprocess = createLocalSubprocessAdapter({
  storage: createFileStorage({ root: `${process.env.HOME}/.noetic/subprocess` }),
});
const checkpointStore = createCheckpointStore({ storage });

const harness = new AgentHarness({
  name: 'durable-agent',
  initialStep: myAgent,
  params: {},
  subprocess,
  checkpointStore,
});
```

Any `detachedSpawn` through this harness lands a manifest entry; any `execute()` turn lands a checkpoint. Restart the process, construct the same harness, call `reattachLiveChildren(harness)`, and every live child comes back with its parent context rebuilt.

### Durable IPC server

```typescript
import { createDurableOutboundQueue } from '@noetic/core/adapters/node';

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

- **LLM mid-stream resume.** If providers expose resumable streams in the future, durable execution can be extended to carry an in-flight stream id across the restart boundary. Today re-issuing the turn is honest about the limitation and keeps the implementation simple.
- **Checkpoint coalescing.** Snapshots after every step boundary may become a bottleneck for very tight turns. A configurable debounce window (e.g. "don't snapshot more than once per 50ms") would reduce I/O without losing recovery guarantees — the next snapshot simply includes both changes.
- **Adapter-level durability for distributed backends.** `DurableAgentHarness` and `DistributedAgentHarness` can use the same `CheckpointStore` surface against their respective persistence layers (Temporal event store, Inngest step state, etc.) — the schema is portable.
- **Handle manifest GC.** Today stale manifests are pruned when `reattach` or `listLive` detects liveness drift. A periodic GC pass that compacts manifests older than the oldest live `lastSeenAt` would bound disk usage on long-running hosts.
