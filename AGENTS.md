# AGENTS.md

This file guides coding agents working in this repository.

## Guiding design principles

- **Compose small, typed steps.** Every unit of workflow execution is a `Step<I, O>`. Steps compose freely, so a loop can contain a branch that runs child agents in parallel. Build patterns from these primitives in application code. Add a step type only when the existing primitives cannot express the behavior.
- **Keep control flow explicit.** Workflow authors choose when to call a model, branch, run work in parallel, spawn a child, and stop a loop. The interpreter runs that flow as written.
- **Treat context boundaries as part of the workflow.** Pluggable layers assemble what each model call sees. Authors choose the layers, how to budget their contributions, and what context crosses into or out of a child run.
- **Make execution resumable and inspectable.** With durability enabled, use recorded step results to resume interrupted runs. Build in traces for model calls, tool calls, routing decisions, and loop verdicts.
- **Keep core portable.** Core owns the reusable execution contracts. Adapters and separate packages supply platform and protocol details. Application code owns product policy.
- **Keep the public API as small as possible.** Extend existing methods wherever they can express the behavior. Make `execute()` the main entry point and require as few other calls as possible to set up the harness, run flows, or trigger actions in them.
- **Include batteries by default.** A basic harness and flow should run out of the box with minimal configuration. The default run is non-durable. Two or three lines of runtime preset configuration should enable a durable deployment with opinionated defaults tuned for the environment, such as Node.js or Cloudflare Workers.
- **Prefer Items in and Items out.** The harness's public methods should use typed Items as the primary input and output. Harness parameters and callbacks are secondary extension points.
- **Make JSON the primary workflow API.** Define workflows as JSON documents. JavaScript and TypeScript helpers build those same documents and make them easier to author.
- **Check every workflow value statically.** Every workflow value must have a type that can be checked before execution. Reject any workflow definition or feature that can pass validation and then hit a runtime error it cannot recover from automatically.

## Commands

All scripts run from the repo root unless noted.

- `bun install` — install workspace deps (postinstall patches `@openrouter/agent`)
- `bun test` — runs the package suites **sequentially** in this order: `types → context → openui → mcp → agent-plugins → acp → chat-sdk → profile-ui → profile-screen → profile-browser → profile-app → profile-device → profile-chat → verify → core → eval → inspector`. `platform-node`, `platform-browser` and `platform-cloudflare-worker` have their own `test` scripts but are **not** in the root chain — run them per-package.
- `bun test:ci` — same plus coverage enforcement (diff gate from baseline)
- `bun run lint` / `bun run lint:fix` — biome
- `bun run check:exports` — validates `@public` JSDoc tags on core's entry points (`bun scripts/check-export-tags.ts`)
- `bun run typecheck:examples` — typechecks the root `examples/` project
- `bun run example:acp` — runs `examples/acp-e2e.ts` (set `ACP_LIVE_AGENT=1` for the live spawned-agent path; add `OPENROUTER_API_KEY` for the live model→agent delegation path)
- `cd packages/acp && ACP_LIVE_AGENT=1 bun test test/live-reattach.test.ts` — live, opt-in: kills a host running the real Claude Code / Codex bridge and checks a reattached host still serves it noetic tools (real model turns; needs the CLIs logged in; `ACP_LIVE_AGENTS=codex` picks one). Skipped without `ACP_LIVE_AGENT=1`
- `bun run example:vendor-email` — runs `examples/vendor-email.ts`: durable runs, a held approval and a trigger end to end, across four executor processes, one of them killed mid-run. Needs no API key
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
platform-cloudflare-worker ───→ core         │          │
                                   openui ───┘──────────┤
                                        chat-sdk ───────┤
                                             acp ───────┤
                   agent-plugins ──→ mcp ───────────────┤
                                          verify ───────┤
                       profile-{browser,app,device} ──→ profile-ui ──┤
                                profile-{ui,screen,chat} ────────────┘

web (standalone — no workspace deps)
```

Every edge above is the complete set: `types` depends on nothing; `context`,
`chat-sdk`, `acp`, `mcp`, `verify`, `profile-ui`, `profile-screen` and
`profile-chat` depend only on `types`; `profile-browser`, `profile-app` and
`profile-device` on `types` + `profile-ui`; `agent-plugins` on `types` + `mcp`;
`openui` and `core` on `context` + `types`; `eval`, `platform-node`,
`platform-browser` and `platform-cloudflare-worker` on `core`; `inspector` on `core` + `platform-node`; `web` on
nothing.

The 21 packages under `packages/`: `acp`, `agent-plugins`, `chat-sdk`,
`context`, `core`, `eval`, `inspector`, `mcp`, `openui`, `platform-browser`,
`platform-cloudflare-worker`, `platform-node`, `profile-app`, `profile-browser`, `profile-chat`,
`profile-device`, `profile-screen`, `profile-ui`, `types`, `verify`, `web`.
Most publish under the `@noetic-tools/` scope; `inspector`, `platform-browser`,
and `web` use `@noetic/`.

The Noetic CLI (`@noetic-tools/cli`), its code-agent tooling
(`@noetic-tools/code-agent`), and the `@noetic/plugin-*` packages are **not in
this repo** — they are developed in a separate monorepo
(`github.com/mattapperson/noetic-internal`). Never cite a `packages/cli/**` or
`packages/code-agent/**` source path here. Their authored docs still live in
this repo under `packages/web/content/docs/code-agent-cli/`.

- **`@noetic-tools/types`** — the dependency-free foundation: the conversation `Item` data model, LLM config (`LlmProviderConfig`, `ModelParams`, `LLMResponse`), execution context + steering contracts, the `ContextLayer` contract (also exported at the `./contract` subpath), platform adapter interfaces, the error model, and the `Item` schema. Imported by `context` and `core`; depends on nothing in the workspace.
- **`@noetic-tools/context`** — the context layer system: lifecycle, budget/projection machinery (`assembleView`, `allocateBudgets`, layer state stores, scoping), and the built-in layers (instructions/history/scratchpad/observations/temporal/steering/filesystem/plan/task-state/tool-calls). Depends only on `@noetic-tools/types`; re-exports the `ContextLayer` contract so it is the one-stop import for context-layer authoring. Must stay free of imports from `core` (acyclic + tree-shakable).
- **`@noetic-tools/core`** — step primitives (`Step<I,O>` discriminated union), interpreter, runtime, error model, observability. Re-exports the public surface of `@noetic-tools/context` and `@noetic-tools/types`, so its `.`, `/portable`, `/unstable`, and `/internal/test` entry points are unchanged for consumers. Internal order (foundational → consumer): `types/schemas/util` → `observability` → `builders/conditions/until` → `runtime` → `interpreter` → `adapters` → `harness`.
- **`@noetic-tools/acp`** — an [Agent Client Protocol](https://agentclientprotocol.com/) client: runs any ACP-speaking coding agent (Claude Code, Codex, Gemini CLI, …) as a step via `step.acpAgent(...)` or an `acp-agent` JSON workflow node. Owns the protocol library, capability negotiation, session/turn drivers, the client-side `fs/*` + `terminal/*` + permission handlers (backed by Noetic's own `FsAdapter`/`ShellAdapter`, with `fs/*` paths confined to the session cwd by default — note that a `permissions` policy does NOT gate `fs/*` or `terminal/*`, which are client methods the agent calls directly rather than tool calls it asks about), the transports, and the agent presets. The `.` entry is runtime-neutral; the Node stdio transport lives at `./stdio`. It also serves a step's Noetic `tools` to the agent over MCP — the tool bridge, a loopback MCP server loaded on first use (`src/mcp/`, on `@modelcontextprotocol/server` + `@modelcontextprotocol/node`) — with per-agent settings that make each call match `callModel`. Depends only on `@noetic-tools/types`. **`@noetic-tools/core` must never import this package** — it resolves agents from the types contract + a runtime registry, so no protocol code is loaded at runtime by core (enforced by `.sentrux/rules.toml`). Note the npm graph is a different question: `@noetic-tools/types` takes the protocol package as a real dependency for its type re-exports, so installing core installs it — the import graph is clean, the dependency tree is not. See `specs/27-acp-agent-steps.md`.
- **`@noetic-tools/agent-plugins`** — a conformant [Agent Plugins](https://agent-plugins.org) v1 client. Discovers plugin packages (a closed `plugin.json` manifest plus the two portable component types: Agent Skills in `skills/`, MCP servers in `mcp.json`) and exposes skills through the `agentPlugins()` context layer using the spec's progressive disclosure model; `pluginConnections()` turns plugin MCP servers into `mcp()` connection entries (`expose: 'call'`) for the harness or a turn. Depends on `@noetic-tools/types` and `@noetic-tools/mcp` (it never imports `@modelcontextprotocol/sdk` itself), and it launches plugin subprocesses. **`@noetic-tools/core` must never import it** — the same rule that keeps the ACP client out of core, so no protocol library, vendor SDK, or subprocess launcher enters core's graph (enforced by `.sentrux/rules.toml`). See `specs/30-agent-plugins.md`.
- **`@noetic-tools/mcp`** — the MCP bridge: `mcp(...)` is a `ConnectionProvider` that connects an MCP server (stdio, streamable HTTP), reads its `tools.noetic/profiles` declaration and checks it against profile definitions, and maps tools, resources and events onto a connection manifest. It is the **only** package that imports `@modelcontextprotocol/sdk`; conformance checking lives at `./conformance`. Depends only on `types`; core never imports it. See `specs/35-connections.md`, `specs/36-connection-profiles.md`.
- **`@noetic-tools/verify`** — the `verifier()` implementing core's `Verifier` contract with `open-verification` (OVP): matchers, windows, judging, run records. The only package that imports `open-verification`. Depends only on `types` (`@noetic-tools/types/verify`); core never imports it. See `specs/37-verification.md`.
- **`@noetic-tools/profile-*`** — the v1 profile catalog (`ui`, `screen`, `browser`, `app`, `device`, `chat`), each a `defineProfile(...)` from `types`; `browser`, `app` and `device` extend `ui`. Core never imports them. See `specs/36-connection-profiles.md`.
- **`@noetic-tools/openui`** — generative UI via the OpenUI standard: the `openUi()` output codec (streaming OpenUI Lang parser), the `openUiSurface()` context layer, the typed `fragment()` builder for tool-authored UI, and an OpenUI-speaking transport at `./server`. Depends on `context` + `types` only; **core never imports it**. See `specs/28-generative-ui.md`.
- **`@noetic-tools/chat-sdk`** — chat-sdk.dev integration: run a harness as the brain of a multi-platform chat bot via `chat.onSubscribedMessage(noeticAgent(...))`. Depends only on `types`. See `specs/29-chat-platform-integration.md`.
- **`@noetic-tools/platform-node`** / **`@noetic/platform-browser`** — the platform adapter implementations. Core ships only contracts + in-memory adapters; `platform-node` adds the local fs/shell/subprocess adapters, file storage, the durable outbound queue, and the agent IPC client/server/protocol, while `platform-browser` re-exports core's runtime-neutral in-memory adapters with no `node:*` imports. Both depend on `core`. See `specs/25-platform-packages.md`.
- **`@noetic-tools/platform-cloudflare-worker`** — Noetic on Cloudflare Workers: `StorageAdapter`s with `swap` over D1 and over a Durable Object's SQLite (with a `scope` per tenant, and `spill` to a blob store for values too large for a row), `eventEndpoint()` (verify a request, `source.emit`, answer once stored), and two presets that wake parked turns: `alarmWake()` on a Durable Object alarm and `runTurn()` inside a Cloudflare Workflow, one instance per turn. It imports no Cloudflare package: each helper takes the small part of a binding it uses. Depends on `core`. See `specs/25-platform-packages.md`.
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
