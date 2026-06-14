# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All scripts run from the repo root unless noted.

- `bun install` — install workspace deps (postinstall patches `@openrouter/agent`)
- `bun test` — runs `@noetic-tools/types`, `@noetic-tools/memory`, `@noetic-tools/core`, `@noetic-tools/code-agent`, `@noetic/eval` suites **sequentially** (does NOT include `@noetic-tools/cli`)
- `bun test:ci` — same plus coverage enforcement (diff gate from baseline)
- `bun run lint` / `bun run lint:fix` — biome
- `bun scripts/check-export-tags.ts` — validates `@public` JSDoc tags on core's entry points
- `cd packages/core && bun run gen:schema` — regenerate the published JSON Schema for dynamic workflows from `WorkflowDocumentSchema`. **MUST run (same commit) whenever you change the JSON-workflow Zod schema in `packages/core/src/schemas/workflow.ts`** — it rewrites both the package artifact (`packages/core/schema/noetic-workflow.schema.json`) and the hosted copy (`packages/web/public/schema/noetic-workflow.schema.json`, served at the schema's `$id`). A drift-gate test fails CI if either is stale. Never hand-edit the generated `*.schema.json` files. See `.claude/rules/sync-spec-code-docs.md` Requirement 6.

In-workspace consumers resolve `@noetic-tools/types`, `@noetic-tools/memory`, and `@noetic-tools/core` straight to `src/*.ts` via the `bun` export condition (tsc matches it through `customConditions`), so no build step is needed for tests, typecheck, or the CLI — a stale `dist/` cannot break the workspace. Only `packages/web` (webpack) still consumes `dist/`; run `bun run build` in those three packages before building web. Published tarballs strip the `bun` conditions via `scripts/strip-dev-conditions.ts` in `prepublishOnly`.

Per-package (`cd packages/<name>`):
- `bun test` — package test suite
- `bun test <path/to/file.test.ts>` — single file
- `bun run typecheck` — `tsc --noEmit`
- `cd packages/cli && bun run dev` — run the CLI from source
- `cd packages/cli && bun run test:e2e` — TUI end-to-end tests (separate from unit tests)

Architecture gates:
- `sentrux check .` — validate `.sentrux/rules.toml` layer + boundary rules
- `sentrux gate .` — quality regression check against the committed `.sentrux/baseline.json`. Runs automatically via `SessionStart` + `Stop` hooks; invoke manually to debug.

## Architecture big picture

Workspace packages under `packages/*`. Dependency direction (arrows = "depends on"):

```
plugins ──→ cli ──→ code-agent ──→ core ←── eval
                                       │
                                       └──→ memory ──→ types ←── sub-harness ←── sub-harness-{claude-code,codex,opencode,pi}
                                                 └───────────↗
web (standalone — no workspace deps)
```

- **`@noetic-tools/types`** — the dependency-free foundation: the conversation `Item` data model, LLM config (`LlmProviderConfig`, `ModelParams`, `LLMResponse`), execution context + steering contracts, the `MemoryLayer` contract (also exported at the `./contract` subpath), platform adapter interfaces, the error model, and the `Item` schema. Imported by `memory` and `core`; depends on nothing in the workspace.
- **`@noetic-tools/memory`** — the memory layer system: lifecycle, budget/projection machinery (`assembleView`, `allocateBudgets`, layer state stores, scoping), and the built-in layers (working/history/observational/plan/temporal/steering/file-reference/static-content/durable-task-state/tool). Depends only on `@noetic-tools/types`; re-exports the `MemoryLayer` contract so it is the one-stop import for memory-layer authoring. Must stay free of imports from `core` (acyclic + tree-shakable).
- **`@noetic-tools/core`** — step primitives (`Step<I,O>` discriminated union), interpreter, runtime, error model, observability. Re-exports the public surface of `@noetic-tools/memory` and `@noetic-tools/types`, so its `.`, `/portable`, `/unstable`, and `/internal/test` entry points are unchanged for consumers. Internal order (foundational → consumer): `types/schemas/errors` → `observability` → `builders/conditions/until` → `runtime` → `interpreter` → `adapters` → `patterns`.
- **`@noetic-tools/sub-harness`** — base contract + helpers for coding-agent sub-harnesses (Claude Code, Codex, opencode, pi). Re-exports the `SubHarness` contract from `@noetic-tools/types` and adds `defineSubHarness`, the turn accumulator, registry, item builders, and error types. Depends only on `@noetic-tools/types`. **`@noetic-tools/core` must never import this package or any `sub-harness-*` adapter** — it resolves adapters from the types contract + a runtime registry, so no agent SDK enters core's dependency graph (enforced by `.sentrux/rules.toml`). See `specs/27-sub-harness-steps.md`.
- **`@noetic-tools/sub-harness-{claude-code,codex,opencode,pi}`** — one adapter per coding agent; each exports a factory (`claudeCode()` etc.) returning a `SubHarness`, backed by the vendor SDK as an optional peer dependency. Used via `step.claudeCode(...)` or a `claude-code` JSON workflow node.
- **`@noetic-tools/code-agent`** — tool implementations, plugin registry, skills, tasks, LSP, git worktree integration.
- **`@noetic-tools/cli`** — Ink-based TUI harness. Six internal layers per `specs/22-cli-architecture.md`: `foundations → infra → domain → orchestration → presentation → entry`.
- **`@noetic/eval`** — eval framework, scorers, GEPA optimization, regression.
- **`@noetic/plugin-*`**, **`@noetic/web`** — peer/consumer packages.

`specs/` is the source of architectural truth. `specs/00-overview.md` has the package graph and the numbered specs (`01-step-type` through `22-cli-architecture`) each map to a concrete source directory (see `.claude/rules/sync-spec-code-docs.md` for the table). Runtime code must stay consistent with its spec.

## `.sentrux/rules.toml` — MUST update when

Architectural boundaries are machine-enforced by sentrux. The `Stop` hook runs `sentrux gate .` after every agent turn and regressions block cleanly; `sentrux check .` validates every layer and boundary rule. **These changes REQUIRE a corresponding edit to `.sentrux/rules.toml` in the same commit:**

1. **Adding a new package** under `packages/` → add a `[[layers]]` entry at the correct order tier. If the new package is a consumer of existing ones but must not be imported *by* them, add `[[boundaries]]` forbidding the reverse edges.
2. **Adding a major feature that introduces a new top-level directory** inside `packages/core/src/` or `packages/cli/src/` → assign the directory to the correct layer via its `paths` glob.
3. **Splitting, renaming, or moving an existing layer directory** → update the affected `[[layers]]` `paths` entries so the mapping stays accurate.
4. **Introducing a tree-shakability, isolation, or platform-independence invariant for new code** (e.g. a new memory layer, a new platform adapter, a new peer package that must stay isolated from siblings) → add a `[[boundaries]]` entry with a `reason` string that explains *why* the edge is forbidden. Every `[[boundaries]]` entry must have a `reason`.

Sentrux's ordering semantics (empirical, confirmed against the installed CLI — contradicts some upstream docs): **lower `order` = higher in the stack (consumer); higher `order` = foundational.** A file in a lower-order layer may import from higher-order layers; reverse edges are violations. Same-order siblings are otherwise unconstrained, so peer isolation requires explicit `[[boundaries]]`.

After editing, run `sentrux check .` and confirm no *new* violations appear beyond those already present on `main`. Commit the `.sentrux/rules.toml` change alongside the feature — never in a follow-up.

## agent-ci

- Use `npx @redwoodjs/agent-ci run --quiet --workflow .github/workflows/<workflow-name>.yml` to run CI locally
- When a step fails, the run pauses automatically. Use `npx @redwoodjs/agent-ci retry --name <runner>` to retry after fixing the failure
- Do NOT push to trigger remote CI when agent-ci can run it locally — it's instant and free
- CI was green before you started. Any failure is caused by your changes — do not assume pre-existing failures
- Use `--no-matrix` to collapse matrix jobs into a single run when you don't need full matrix coverage

## Terminal Automation

Use `pilotty` for TUI automation. Run `pilotty --help` for all commands.

Core workflow:
1. `pilotty spawn <command>` - Start a TUI application
2. `pilotty snapshot` - Get screen state with cursor position
3. `pilotty key Tab` / `pilotty type "text"` - Navigate and interact
4. Re-snapshot after screen changes
