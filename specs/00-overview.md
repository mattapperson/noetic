# Overview

> **Depends On:** (none)
> **Exports:** (none — context only)

---

## Why Another API

Every existing TypeScript agent framework either provides too-high-level abstractions that can't express all patterns (Mastra, Vercel AI SDK), or provides a flexible-but-complex graph model that still misses key patterns (LangGraph). None of them treat context boundary management as a first-class concern, which means they can't naturally express Ralph Wiggum's fresh-context meta-loops or Slate's episodic thread weaving. And none of them provide a composable memory system where independently-authored memory layers (working memory, semantic recall, observations, episodic memory) participate in a well-defined lifecycle around each LLM call.

The insight: six patterns (ReAct, Ralph Wiggum, Task Trees, A2A, Recursive LLMs, Slate Thread Weaving) look different on the surface but decompose into combinations of the same small set of operations. These operations are derived from the intersection of:

- **Process calculi** — CSP channels, actor message passing
- **Durable execution** — Temporal's step/signal/child-workflow, Inngest's step.run/waitForEvent
- **LangGraph's Pregel engine** — supersteps, channels, message passing
- **Slate's architecture** — episodic memory, orchestrator/worker separation, thread-as-actor model

## Packages

```
@noetic-tools/memory  →  @noetic-tools/types  ←  @noetic-tools/sub-harness
        ↑                        ↑                          ↑
@noetic-tools/core  ←  @noetic/eval        @noetic-tools/sub-harness-{claude-code,codex,opencode,pi}
      ↑
      ├── @noetic-tools/platform-node
      └── @noetic/platform-browser
```

`@noetic-tools/core` depends only on the `SubHarness` *type* in `@noetic-tools/types`; it never imports a sub-harness adapter package (the dependency edge above runs adapters → contract, never core → adapter).

- **`@noetic-tools/types`** — The dependency-free foundation. Owns the conversation `Item` data model, LLM config (`LlmProviderConfig`, `ModelParams`, `LLMResponse`, `TokenUsage`), execution context + steering contracts, the platform adapter interfaces (`FsAdapter`, `ShellAdapter`, `SubprocessAdapter`), the error model (`NoeticErrorImpl`), the `Item` schema, and the `MemoryLayer` contract (`types/memory.ts`, also exposed at the `@noetic-tools/types/contract` subpath). Depends on nothing in the workspace.

- **`@noetic-tools/memory`** — The memory layer system: lifecycle, budget allocation, projector/view assembly (`assembleView`, `allocateBudgets`), scope/storage helpers, and the built-in layer factories. Depends only on `@noetic-tools/types`; re-exports the `MemoryLayer` contract so it is the one-stop import for memory-layer authoring.

- **`@noetic-tools/core`** — Step primitives and execution infrastructure. Runtime-agnostic: no `node:*` imports, no browser-only APIs. Depends on `@noetic-tools/types` and `@noetic-tools/memory` and re-exports their public surface, so every symbol importable from `@noetic-tools/core` (including the `MemoryLayer` contract and built-in layers) stays importable from it. The memory subsystem remains tree-shakable because it has no transitive dependency on the interpreter or runtime modules.

- **`@noetic-tools/platform-node`** — Node.js ≥ 20 concrete adapter implementations: local filesystem, local shell, local subprocess, durable IPC, agent-ipc server/client, step bootstrap. Consumed by `@noetic-tools/cli`, `@noetic-tools/code-agent`, and any Node-target user code. See `25-platform-packages`.

- **`@noetic/platform-browser`** — Browser / edge-runtime glue: runtime-neutral adapter re-exports. Contains no `node:*` imports. See `25-platform-packages`.

- **`@noetic-tools/sub-harness`** — The base contract and helpers for coding-agent sub-harnesses (Claude Code, Codex, opencode, pi run as Noetic steps). Re-exports the `SubHarness` contract from `@noetic-tools/types` and adds `defineSubHarness`, the turn accumulator, item builders, the registry, the common-tool vocabulary, and shared error types. Depends only on `@noetic-tools/types`. See `27-sub-harness-steps`.

- **`@noetic-tools/sub-harness-{claude-code,codex,opencode,pi}`** — Per-tool sub-harness adapters. Each implements the `SubHarness` contract via `defineSubHarness` (vendor SDK behind an injectable runner) and exports a factory (`claudeCode()`, `codex()`, …). Depends on `@noetic-tools/sub-harness` + `@noetic-tools/types` — never on `@noetic-tools/core`.

- **`@noetic/eval`** — Eval framework, CLI, scorers, and optimization loop. Depends on `@noetic-tools/core`.

## Architecture

`@noetic-tools/core` is structured around three layers:

1. **Step primitives** (`01-step-type`, `02-step-variants`, `03-control-flow`, `04-spawn`, `05-loop-and-until`, `06-channels`) — One discriminated union type with seven variants. Everything is a `Step<I, O>`.

2. **Execution infrastructure** (`07-context-and-event-log`, `08-agent-harness`, `09-error-model`, `10-observability`) — The engine that runs steps: context management, pluggable agent harness backends, error taxonomy, and tracing. Items-native (OpenResponses) — the framework uses `Item` types aligned with the OpenResponses format throughout, eliminating impedance mismatch with the LLM provider.

3. **Memory system** (`11-memory-layer-system`, `12-builtin-memory-layers`) — The `MemoryLayer` contract (owned by `@noetic-tools/types`), lifecycle hook types, scope system, storage adapter contract, and built-in layer factories, all living in `@noetic-tools/memory`. The View (what the LLM actually sees) is assembled by the Projector from the layer outputs + conversation history. **Boundary rule:** `@noetic-tools/memory` depends only on `@noetic-tools/types` and MUST NOT import from `@noetic-tools/core`. This keeps memory tree-shakable and free of any transitive dependency on the interpreter or runtime.

**Patterns** (`13-patterns`) are 15-30 line compositions of primitives. They prove the primitives are sufficient; they are not framework magic.

## Spec Index

| Spec | Feature | Role |
|------|---------|------|
| `01-step-type` | `Step<I,O>` discriminated union | Root type, interpreter signature |
| `02-step-variants` | `run`, `llm`, `tool` variants + `Tool` type | Atomic units of work |
| `03-control-flow` | `branch()`, `fork()` | Routing and parallelism |
| `04-spawn` | `spawn()` + context strategies | Context boundaries |
| `05-loop-and-until` | `loop()`, `Until`, `Verdict` | Iteration and termination |
| `06-channels` | `Channel<T>`, `send`/`recv`, `tryRecv`, `ExternalChannel`, `ChannelHandle` | Typed data flow |
| `07-context-and-event-log` | `Context`, `ItemLog`, `Item`, `StepMeta`, `TokenUsage`, `LLMResponse` | Execution state |
| `08-agent-harness` | `AgentHarness` interface | Pluggable engine |
| `09-error-model` | `NoeticError` | Error taxonomy + propagation |
| `10-observability` | `Span`, tracing | OpenTelemetry integration |
| `11-memory-layer-system` | `MemoryLayer`, lifecycle, budget, scope, View assembly | Memory contract |
| `12-builtin-memory-layers` | 5 built-in factories + custom examples | Reference implementations |
| `13-patterns` | ReAct, Ralph Wiggum, Task Trees, Dual-Agent, etc. | Composition proofs |
| `14-design-decisions` | Architectural rationale | Tradeoff documentation |
| `15-build-sequence` | Implementation stages 1-10 | Build ordering |
| `22-cli-architecture` | `@noetic-tools/cli` layer hierarchy, subprocess adapter wiring | CLI internals |
| `23-durable-execution` | `CheckpointSnapshot`, `reattach`/`listLive`, durable IPC, host-restart flow | Crash-recovery model |

## Dependency Graph

```
── @noetic-tools/core ────────────────────────────────────────────────
                    01-step-type
                   /    |    \
          02-variants 03-flow  05-loop
                        |        |
                    04-spawn     |      10-observability
                     /    \      |           |
              07-context  06-channels        |
                    \      /                 |
                   08-agent-harness           |
                       |                     |
                  13-patterns (uses all primitives)
                       |
                       ↓ re-exports
── @noetic-tools/memory ──────────────────────────────────────────────
                   memory (11, 12)
                       |
                       ↓ depends on
── @noetic-tools/types ───────────────────────────────────────────────
            Item, LlmProviderConfig, ExecutionContext,
            FsAdapter/ShellAdapter/SubprocessAdapter,
            NoeticErrorImpl, MemoryLayer contract

── @noetic/eval ────────────────────────────────────────────────
                17-eval-and-optimization
```

`@noetic-tools/memory` depends only on `@noetic-tools/types` and has no edge into `@noetic-tools/core` — see the boundary rule in the Architecture section above. `@noetic-tools/core` re-exports the public surface of both so its entry points are unchanged for consumers.
