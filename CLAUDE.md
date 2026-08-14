# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All scripts run from the repo root unless noted.

- `bun install` — install workspace deps (postinstall patches `@openrouter/agent`)
- `bun test` — runs the package suites **sequentially** in this order: `types → context → openui → acp → chat-sdk → core → eval → inspector`. `platform-node` and `platform-browser` have their own `test` scripts but are **not** in the root chain — run them per-package.
- `bun test:ci` — same plus coverage enforcement (diff gate from baseline)
- `bun run lint` / `bun run lint:fix` — biome
- `bun run check:exports` — validates `@public` JSDoc tags on core's entry points (`bun scripts/check-export-tags.ts`)
- `bun run typecheck:examples` — typechecks the root `examples/` project
- `bun run example:acp` — runs `examples/acp-e2e.ts` (set `ACP_LIVE_AGENT=1` for the live spawned-agent path; add `OPENROUTER_API_KEY` for the live model→agent delegation path)
- `bun run inspect` — starts the inspector host (`packages/inspector/server/host.ts`)
- `cd packages/core && bun run gen:schema` — regenerate the published JSON Schema for dynamic workflows from `WorkflowDocumentSchema`. **MUST run (same commit) whenever you change the JSON-workflow Zod schema in `packages/types/src/schemas/workflow.ts` (core’s `schemas/workflow.ts` only re-exports it)** — it rewrites both the package artifact (`packages/core/schema/noetic-workflow.schema.json`) and the hosted copy (`packages/web/public/schema/noetic-workflow.schema.json`, served at the schema's `$id`). A drift-gate test fails CI if either is stale. Never hand-edit the generated `*.schema.json` files. See `.claude/rules/sync-spec-code-docs.md` Requirement 6.

In-workspace consumers resolve `@noetic-tools/types`, `@noetic-tools/context`, and `@noetic-tools/core` straight to `src/*.ts` via the `bun` export condition (tsc matches it through `customConditions`), so no build step is needed for tests or typecheck — a stale `dist/` cannot break the workspace. There is no root `build` script; each publishable package builds its own `dist/` via its own `bun run build` (`inspector`, `platform-node`, and `platform-browser` have none). Published tarballs strip the `bun` conditions via `scripts/strip-dev-conditions.ts` in `prepublishOnly`.

Per-package (`cd packages/<name>`):
- `bun test` — package test suite
- `bun test <path/to/file.test.ts>` — single file
- `bun run typecheck` — `tsc --noEmit` (every package has one)

Architecture gates:
- `sentrux check .` — validate `.sentrux/rules.toml` layer + boundary rules
- `sentrux gate .` — quality regression check against the committed `.sentrux/baseline.json`. Runs automatically via `SessionStart` + `Stop` hooks; invoke manually to debug.

## Architecture big picture

Workspace packages under `packages/*`. Dependency direction (arrows = "depends on"):

```
inspector ──→ platform-node ──→ core ──→ context ──→ types
                     eval ────→ core         ↑          ↑
         platform-browser ────→ core         │          │
                                   openui ───┘──────────┤
                                        chat-sdk ───────┤
                                             acp ───────┘

web (standalone — no workspace deps)
```

Every edge above is the complete set: `types` depends on nothing; `context`,
`chat-sdk`, and `acp` depend only on `types`; `openui` and `core` on `context` +
`types`; `eval`, `platform-node`, and `platform-browser` on `core`; `inspector`
on `core` + `platform-node`; `web` on nothing.

The 11 packages under `packages/`: `acp`, `chat-sdk`, `context`, `core`, `eval`,
`inspector`, `openui`, `platform-browser`, `platform-node`, `types`, `web`. Most
publish under the `@noetic-tools/` scope; `inspector`, `platform-browser`, and
`web` use `@noetic/`.

The Noetic CLI (`@noetic-tools/cli`), its code-agent tooling
(`@noetic-tools/code-agent`), and the `@noetic/plugin-*` packages are **not in
this repo** — they are developed in a separate monorepo
(`github.com/mattapperson/noetic-internal`). Never cite a `packages/cli/**` or
`packages/code-agent/**` source path here. Their authored docs still live in
this repo under `packages/web/content/docs/code-agent-cli/`.

- **`@noetic-tools/types`** — the dependency-free foundation: the conversation `Item` data model, LLM config (`LlmProviderConfig`, `ModelParams`, `LLMResponse`), execution context + steering contracts, the `ContextLayer` contract (also exported at the `./contract` subpath), platform adapter interfaces, the error model, and the `Item` schema. Imported by `context` and `core`; depends on nothing in the workspace.
- **`@noetic-tools/context`** — the context layer system: lifecycle, budget/projection machinery (`assembleView`, `allocateBudgets`, layer state stores, scoping), and the built-in layers (instructions/history/scratchpad/observations/temporal/steering/filesystem/plan/task-state/tool-calls). Depends only on `@noetic-tools/types`; re-exports the `ContextLayer` contract so it is the one-stop import for context-layer authoring. Must stay free of imports from `core` (acyclic + tree-shakable).
- **`@noetic-tools/core`** — step primitives (`Step<I,O>` discriminated union), interpreter, runtime, error model, observability. Re-exports the public surface of `@noetic-tools/context` and `@noetic-tools/types`, so its `.`, `/portable`, `/unstable`, and `/internal/test` entry points are unchanged for consumers. Internal order (foundational → consumer): `types/schemas/util` → `observability` → `builders/conditions/until` → `runtime` → `interpreter` → `adapters` → `harness`.
- **`@noetic-tools/acp`** — an [Agent Client Protocol](https://agentclientprotocol.com/) client: runs any ACP-speaking coding agent (Claude Code, Codex, Gemini CLI, …) as a step via `step.acpAgent(...)` or an `acp-agent` JSON workflow node. Owns the protocol library, capability negotiation, session/turn drivers, the client-side `fs/*` + `terminal/*` + permission handlers (backed by Noetic's own `FsAdapter`/`ShellAdapter`, with `fs/*` paths confined to the session cwd by default — note that a `permissions` policy does NOT gate `fs/*` or `terminal/*`, which are client methods the agent calls directly rather than tool calls it asks about), the transports, and the agent presets. The `.` entry is runtime-neutral; the Node stdio transport lives at `./stdio`. Depends only on `@noetic-tools/types`. **`@noetic-tools/core` must never import this package** — it resolves agents from the types contract + a runtime registry, so no protocol code is loaded at runtime by core (enforced by `.sentrux/rules.toml`). Note the npm graph is a different question: `@noetic-tools/types` takes the protocol package as a real dependency for its type re-exports, so installing core installs it — the import graph is clean, the dependency tree is not. See `specs/27-acp-agent-steps.md`.
- **`@noetic-tools/openui`** — generative UI via the OpenUI standard: the `openUi()` output codec (streaming OpenUI Lang parser), the `openUiSurface()` context layer, the typed `fragment()` builder for tool-authored UI, and an OpenUI-speaking transport at `./server`. Depends on `context` + `types` only; **core never imports it**. See `specs/28-generative-ui.md`.
- **`@noetic-tools/chat-sdk`** — chat-sdk.dev integration: run a harness as the brain of a multi-platform chat bot via `chat.onSubscribedMessage(noeticAgent(...))`. Depends only on `types`. See `specs/29-chat-platform-integration.md`.
- **`@noetic-tools/platform-node`** / **`@noetic/platform-browser`** — the platform adapter implementations. Core ships only contracts + in-memory adapters; `platform-node` adds the local fs/shell/subprocess adapters, file storage, the durable outbound queue, and the agent IPC client/server/protocol, while `platform-browser` re-exports core's runtime-neutral in-memory adapters with no `node:*` imports. Both depend on `core`. See `specs/25-platform-packages.md`.
- **`@noetic-tools/eval`** — eval framework, scorers, GEPA optimization, regression. Depends on `core`.
- **`@noetic/inspector`** — a local web inspector (Next.js + Monaco): edit agent TypeScript, chat with it, and watch per-layer state, the assembled context window, token composition, the plan graph, framework events, and traces. Depends on `core` + `platform-node`; run it with `bun run inspect`.
- **`@noetic/web`** — the docs site (Next.js + fumadocs). Standalone: no workspace dependencies. Its doc snippets are typechecked against real `@noetic-tools/*` source through `tsconfig.kiira.json` path mappings, not through a built `dist/`.

`specs/` is the source of architectural truth. `specs/00-overview.md` has the package graph and the numbered specs (`01-step-type` through `29-chat-platform-integration`) each map to a concrete source directory (see `.claude/rules/sync-spec-code-docs.md` for the table). Runtime code must stay consistent with its spec. A few specs — `12a-cli-context-layers.md`, `21-tasks.md`, `22-cli-architecture.md` — describe the CLI, whose implementation lives in the separate `noetic-internal` repo; they remain the contract for that code but have no source directory here.

## `.sentrux/rules.toml` — MUST update when

Architectural boundaries are machine-enforced by sentrux. The `Stop` hook runs `sentrux gate .` after every agent turn and regressions block cleanly; `sentrux check .` validates every layer and boundary rule. **These changes REQUIRE a corresponding edit to `.sentrux/rules.toml` in the same commit:**

1. **Adding a new package** under `packages/` → add a `[[layers]]` entry at the correct order tier. If the new package is a consumer of existing ones but must not be imported *by* them, add `[[boundaries]]` forbidding the reverse edges.
2. **Adding a major feature that introduces a new top-level directory** inside a package's `src/` (most often `packages/core/src/`) → assign the directory to the correct layer via its `paths` glob.
3. **Splitting, renaming, or moving an existing layer directory** → update the affected `[[layers]]` `paths` entries so the mapping stays accurate.
4. **Introducing a tree-shakability, isolation, or platform-independence invariant for new code** (e.g. a new context layer, a new platform adapter, a new peer package that must stay isolated from siblings) → add a `[[boundaries]]` entry with a `reason` string that explains *why* the edge is forbidden. Every `[[boundaries]]` entry must have a `reason`.

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
