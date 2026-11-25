# Platform Packages

> **Depends On:** `08-runtime` (FsAdapter, ShellAdapter, SubprocessAdapter, createLocal* factories), `23-durable-execution` (durable IPC, agent-ipc, step-bootstrap)
> **Exports:** (per-package, see below)
> **Source of truth:** `packages/platform-node/src/`, `packages/platform-browser/src/`
> **Docs:** `packages/web/content/docs/framework/platform-packages.mdx`

---

## Overview

`@noetic-tools/core` is the minimal, runtime-agnostic package. It defines the `FsAdapter`, `ShellAdapter`, `SubprocessAdapter`, and `StorageAdapter` contracts, and ships **in-memory adapters only** as built-in implementations. Every concrete backend that requires a specific runtime — Node's `fs/promises`, `child_process`, unix sockets, IPC framing, or browser APIs like OPFS — lives in a platform package.

Two platform packages ship:

- **`@noetic-tools/platform-node`** — Node.js ≥ 20 backends: local filesystem, local shell, local subprocess (OS child-process lifecycle, POSIX signals, unix-domain-socket IPC), durable outbound queue, agent-ipc client/server, step bootstrap entry, file-backed storage.
- **`@noetic/platform-browser`** — Browser, Cloudflare Worker, and Vercel Edge adapter glue. Currently re-exports core's runtime-neutral in-memory adapters for ergonomic imports; native OPFS / IndexedDB adapters are a future consideration (see below).

Each platform package declares only the peer dependencies relevant to its runtime. A consumer targeting Node installs `@noetic-tools/platform-node`; a consumer targeting a browser installs `@noetic/platform-browser`. Neither pulls dependencies from the other, so bundle size stays proportional to the chosen runtime.

## Motivation

Prior to this split, Node-only code lived inside `@noetic-tools/core` under the `@noetic-tools/core/adapters/node` subpath export. Browser consumers either imported that subpath (and paid for `node:child_process` bundler shims) or hand-rolled their own adapters. Each package now carries exactly the deps it needs:

- `@noetic-tools/core` — zero runtime-specific deps, zero third-party peers beyond `zod` and the OpenRouter SDK. Safe in every environment. Exports only contracts, in-memory adapters, and the agent harness.
- `@noetic-tools/platform-node` — Node APIs only (`node:fs/promises`, `node:child_process`, `node:net`, `node:path`).
- `@noetic/platform-browser` — web platform APIs only (`navigator.storage`, `BroadcastChannel`, `fetch`); no `node:*` imports.

Consumers opt into the surface they want. Test suites that need the Node subprocess adapter add `@noetic-tools/platform-node` to their devDependencies; code-agent and cli (which are Node-only by nature) depend on it directly. Browser apps and edge workers depend on `@noetic/platform-browser`. Runtime-agnostic consumers (eval) stay on `@noetic-tools/core` alone and inject whichever adapters the caller supplies.

## Package Layout

### `@noetic-tools/core`

Only in-memory adapter implementations ship in core. Everything else is a contract or part of the agent harness / interpreter / memory stack.

```typescript
// Adapter contracts (types only)
export type {
  FsAdapter, FsStats,
  ShellAdapter, ShellExecOptions, ShellExecResult,
  SubprocessAdapter, SubprocessHandle, SubprocessRequest, /* … */
  StorageAdapter,
} from './types/...';

// In-memory adapter factories — the only adapter implementations in core
export { createInMemoryFsAdapter } from './adapters/in-memory-fs-adapter';
export { createInMemoryShellAdapter } from './adapters/in-memory-shell-adapter';
export { createInMemorySubprocessAdapter } from './adapters/in-memory-subprocess-adapter';

// Harness, interpreter, context, builders — unchanged
export { AgentHarness, /* … */ } from './harness/agent-harness';
```

Peer dependencies after the split:

- `zod`, `@openrouter/agent` (unchanged).
- No runtime-specific peers (no Node-only packages).

### `@noetic-tools/platform-node`

Exports (all stable):

```typescript
// Filesystem, shell, subprocess
export { createLocalFsAdapter } from './local-fs-adapter';
export { createLocalShellAdapter } from './local-shell-adapter';
export { createLocalSubprocessAdapter } from './local-subprocess-adapter';

// Durable execution glue
export { createFileStorage } from './file-storage';
export { createSqliteStorage } from './sqlite-storage';
export { createDurableOutboundQueue } from './durable-outbound-queue';

// Per-task IPC (see 08-runtime § Per-Task IPC for Live Chat)
export { createAgentIpcServer } from './agent-ipc-server';
export { createAgentIpcClient } from './agent-ipc-client';
export { AgentIpcProtocol } from './agent-ipc-protocol';

// Subprocess step bootstrap entry
export { runStepBootstrap } from './step-bootstrap';
```

Peer dependencies: none. Runtime imports: Node built-ins only (`node:fs/promises`, `node:child_process`, `node:net`, `node:path`, `node:os`, `node:crypto`). No third-party Node deps at runtime.

### `@noetic/platform-browser`

Exports (all stable):

```typescript
// Re-exports of core's in-memory adapters for ergonomic imports
export {
  createInMemoryFsAdapter,
  createInMemoryShellAdapter,
  createInMemorySubprocessAdapter,
} from '@noetic-tools/core';
```

Peer dependencies: none. Runtime imports: browser platform APIs only. No `node:*` imports — bundlers targeting browsers succeed without polyfills.

### `@noetic-tools/platform-cloudflare-worker`

Exports (all stable):

```typescript
export { createD1Storage, createDurableObjectStorage };          // StorageAdapter, with swap
export { eventEndpoint, EventEndpointStatus, standardWebhookVerifier };
export { alarmWake };                                            // wake preset: Durable Object alarm
export { runTurn, startTurn, wakeTurn, turnInstanceId, TURN_WAKE_EVENT }; // wake preset: Cloudflare Workflows
```

Peer dependencies: none. It imports neither `cloudflare:workers` nor a Cloudflare types package: every helper takes a structural type naming the part of a binding it calls (`D1DatabaseLike`, `DurableObjectSqlLike`, `AlarmStorageLike`, `WorkflowStepLike`, `WorkflowBindingLike`), so the real bindings fit and a test passes its own. No `node:*` imports. See § Cloudflare Workers.

### Migrating `@noetic-tools/core/adapters/node`

The existing `@noetic-tools/core/adapters/node` subpath export is removed. Consumers update imports:

```diff
- import { createLocalFsAdapter } from '@noetic-tools/core/adapters/node';
+ import { createLocalFsAdapter } from '@noetic-tools/platform-node';
```

## Dependency Direction

```
@noetic/plugin-*  ──→  @noetic-tools/cli  ──→  @noetic-tools/code-agent  ──┐
                                                                ├──→  @noetic-tools/platform-node  ──→  @noetic-tools/core
                                                                │                                     ↑
                                                                └─────────────────────────────────────┘
                                                                                                      ↑
browser/edge consumer  ──→  @noetic/platform-browser  ─────────────────────────────────────────────────┘
                                                                                                      ↑
@noetic-tools/eval  ────────────────────────────────────────────────────────────────────────────────────────┘
```

- `@noetic-tools/core` has no dependency on any platform package.
- `@noetic-tools/platform-cloudflare-worker` depends only on `@noetic-tools/core`, like its two siblings, and imports neither of them.
- Platform packages depend only on `@noetic-tools/core` (plus their runtime's built-ins and any declared peers).
- Node-only consumers (`@noetic-tools/cli`, `@noetic-tools/code-agent`, `@noetic/plugin-*`) depend on `@noetic-tools/platform-node`.
- Runtime-agnostic consumers (`@noetic-tools/eval`) depend only on `@noetic-tools/core` and inject whichever adapters they need via their API surface.
- Browser consumers depend on `@noetic/platform-browser`.

## Sentrux Rules

Two new layer entries, both at order 81 (the existing `adapters/` tier):

```toml
[[layers]]
name = "platform-node"
paths = ["packages/platform-node/**"]
order = 81

[[layers]]
name = "platform-browser"
paths = ["packages/platform-browser/**"]
order = 81
```

Boundary rules prevent cross-platform imports:

```toml
[[boundaries]]
from = "packages/platform-node/**"
to = "packages/platform-browser/**"
reason = "platform packages must stay runtime-isolated; neither may import from the other"

[[boundaries]]
from = "packages/platform-browser/**"
to = "packages/platform-node/**"
reason = "platform packages must stay runtime-isolated; neither may import from the other"

[[boundaries]]
from = "packages/core/**"
to = "packages/platform-node/**"
reason = "core is runtime-agnostic; it cannot depend on a specific platform"

[[boundaries]]
from = "packages/core/**"
to = "packages/platform-browser/**"
reason = "core is runtime-agnostic; it cannot depend on a specific platform"
```

Context layer boundaries extend to forbid importing platform packages directly:

```toml
[[boundaries]]
from = "packages/context/src/**"
to = "packages/platform-node/**"
reason = "context layers are platform-independent; platform packages are platform-specific"

[[boundaries]]
from = "packages/context/src/**"
to = "packages/platform-browser/**"
reason = "context layers are platform-independent; platform packages are platform-specific"
```

## Migration Path

The split replaces the `@noetic-tools/core/adapters/node` subpath export with `@noetic-tools/platform-node`. There is no transitional shim: callers update their imports in a single pass.

Mechanical migration:

1. Replace `from '@noetic-tools/core/adapters/node'` with `from '@noetic-tools/platform-node'` in every import.
2. Add `@noetic-tools/platform-node` (or `@noetic/platform-browser`) to the package's `dependencies`.

`@noetic-tools/code-agent` and `@noetic-tools/cli` migrate in lockstep with the package creation because they consume the Node adapters directly. `@noetic-tools/eval` does not import Node adapters today; its migration is a documentation update only.

## Tree-shakability Guarantees

- Importing `@noetic-tools/core` into a browser bundle must produce no `node:*` references in the output. Enforced by a CI test that bundles `@noetic-tools/core` with a browser target and fails on any `node:` specifier.
- Importing `@noetic/platform-browser` similarly produces no `node:*` references.
- Importing `@noetic-tools/platform-node` may reference `node:*`; bundling for a browser target surfaces the mismatch as a build-time error, which is the desired behaviour.

## Storage

Both Node storage adapters implement `StorageAdapter.swap` (`23-durable-execution` § One writer per turn), so sessions on them run under a turn lease.

- **`createFileStorage({ root })`** — one JSON file per key. `swap` holds a per-key lock directory (`mkdir` is the atomic step) while it compares and writes, so processes sharing `root` agree. A lock older than 10 s was left by a process that died and is removed.
- **`createSqliteStorage({ database, table? })`** — one row per key in one table (default `noetic_storage`, created when missing). `database` is an open handle the caller owns: a `Database` from `bun:sqlite`, a `DatabaseSync` from `node:sqlite`, or a `better-sqlite3` database. The package imports no SQLite driver. Each statement is atomic across the processes that open the file, and a write that fails throws.

## File Artifact Store

`@noetic-tools/platform-node` provides `createFileArtifactStore({ dir,
retention })`, the Node implementation of the `ArtifactStore` contract
(`08-runtime` § Artifact Store). Blobs are written once under
`<dir>/sha256/<aa>/<hex>` with a sidecar metadata file, and each run's manifest
under `<dir>/runs/<executionId>.json`. `@noetic/platform-browser` re-exports
core's in-memory store; a browser host may implement the contract over
IndexedDB or a remote store.

## Webhook Receiver

`@noetic-tools/platform-node` provides `createWebhookReceiver({ port, publicUrl })`, an HTTP receiver passed to `mcp({ webhooks })` for servers that deliver events by webhook (`35-connections` § Events). `@noetic/platform-browser` provides none; a serverless host implements the contract over its own routing.

The contract `mcp()` consumes is transport only: `register(handler)` opens an endpoint and returns `{ url, close() }`; each POST reaches `handler` as `{ headers, body }` (lowercase header names, raw body text) and is answered with the `{ status }` the handler returns. `mcp()` verifies deliveries itself with the secret it sent in `events/subscribe`. The Node receiver also accepts `register({ onDelivery, secret?, signal? })`, for which it verifies each delivery (Standard Webhooks signature, five-minute timestamp window, duplicate ids) before calling `onDelivery`. Either way it refuses methods other than POST (405), bodies over `maxBodyBytes` (413) and unknown or closed endpoints (404).

## Cloudflare Workers

A Worker has no process between requests, no filesystem and no timers that outlive a request. `@noetic-tools/platform-cloudflare-worker` supplies what a durable harness needs there: storage with `swap`, a way in for events, and something to call `harness.wake()`.

### Storage

Both adapters implement `StorageAdapter.swap`, store each value as its JSON encoding in one table (default `noetic_storage`, created when missing) and throw when a write fails.

- **`createD1Storage({ database, table? })`** — one row per key in a D1 database. Every Worker bound to the database shares the storage. `swap` is a single conditional statement (`INSERT … ON CONFLICT DO NOTHING` for a missing key, `UPDATE … WHERE key = ? AND value = ?` otherwise) and wins when it changed one row. The table is made on first use.
- **`createDurableObjectStorage({ sql, table? })`** — one row per key in a Durable Object's SQLite storage (`ctx.storage.sql`). One object is one storage. `swap` reads, compares and writes with no `await` between, which an object runs as one atomic step.

### Event endpoint

A webhook is the host's business: core has no webhook concept (`35-connections` § Events). `eventEndpoint({ emit, verify?, toEvent, harness? })` is the last step, from a request the host accepts to an event a source emits. It returns a `fetch`-shaped handler:

| Answer | When |
|---|---|
| `405` | The request is not a POST. |
| `401` | `verify(request, body)` returned false or threw. |
| `400` | `toEvent(body, request)` threw. |
| `204` | `toEvent` returned `undefined`: a delivery that carries no event. |
| `503` | `harness.start()` or `emit` rejected: the event is not stored, and the provider should send it again. |
| `200` | `emit` resolved, which is when every listening trigger has stored the event. |

A source's `emit` rejects when no trigger is there to store the event, which is the state of a Worker whose harness has not started. Given `harness`, the endpoint awaits `harness.start()` before it emits, so the first request of a cold Worker stores its event. `start()` is idempotent.

`standardWebhookVerifier({ secret, toleranceMs?, now? })` throws when it is built with a secret that is not base64, not on each delivery. It is a `verify` for Standard Webhooks signatures on Web Crypto. It does not drop a repeated `webhook-id`; a trigger's inbox dedupes by event id, so `toEvent` uses the `webhook-id` as the event's id.

### Waking parked turns

A harness in a Worker is built with `park: { autoWake: false }`: its own timers do not outlive the request. The host picks one preset.

**Alarm.** `alarmWake({ harness, alarms, now? })`, in a Durable Object, with `alarms` the object's `ctx.storage` and `now` the clock the harness runs on when it is not `Date.now`.

- It listens with `harness.onWakeTimeChange()` and keeps the object's alarm at the time it hears, deleting the alarm when there is none. The host sets no alarm itself: the first is set when the harness starts, and a turn that parks does not answer until its alarm is set.
- `alarm()`, called from the object's `alarm()` handler, calls `harness.start()`, `harness.wake()` and `harness.waitForIdle()`, then sets the alarm to `harness.getNextWakeTime()`, since the alarm that fired is spent even when the time did not change. `getNextWakeTime()` covers a turn a dead Worker was cut off in: it is due when that Worker's lease runs out, so the alarm is neither dropped nor fired in a loop before then. Starting the harness is what makes a `cron()` source deliver the ticks that fell due while nothing ran. A wake time that is still in the past after the pass (something due that this pass could not do) is not set as it is, since an alarm in the past fires at once: the alarm is set 30 seconds ahead. It does not throw for a turn that failed, since a throw makes the runtime retry the alarm.
- `stop()` stops the listening.

A `cron()` trigger therefore runs on the alarm preset as it does on Node, with the schedule written once. The package has no cron helper of its own.

**Cloudflare Workflows.** One Workflow instance per turn. `runTurn({ harness, step, turn, options?, maxWaitMs?, now? })` is called from the Workflow's `run`:

1. Step `turn-0` delivers the message with `harness.execute()` and reads the response.
2. While the response is parked, `step.waitForEvent('wait-<n>', { type: TURN_WAKE_EVENT, timeout })` sleeps until the turn's deadline or a wake event. With no deadline it sleeps `maxWaitMs` (default 24 hours). A wait that times out is the deadline arriving, not an error.
3. Step `turn-<n>` calls `harness.wake({ threadId })` and reads the response. A turn woken with nothing to do parks again and the loop repeats.
4. It resolves `{ text }`, or `{ text: '', gone: true }` when there was no turn left to wake. A turn that is there but could not be woken, because another Worker holds its lease or is running it, is not gone: the step throws, and Workflows retries it.

`startTurn(binding, turn)` creates the instance under `turnInstanceId(threadId, messageId)`, so a message delivered twice starts one instance. The id is a readable part cut to fit, then `_` and a hash of the two ids as a pair, so `('a-b', 'c')` and `('a', 'b-c')` are different instances and the id is never over the 100 characters Workflows allows. `wakeTurn(binding, instanceId)` sends the wake event; Workflows keeps an event sent before the instance reaches its wait.

The Workflows preset has no object that is always there, so a `cron()` trigger needs something to start the harness at each tick: a Cloudflare Cron Trigger whose `scheduled` handler calls `harness.start()` and awaits `harness.waitForIdle()`.

The Workflow decides only when the harness runs. What a turn did is in the harness's storage, so a Workflow step that is retried, and a turn woken twice, replay from the step ledger and repeat nothing.

## Future Considerations

- **`@noetic/platform-deno` / `@noetic/platform-bun`**: if divergence between runtimes grows large enough, per-runtime packages with their own adapter implementations may land. The current `createLocalFsAdapter` works under Bun via Node API compatibility, so this is not yet needed.
- **Native OPFS / IndexedDB adapters**: `@noetic/platform-browser` today re-exports in-memory adapters. A standalone `createOpfsFsAdapter` may be added once a consumer needs an OPFS-backed filesystem.
- **Worker-side adapters**: Web Worker and Service Worker environments may warrant a third `@noetic/platform-worker` package if their API surface diverges enough from the main-thread browser runtime. Current assumption: browser platform package covers them.
