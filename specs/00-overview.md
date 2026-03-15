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

## Architecture

`@orchid/core` is structured around three layers:

1. **Step primitives** (`01-step-type`, `02-step-variants`, `03-control-flow`, `04-spawn`, `05-loop-and-until`, `06-channels`) — One discriminated union type with seven variants. Everything is a `Step<I, O>`.

2. **Execution infrastructure** (`07-context-and-event-log`, `08-runtime`, `09-error-model`, `10-observability`) — The engine that runs steps: context management, pluggable runtime backends, error taxonomy, and tracing. Items-native (OpenResponses) — the framework uses `Item` types aligned with the OpenResponses format throughout, eliminating impedance mismatch with `callModel`.

3. **Memory system** (`11-memory-layer-system`, `12-builtin-memory-layers`) — Composable plugins that recall context before LLM calls and persist learnings after them. The View (what the LLM actually sees) is assembled from memory layer outputs + conversation history.

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
| `08-runtime` | `Runtime` interface | Pluggable engine |
| `09-error-model` | `OrchidError` | Error taxonomy + propagation |
| `10-observability` | `Span`, tracing | OpenTelemetry integration |
| `11-memory-layer-system` | `MemoryLayer`, lifecycle, budget, scope, View assembly | Memory contract |
| `12-builtin-memory-layers` | 5 built-in factories + custom examples | Reference implementations |
| `13-patterns` | ReAct, Ralph Wiggum, Task Trees, Dual-Agent, etc. | Composition proofs |
| `14-design-decisions` | Architectural rationale | Tradeoff documentation |
| `15-build-sequence` | Implementation stages 1-10 | Build ordering |

## Dependency Graph

```
                    01-step-type
                   /    |    \
          02-variants 03-flow  05-loop
                        |        |
                    04-spawn     |      10-observability
                     /    \      |           |
              07-context  06-channels        |
                    \      /                 |
                   08-runtime                |
                       |                     |
                11-memory-system ────────────+
                       |
                12-builtin-layers
                       |
                  13-patterns (uses all primitives)
```
