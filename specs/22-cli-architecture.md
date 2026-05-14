# CLI Architecture

> **Depends On:** `08-runtime` (`AgentHarness`), `21-tasks` (task lifecycle)
> **Exports:** (none — internal layering spec)
> **Source of truth:** `packages/cli/src/`
> **Docs:** (TBD)

---

## Purpose

The `@noetic/cli` package is a TUI harness that composes a `@noetic-tools/core`
`AgentHarness` with an Ink-rendered user interface, session persistence,
tool routing, plugin loading, and skill discovery. It is the reference
consumer of `@noetic-tools/core` and the host for the built-in tasks system
(spec `21-tasks`).

## Layer hierarchy

The CLI is organized into six layers, listed from top of stack (consumers)
to bottom of stack (foundations):

| Layer               | Role |
|---------------------|------|
| `cli-entry`         | Process entrypoint: argv parsing, config discovery, top-level lifecycle. |
| `cli-presentation`  | Ink/React TUI components, screens, and input handling. |
| `cli-orchestration` | Composes the domain layer into running sessions: harness wiring, session persistence, planning flow, daemon runtime. |
| `cli-domain`        | Business capabilities: tool implementations, teammate agents, skills, plugin contract, built-in commands. |
| `cli-infra`         | External-system adapters: LSP client, AI provider, config loader, CLI-local memory layers. |
| `cli-foundations`   | Pure types, errors, shared utilities. No side effects, no I/O. |

## Subdirectory map

Every directory under `packages/cli/src/` belongs to exactly one layer.

| Directory          | Layer               |
|--------------------|---------------------|
| `cli/`             | `cli-entry`         |
| `tui/`             | `cli-presentation`  |
| `harness/`         | `cli-orchestration` |
| `sessions/`        | `cli-orchestration` |
| `plan/`            | `cli-orchestration` |
| `daemon-runtime/`  | `cli-orchestration` |
| `tools/`           | `cli-domain`        |
| `agents/`          | `cli-domain`        |
| `skills/`          | `cli-domain`        |
| `plugins/`         | `cli-domain`        |
| `commands/`        | `cli-domain`        |
| `tasks/`           | `cli-domain`        |
| `adapters/`        | `cli-infra`         |
| `ai/`              | `cli-infra`         |
| `lsp/`             | `cli-infra`         |
| `config/`          | `cli-infra`         |
| `memory/`          | `cli-infra`         |
| `types/`           | `cli-foundations`   |
| `errors/`          | `cli-foundations`   |
| `util/`            | `cli-foundations`   |

## Dependency rules

1. A file in any layer may import from layers below it in the stack
   (e.g. `cli-entry` may import from `cli-presentation`, `cli-domain`,
   `cli-foundations`, etc.).
2. A file must not import from layers above it (e.g. `cli-infra` must not
   import from `cli-orchestration`).
3. Same-layer imports are allowed.
4. The only permitted cross-package workspace dependencies for the CLI are
   `@noetic-tools/core` and `@noetic/code-agent`, per `specs/00-overview.md` and
   the CLI's `package.json`.

Sentrux enforces rules 1–3 via the `[[layers]]` ordering in
`.sentrux/rules.toml`; rule 4 is enforced by the CLI's `package.json`
workspace-dep list.

## Subprocess adapter wiring

The CLI instantiates exactly one `SubprocessAdapter` per harness and one
additional adapter inside the hierarchy daemon. Both are built against
`createFileStorage({root: resolveSubprocessRoot()})` so every long-lived
child (planner, implementer, agent-ci, TUI teammates) shares one durable
handle manifest. The root resolution function lives in
`packages/code-agent/src/tasks/paths.ts` (`resolveSubprocessRoot`) and
defaults to `$HOME/.noetic/subprocess`.

| Constructor site | File | Purpose |
|---|---|---|
| TUI harness | `packages/cli/src/harness/factory.ts` (`buildHarness`) | Every interactive session's spawns go through this adapter. |
| Daemon harness | `packages/cli/src/tasks/runtime/hierarchy/daemon-bootstrap.ts` | Autopilot plan-pass and implement-pass spawns. |
| CLI commands | `packages/cli/src/tasks/runtime/cli.ts`, `packages/cli/src/tasks/runtime/tools.ts` | Ad-hoc `noetic tasks` runs that need to spawn a planner/implementer or consult the live handle list. |

### Separation of roots

Three on-disk concerns live under three distinct roots so crash-recovery
tooling can locate them without guessing:

| Concern | Default root | Used by |
|---|---|---|
| Subprocess handle manifests | `$HOME/.noetic/subprocess/` | `SubprocessAdapter.reattach` / `listLive` |
| Checkpoint snapshots | `$HOME/.noetic/checkpoints/` | `harness.checkpoint` / `harness.restore` via `CheckpointStore` |
| Task state (canonical, per-project) | `<projectRoot>/.noetic/tasks/` | FS-only task store (see `21-tasks`) |

Subprocess manifests and checkpoints are machine-wide; task state is
per-project and tracked in git if the project chooses. Keeping them
separate means a host can reattach to a running planner whose task
state lives on a different filesystem root (a worktree, a remote mount)
from the manifest.

### Host restart recovery

The TUI boot sequence in `packages/cli/src/tui/app.tsx` calls
`reattachLiveChildren(harness)` (`packages/cli/src/cli/reattach-live-children.ts`)
once per harness construction. That helper calls `harness.subprocess.listLive()`,
walks each handle carrying an `executionId`, invokes `harness.restore(executionId)`,
and returns a `Map<handleId, Context>` so the TUI can target each restored
context with its pending ask-user replay.

### Post-sidecar flows

Several flows previously keyed on `<taskDir>/_planner.json` /
`_implementer.json` sidecar reads. After the Phase F rewrite they key
on the adapter's manifest:

| Flow | Source | Behaviour |
|---|---|---|
| Delete-guard (`task delete`) | `packages/cli/src/tasks/runtime/handlers/lifecycle.ts` via `listLiveTaskHandles(adapter, taskId)` | Refuses deletion when any handle tagged with the task id is live. |
| Resolve chat target (TUI / CLI chat) | `packages/cli/src/tui/task-chat/use-task-chat.ts` | Uses `findLiveTaskHandle({adapter, taskId, taskRole})` to locate the right socket for live chat. |
| Pause / cancel | `packages/cli/src/tasks/runtime/handlers/state.ts` | Consult the adapter's handle (and its `metadata.executionId`) instead of reading sidecar JSON. |

## Non-goals

- This spec does not constrain which external npm dependencies each layer
  may pull in. That is left to code review.
- This spec does not partition the contents of individual directories —
  e.g. `packages/cli/src/commands/**` is treated as one unit even though
  built-in commands have subtrees of their own.

## Future Considerations

- The `tasks` system now lives under `packages/cli/src/tasks/` as a
  `cli-domain` module. Runtime hosts such as `cli/`, `tui/`, `harness/`, and
  `daemon-runtime/` may compose it, but `tasks/` must not import from those
  higher layers.
- If planning (`plan/`) becomes general-purpose enough to serve consumers
  outside the CLI, it may move into `@noetic-tools/core`.
