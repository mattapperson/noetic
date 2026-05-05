# CLI Architecture

> **Depends On:** `08-runtime` (`AgentHarness`), `21-tasks` (task lifecycle)
> **Exports:** (none — internal layering spec)
> **Source of truth:** `packages/cli/src/`
> **Docs:** (TBD)

---

## Purpose

The `@noetic/cli` package is a TUI harness that composes a `@noetic/core`
`AgentHarness` with an Ink-rendered user interface, session persistence,
tool routing, plugin loading, and skill discovery. It is the reference
consumer of `@noetic/core` and the host for the built-in tasks system
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
   `@noetic/core` and `@noetic/code-agent`, per `specs/00-overview.md` and
   the CLI's `package.json`.

Sentrux enforces rules 1–3 via the `[[layers]]` ordering in
`.sentrux/rules.toml`; rule 4 is enforced by the CLI's `package.json`
workspace-dep list.

## Non-goals

- This spec does not constrain which external npm dependencies each layer
  may pull in. That is left to code review.
- This spec does not partition the contents of individual directories —
  e.g. `packages/cli/src/commands/**` is treated as one unit even though
  built-in commands have subtrees of their own.

## Future Considerations

- The `tasks` system under `packages/cli/src/commands/builtins/tasks/`
  currently spans both `cli-domain` and `cli-orchestration` concerns. If
  it grows further, it may warrant promotion to its own top-level `tasks/`
  directory with an explicit layer assignment.
- If planning (`plan/`) becomes general-purpose enough to serve consumers
  outside the CLI, it may move into `@noetic/core`.
