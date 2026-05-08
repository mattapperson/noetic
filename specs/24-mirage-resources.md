# Mirage-backed Virtual Filesystem

> **Depends On:** `08-runtime` (AgentHarness, FsAdapter, ShellAdapter), `09-error-model` (NoeticError), `25-platform-packages` (platform package layout)
> **Exports:** `createMirageAdapters`, `MirageAdaptersOpts`, `MirageAdapters`, `MirageError`, `isMirageError`, `MirageErrorKind` — exported by `@noetic/mirage`
> **Source of truth:** `packages/mirage/src/`
> **Docs:** `packages/web/content/docs/framework/virtual-filesystem.mdx`

---

## Overview

Noetic agents can run against a unified virtual filesystem that mounts heterogeneous backends (local disk, RAM, OPFS, S3, GitHub, Slack, Notion, Postgres, Redis, SSH, …) behind the existing `FsAdapter` and `ShellAdapter` contracts. One harness can read, write, grep, and pipe across every mount without tool code or agent prompts changing per backend.

The VFS is produced by `createMirageAdapters({ workspace })`, which wraps a caller-constructed Mirage workspace and returns `FsAdapter` and `ShellAdapter` implementations that delegate to it. Mirage is the in-process engine; Noetic owns the adapter surface the harness consumes.

`createMirageAdapters` lives in `@noetic/mirage` — a dedicated peer-tier package, separate from the platform packages. The bridge is runtime-neutral: it types against a structural `MirageWorkspace` contract (Mirage's `execute(command, options)` surface, the same in every Mirage runtime package) and does no dynamic imports. Consumers pass in a `Workspace` they constructed from the runtime package of their choice.

- `@struktoai/mirage-node` — Node.js backends (Disk, SSH, Postgres, S3, …).
- `@struktoai/mirage-browser` — browser / edge backends (OPFS, in-memory, HTTP-fetch).
- `@struktoai/mirage-core` — the structural workspace contract; shared by both.

## Mount Model

Mirage workspaces mount resources at POSIX-style paths. Noetic inherits that convention unchanged — the adapter performs no path rewriting.

Node example:

```typescript
import { Workspace, Disk, S3Resource, GitHubResource } from '@struktoai/mirage-node';
import { createMirageAdapters } from '@noetic/mirage';
import { AgentHarness } from '@noetic/core';

const workspace = new Workspace({
  '/local':  new Disk({ root: process.cwd() }),
  '/s3':     new S3Resource({ bucket: 'logs' }),
  '/gh':     new GitHubResource({ auth }),
});

const { fs, shell } = createMirageAdapters({ workspace, defaultCwd: '/local' });

const harness = new AgentHarness({
  config: { name: 'researcher', params: {}, fs, shell },
});
```

Browser example:

```typescript
import { Workspace, OPFSResource, RAMResource } from '@struktoai/mirage-browser';
import { createMirageAdapters } from '@noetic/mirage';

const workspace = new Workspace({
  '/fs':   new OPFSResource({ root: 'agent-scratch' }),
  '/ram':  new RAMResource(),
});

const { fs, shell } = createMirageAdapters({ workspace, defaultCwd: '/fs' });
```

The VFS *is* the filesystem the agent sees. There is no implicit escape hatch to the real host root; host access is explicit — mount `Disk` (Node) or `OPFSResource` (browser) at a chosen prefix.

`cwd` is a VFS path. `rootCwdState` defaults to `defaultCwd` when the harness is constructed with Mirage-backed adapters and no `initialCwd`. The existing `cd` interception in the Bash tool operates unchanged because the cwd is still a string path.

## `FsAdapter` Mapping

`createMirageAdapters` returns an `FsAdapter` that preserves the 15-method contract from `08-runtime` exactly. Each method dispatches through `workspace.execute(cmd)` — Mirage's tree-sitter bash executor routes the command to the correct per-mount resource handler.

| `FsAdapter` method   | Implementation                                                     |
|----------------------|--------------------------------------------------------------------|
| `readFile`           | `cat <path>` → detached `Buffer` copy (no aliasing of workspace memory) |
| `readFileText`       | `cat <path>` → UTF-8 decode                                        |
| `writeFile`          | `cat > <path>` with content as stdin                               |
| `writeFileBytes`     | `base64 -d > <path>` with base64-encoded bytes as stdin            |
| `appendFile`         | `cat >> <path>` with content as stdin                              |
| `mkdir`              | `mkdir -p <dir>`                                                   |
| `rename`             | `mv <old> <new>`                                                   |
| `rm`                 | `rm [-r] [-f] <path>`                                              |
| `access`             | `test -e <path>`                                                   |
| `stat` / `lstat`     | `stat [-L]c '%s %F' <path>`                                        |
| `readdir`            | `ls -1A <path>`                                                    |

Binary safety is non-negotiable: `readFile` returns a detached `Buffer.from(result.stdout.slice())` so pooled workspace buffers cannot leak into caller code, and `writeFileBytes` round-trips through base64 because Mirage's `execute({ stdin: string })` contract only preserves ASCII-safe bytes across the stdin channel.

When Mirage publishes a direct file-level API surface upstream, the hot methods (`readFile`, `writeFileBytes`, `stat`) switch to native resource calls without a call-site change.

## Error Model

All non-zero exits surface as `MirageError` — a typed error class local to `@noetic/mirage`, distinct from core's `NoeticError` union. Two kinds:

- `io_failed` — generic non-zero exit (most common).
- `resource_op_unsupported` — the backend's per-mount handler does not implement the operation. Detected conservatively: `exit 127` OR stderr containing `"command not found"` OR `"not implemented"`. Bare `"not supported"` / `"operation not supported"` substrings are deliberately NOT matched, because they appear in legitimate `io_failed` errors (e.g. `chmod: not supported on this filesystem`, `nfs: operation not supported by server`) where the op IS implemented but the backend is refusing this specific call. Resource authors who need to signal "unsupported" should emit exit 127 or include `"not implemented"` in stderr.

`MirageError` carries `operation`, `path`, `exitCode`, and `stderr` fields. `isMirageError(e)` narrows for consumer try/catch. Splitting these out from `NoeticError` keeps the Mirage bridge's failure modes local to its own package — core has zero knowledge of Mirage-specific failure kinds.

## `ShellAdapter` Mapping

The shell adapter delegates to `workspace.execute(command, options)`. Mirage's tree-sitter bash parser routes each command to the per-mount handler, which makes cross-mount pipelines first-class:

```
cat /s3/reports/2026-05.csv | grep alert | head > /local/digest.txt
```

Mapping notes:

- `cwd`, `env`, `stdin`, `signal` pass through unchanged.
- `timeout` is enforced by racing the `execute` promise against an internally-armed `AbortController`; on expiry the adapter rejects with `TIMEOUT_ERROR_PREFIX${seconds}` per the existing shell-adapter contract.
- `onData` receives stdout as a single Buffer on completion when Mirage buffers the result; when Mirage exposes an incremental stdout surface upstream, this adapter will promote to streaming with no call-site change.
- Exit codes follow Unix conventions: zero on success, non-zero on failure, `null` when the command was killed by signal or timeout.
- No real subprocess is spawned. `rtk` wrapping (from `createLocalShellAdapter`) does not apply — Mirage's executor is already model-friendly.

## Public API

```typescript
// @noetic/mirage
import type { FsAdapter, ShellAdapter } from '@noetic/core';

interface MirageExecuteOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  signal?: AbortSignal;
}

interface MirageExecuteResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number | null;
}

interface MirageWorkspace {
  execute(command: string, options?: MirageExecuteOptions): Promise<MirageExecuteResult>;
}

interface MirageAdaptersOpts {
  workspace: MirageWorkspace;
  defaultCwd?: string;
}

interface MirageAdapters {
  readonly fs: FsAdapter;
  readonly shell: ShellAdapter;
  readonly workspace: MirageWorkspace;
  readonly defaultCwd: string;
}

function createMirageAdapters(opts: MirageAdaptersOpts): MirageAdapters;

type MirageErrorKind = 'io_failed' | 'resource_op_unsupported';
class MirageError extends Error {
  readonly kind: MirageErrorKind;
  readonly operation: string;
  readonly path: string;
  readonly exitCode: number | null;
  readonly stderr: string;
}
function isMirageError(value: unknown): value is MirageError;
```

`MirageWorkspace` is a structural type — Noetic does not re-export Mirage's `Workspace` class. Consumers import the concrete `Workspace` from whichever runtime package they chose (`@struktoai/mirage-node` or `@struktoai/mirage-browser`) and pass the instance in. The factory's signature accepts any object satisfying the structural contract.

The `workspace` field on the return value echoes the input so callers who only keep a reference to the adapter pair can still invoke Mirage-specific features (custom commands, snapshot/clone, direct `execute`) without threading a second variable. Tool authors stay on `fs` / `shell`.

## Peer-Dependency Posture

`@noetic/mirage` declares all three Mirage packages as optional peer dependencies, each pinned to an exact version:

- `@struktoai/mirage-core` — type-only dependency; the structural contract the factory accepts.
- `@struktoai/mirage-node` — runtime peer for Node callers.
- `@struktoai/mirage-browser` — runtime peer for browser / edge callers.

Consumers install exactly one runtime package (plus the core types) alongside `@noetic/mirage`. Bundlers resolve only the matching runtime and tree-shake the others. Harnesses that do not call `createMirageAdapters` never pull any Mirage package into their bundle.

`createMirageAdapters` performs no dynamic imports — the `Workspace` arrives pre-constructed from whichever runtime package the caller chose. That keeps the factory fully isomorphic and lets bundlers resolve Mirage statically. When the caller's environment lacks Mirage, the error surfaces at their `import` site, not inside Noetic.

Mirage's own optional peers gate specific capabilities:

- `@zkochan/fuse-native` (Node only) — required only when a Mirage workspace is exported as a FUSE mount.
- `sherpa-onnx-node` (Node only) — required only for audio-content resources.

Users opt into those separately; `@noetic/mirage` does not re-declare them.

## Scope

Included:

- `createMirageAdapters` factory, `FsAdapter` and `ShellAdapter` implementations, VFS path helpers, `MirageError` + type guard.
- Parity with `createLocalFsAdapter` / `createLocalShellAdapter` for the Node `Disk` mount, verified by the same contract tests.
- Unit coverage via an in-memory `MirageWorkspace` stub (no network, deterministic, runs under Bun and Node test runners).
- Live contract test for `S3Resource`, skipped without `MIRAGE_S3_TEST=1`.

Excluded from the initial surface:

- Per-resource factory wrappers. Users construct Mirage resources directly — the value of adopting Mirage is inheriting its backend catalogue without re-exporting it.
- Checkpoint integration with Mirage's snapshot/clone. Checkpoints (`23-durable-execution`) persist the harness frontier and item log; Mirage snapshots persist backend state. Composition is a separate design.
- FUSE export. Mirage's FUSE surface is available via the `workspace` escape hatch for users who need host-tool interop, but Noetic does not mount FUSE from the harness by default.
- Replacement of `createLocalFsAdapter` / `createLocalShellAdapter`. Those remain the zero-dependency default for harnesses that do not need a VFS.

## Default Harness Behaviour

A harness constructed with no `fs` / `shell` option keeps the existing local adapters. Mirage-backed adapters are strictly opt-in: they are produced by an explicit `createMirageAdapters` call and passed through `AgentConfig.fs` / `AgentConfig.shell`.

## Future Considerations

- **Streaming `execute`**: once Mirage exposes an incremental stdout surface, the shell adapter's `onData` promotes from buffered to streaming without a call-site change.
- **Resource-aware tools**: today's FS tools are resource-agnostic by design. A follow-up may expose resource metadata (backend kind, content type) through a typed lookup on the workspace so tools can adapt formatting (e.g. parquet column summaries).
- **Snapshot/clone surfaces**: a harness-level wrapper that fans Mirage snapshots in and out of the checkpoint store would make agent sessions bit-reproducible across workspace state.
- **Multi-workspace agents**: a single harness today binds to a single workspace. A future design may allow per-session workspace overrides for multi-tenant runners.
