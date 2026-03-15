# Design Decisions

> **Depends On:** All specs (references decisions from each)
> **Exports:** (none — prose rationale)

---

Each decision states what was chosen, the alternative, and the tradeoff.

## One discriminated union vs. separate primitive types

We chose a single `Step<I, O>` discriminated union with seven `kind` variants (see `01-step-type`). The alternative — seven independent types — would require seven overloads of `execute` and make composition less natural. The tradeoff: pattern-matching on `kind` is slightly more verbose than direct function dispatch, but it gives us a single recursive interpreter and makes "everything is a Step" true at the type level.

## Three execution variants (`run`, `llm`, `tool`) vs. a single overloaded function

We chose explicit variants (see `02-step-variants`) because the runtime treats them differently: retry semantics, cost tracking, approval gating, sandboxing, and telemetry all differ. The cost is three constructors instead of one. The benefit is that TypeScript enforces correct usage at compile time and the runtime never needs to inspect arguments to determine behavior.

## `O` as business value only vs. rich return types

We chose to keep `O` as the business value and put execution metadata on the context (see `07-context-and-event-log`). The alternative — returning `LLMResult<O>` from LLM steps — breaks the composability contract because `Step<I, O>` would lie about its output type. The tradeoff: accessing metadata requires reading `ctx.lastStepMeta` instead of destructuring the return value, which is slightly less ergonomic for single-step scripts but dramatically simpler for multi-step compositions.

## Mandatory `merge` for fork vs. optional with `ForkResult<O>[]` default

We chose mandatory `merge` for `all` and `settle` modes (see `03-control-flow`) to keep the `Step<I, O>` contract honest. The alternative — returning `ForkResult<O>[]` — leaks fork semantics into downstream steps that shouldn't need to know they're consuming forked output. The tradeoff: every fork requires a merge function, even when the merge is trivial.

## Two-axis context strategy vs. single enum

We chose `contextIn` x `contextOut` as two independent axes (see `04-spawn`). The original design used a single string enum (`'accumulate' | 'fresh' | 'episodic' | 'windowed'`) that hid enormous complexity behind four words. The tradeoff: more verbose configuration, but every combination is explicit, configurable, and type-safe.

## Error taxonomy vs. generic `Error` propagation

We chose a discriminated union `OrchidError` (see `09-error-model`) because different errors require different recovery strategies. `llm_parse_error` includes the raw text for re-prompting. `fork_partial` includes both succeeded and failed results. `spawn_summary_failed` preserves the child's output. The tradeoff: callers must pattern-match on error kinds instead of catching generic `Error`, but they get actionable information.

## Channels as standalone objects vs. state properties

We chose standalone `Channel<T>` objects (see `06-channels`) over LangGraph-style state properties because they provide compile-time type safety and clear scope/lifecycle rules. The tradeoff: slightly more setup vs. just declaring a state field, but you get type-checked `send`/`recv` and explicit semantics.

## `until` predicates returning `Verdict` vs. `boolean`

We chose `Verdict` (see `05-loop-and-until`) with `stop`, `reason`, and `feedback` fields. Booleans provide no observability and no feedback injection. The tradeoff: predicate implementations are slightly more verbose, but every loop termination is traceable and debuggable.

## Memory layers as a separate plugin system vs. built into Context

We chose to make memory layers a plugin system (see `11-memory-layer-system`) with lifecycle hooks rather than building memory management into the `Context` object. The alternative would make every agent pay for memory features it doesn't use. The tradeoff: more indirection (the View is assembled by the Projector), but memory layers are independently authorable, composable, and replaceable. A simple script uses zero layers; a production agent uses five — same runtime, same Step types.

## ItemLog + Memory Layers vs. a single "context" concept

We chose to separate the ItemLog from memory layers (see `07-context-and-event-log`, `11-memory-layer-system`) because they have fundamentally different lifecycles. The ItemLog is the raw record of what happened; memory layers are interpretations of that record. Conversation history gets the remainder of the token budget — not a share of a common pool. This asymmetry is intentional.

## All persistence through memory layers vs. `Persistence` on spawn

We chose to handle all persistence — including task-level artifacts like files and git commits — through the memory layer system (see `12-builtin-memory-layers`, `durableTaskState()`). The alternative was a separate `Persistence` interface on `spawn`. The tradeoff: task state persistence is slightly more verbose to configure (it's a memory layer in the agent's `memory` array rather than a field on `spawn`), but persistence is handled uniformly through one system with one lifecycle, one storage backend, and one set of scope rules. There is no second persistence mechanism to learn.

## Items-native vs. Message/Event duality

We chose to use OpenResponses `Item` types throughout the framework, collapsing the previous `Message` and `Event` types into a single hierarchy (see `07-context-and-event-log`). Items serve as both the record of what happened (in the `ItemLog`) and the input to `callModel` (in the View). This eliminates impedance mismatch — there is no conversion layer between the framework's internal representation and the model API format. The tradeoff: pattern-matching for simple role checks (e.g., "is this a user message?") requires checking `item.type === 'message' && item.role === 'user'` instead of `message.role === 'user'`, which is slightly more verbose. But the zero-conversion guarantee means fewer bugs and less code overall.

## `tryRecv` vs. blocking-only channel reads

We chose to add `tryRecv` as a non-blocking read that returns `T | null` (see `06-channels`). The alternative — blocking `recv` only — forces steps that want to check for data without suspending to use timeouts or spawn background readers. `tryRecv` never throws for normal control flow. This is Go's `select/default` analogue. The tradeoff: slightly more API surface, but polling patterns (like a worker checking for plan updates) become trivial one-liners instead of requiring channel timeout workarounds.

## `ChannelHandle` vs. bare `runtime.send`

We chose `ChannelHandle<T>` as a typed, lifecycle-aware write surface for external callers (see `06-channels`). The alternative — exposing `runtime.send(channel, value, executionId)` directly — would require external callers to hold runtime references and manage execution IDs manually. `ChannelHandle` encapsulates the routing, validates the channel is still open, and provides type safety at the call site. The tradeoff: slightly more API surface (`getChannelHandle` + `ChannelHandle` type), but routing is unambiguous and lifecycle errors (sending to a completed execution) are caught immediately.

## External channels survive fresh boundaries

External channels are scoped to the **root execution**, not individual spawn boundaries (see `06-channels`). A `contextIn: 'fresh'` spawn clears the ItemLog and internal channels, but external channels remain accessible. This is analogous to `scope: 'resource'` memory layers — they represent user-level communication that should persist regardless of how the agent structures its internal execution. The alternative — resetting external channels on fresh spawn — would break human-in-the-loop patterns where a user sends messages to a running agent that uses fresh-context iterations internally.

## `developer` role for memory layer output vs. `system` for agent instructions

OpenResponses distinguishes `system` (user-authored instructions) from `developer` (framework-injected context). Memory layers use `role: developer` because they're framework machinery, not the agent's core instructions. The `system` field on `StepLLMOpts` renders as a `MessageItem` with `role: system`. This separation lets models treat them differently and makes the View's provenance clear: system items are the agent's identity; developer items are runtime-injected context that may change between calls.

## Options object for `channel()` factory

We moved from positional `channel(name, schema, mode)` to `channel(name, { schema, mode, ... })` (see `06-channels`). The positional form would grow unwieldy as we add `external`, `capacity`, and future options. The options object is more extensible, consistent with other builders (`step.llm({...})`, `spawn({...})`), and avoids a growing positional parameter list. The tradeoff: slightly more verbose for the simplest case, but the API is self-documenting and won't need breaking changes when new options are added.
