# Platform Packages

> **Depends On:** `08-runtime` (FsAdapter, ShellAdapter, SubprocessAdapter, createLocal* factories), `23-durable-execution` (durable IPC, agent-ipc, step-bootstrap)
> **Exports:** (per-package, see below)
> **Source of truth:** `packages/platform-node/src/`, `packages/platform-browser/src/`
> **Docs:** `packages/web/content/docs/framework/platform-packages.mdx`

---

## Overview

`@noetic-tools/core` is the minimal, runtime-agnostic package. It defines the `FsAdapter`, `ShellAdapter`, `SubprocessAdapter`, and `StorageAdapter` contracts, and ships **in-memory adapters only** as built-in implementations. Every concrete backend that requires a specific runtime — Node's `fs/promises`, `child_process`, unix sockets, IPC framing, or browser APIs like OPFS — lives in a platform package.

Two platform packages ship:

- **`@noetic/platform-node`** — Node.js ≥ 20 backends: local filesystem, local shell, local subprocess (OS child-process lifecycle, POSIX signals, unix-domain-socket IPC), durable outbound queue, agent-ipc client/server, step bootstrap entry, file-backed storage.
- **`@noetic/platform-browser`** — Browser, Cloudflare Worker, and Vercel Edge adapter glue. Currently re-exports core's runtime-neutral in-memory adapters for ergonomic imports; native OPFS / IndexedDB adapters are a future consideration (see below).

Each platform package declares only the peer dependencies relevant to its runtime. A consumer targeting Node installs `@noetic/platform-node`; a consumer targeting a browser installs `@noetic/platform-browser`. Neither pulls dependencies from the other, so bundle size stays proportional to the chosen runtime.

The Mirage-backed virtual filesystem is **not** in either platform package — it lives in a dedicated `@noetic/mirage` peer package (see `24-mirage-resources`). The bridge is runtime-neutral and types against Mirage's structural `Workspace` contract; consumers pair it with whichever runtime-specific Mirage package (`@struktoai/mirage-node` or `@struktoai/mirage-browser`) matches their target.

## Motivation

Prior to this split, Node-only code lived inside `@noetic-tools/core` under the `@noetic-tools/core/adapters/node` subpath export. Browser consumers either imported that subpath (and paid for `node:child_process` bundler shims) or hand-rolled their own adapters. Each package now carries exactly the deps it needs:

- `@noetic-tools/core` — zero runtime-specific deps, zero third-party peers beyond `zod` and the OpenRouter SDK. Safe in every environment. Exports only contracts, in-memory adapters, and the agent harness.
- `@noetic/platform-node` — Node APIs only (`node:fs/promises`, `node:child_process`, `node:net`, `node:path`). No Mirage peer — the Mirage bridge lives in `@noetic/mirage`.
- `@noetic/platform-browser` — web platform APIs only (`navigator.storage`, `BroadcastChannel`, `fetch`); no `node:*` imports. No Mirage peer — the bridge lives in `@noetic/mirage`.

Consumers opt into the surface they want. Test suites that need the Node subprocess adapter add `@noetic/platform-node` to their devDependencies; code-agent and cli (which are Node-only by nature) depend on it directly. Browser apps and edge workers depend on `@noetic/platform-browser`. Runtime-agnostic consumers (eval, chat-sdk) stay on `@noetic-tools/core` alone and inject whichever adapters the caller supplies.

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

// Harness, interpreter, memory, builders — unchanged
export { AgentHarness, /* … */ } from './harness/agent-harness';
```

Peer dependencies after the split:

- `zod`, `@openrouter/agent` (unchanged).
- No Mirage peers.
- No runtime-specific peers (no `@struktoai/mirage-*`, no Node-only packages).

### `@noetic/platform-node`

Exports (all stable):

```typescript
// Filesystem, shell, subprocess
export { createLocalFsAdapter } from './local-fs-adapter';
export { createLocalShellAdapter } from './local-shell-adapter';
export { createLocalSubprocessAdapter } from './local-subprocess-adapter';

// Durable execution glue
export { createFileStorage } from './file-storage';
export { createDurableOutboundQueue } from './durable-outbound-queue';

// Per-task IPC (see 08-runtime § Per-Task IPC for Live Chat)
export { createAgentIpcServer } from './agent-ipc-server';
export { createAgentIpcClient } from './agent-ipc-client';
export { AgentIpcProtocol } from './agent-ipc-protocol';

// Subprocess step bootstrap entry
export { runStepBootstrap } from './step-bootstrap';
```

Peer dependencies: none. Runtime imports: Node built-ins only (`node:fs/promises`, `node:child_process`, `node:net`, `node:path`, `node:os`, `node:crypto`). No third-party Node deps at runtime. For a Mirage-backed VFS, install `@noetic/mirage` alongside `@struktoai/mirage-node` — the bridge is consumed directly, not re-exported through this package.

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

Peer dependencies: none. Runtime imports: browser platform APIs only. No `node:*` imports — bundlers targeting browsers succeed without polyfills. For a Mirage-backed VFS, install `@noetic/mirage` alongside `@struktoai/mirage-browser`.

### Migrating `@noetic-tools/core/adapters/node`

The existing `@noetic-tools/core/adapters/node` subpath export is removed. Consumers update imports:

```diff
- import { createLocalFsAdapter } from '@noetic-tools/core/adapters/node';
+ import { createLocalFsAdapter } from '@noetic/platform-node';
```

## Dependency Direction

```
@noetic/plugin-*  ──→  @noetic/cli  ──→  @noetic/code-agent  ──┐
                                                                ├──→  @noetic/platform-node  ──→  @noetic-tools/core
                                                                │                                     ↑
                                                                └─────────────────────────────────────┘
                                                                                                      ↑
browser/edge consumer  ──→  @noetic/platform-browser  ─────────────────────────────────────────────────┘
                                                                                                      ↑
@noetic/eval, @noetic/chat-sdk  ──────────────────────────────────────────────────────────────────────┘
```

- `@noetic-tools/core` has no dependency on either platform package.
- Platform packages depend only on `@noetic-tools/core` (plus their runtime's built-ins and any declared peers).
- Node-only consumers (`@noetic/cli`, `@noetic/code-agent`, `@noetic/plugin-*`) depend on `@noetic/platform-node`.
- Runtime-agnostic consumers (`@noetic/eval`, `@noetic/chat-sdk`) depend only on `@noetic-tools/core` and inject whichever adapters they need via their API surface.
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

Memory layer boundaries extend to forbid importing platform packages directly:

```toml
[[boundaries]]
from = "packages/core/src/memory/**"
to = "packages/platform-node/**"
reason = "memory layers are platform-independent; platform packages are platform-specific"

[[boundaries]]
from = "packages/core/src/memory/**"
to = "packages/platform-browser/**"
reason = "memory layers are platform-independent; platform packages are platform-specific"
```

## Migration Path

The split replaces the `@noetic-tools/core/adapters/node` subpath export with `@noetic/platform-node`. There is no transitional shim: callers update their imports in a single pass.

Mechanical migration:

1. Replace `from '@noetic-tools/core/adapters/node'` with `from '@noetic/platform-node'` in every import.
2. Add `@noetic/platform-node` (or `@noetic/platform-browser`) to the package's `dependencies`.
3. For a Mirage-backed VFS, import `createMirageAdapters` from `@noetic/mirage` directly (not from a platform package). Keep `@struktoai/mirage-node` or `@struktoai/mirage-browser` in the consumer's `dependencies` exactly as before.

`@noetic/code-agent` and `@noetic/cli` migrate in lockstep with the package creation because they consume the Node adapters directly. `@noetic/eval` and `@noetic/chat-sdk` do not import Node adapters today; their migration is a documentation update only.

## Tree-shakability Guarantees

- Importing `@noetic-tools/core` into a browser bundle must produce no `node:*` references in the output. Enforced by a CI test that bundles `@noetic-tools/core` with a browser target and fails on any `node:` specifier.
- Importing `@noetic/platform-browser` similarly produces no `node:*` references.
- Importing `@noetic/platform-node` may reference `node:*`; bundling for a browser target surfaces the mismatch as a build-time error, which is the desired behaviour.

## Future Considerations

- **`@noetic/platform-deno` / `@noetic/platform-bun`**: if divergence between runtimes grows large enough, per-runtime packages with their own adapter implementations may land. The current `createLocalFsAdapter` works under Bun via Node API compatibility, so this is not yet needed.
- **Native OPFS / IndexedDB adapters**: `@noetic/platform-browser` today re-exports in-memory adapters and provides Mirage-browser helpers. A standalone `createOpfsFsAdapter` may be added once a consumer needs an OPFS-backed filesystem without going through Mirage.
- **Worker-side adapters**: Web Worker and Service Worker environments may warrant a third `@noetic/platform-worker` package if their API surface diverges enough from the main-thread browser runtime. Current assumption: browser platform package covers them.
