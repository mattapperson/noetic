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

## Event Log + Memory Layers vs. a single "context" concept

We chose to separate the Event Log from memory layers (see `07-context-and-event-log`, `11-memory-layer-system`) because they have fundamentally different lifecycles. The Event Log is the raw record of what happened; memory layers are interpretations of that record. Conversation history gets the remainder of the token budget — not a share of a common pool. This asymmetry is intentional.

## All persistence through memory layers vs. `Persistence` on spawn

We chose to handle all persistence — including task-level artifacts like files and git commits — through the memory layer system (see `12-builtin-memory-layers`, `durableTaskState()`). The alternative was a separate `Persistence` interface on `spawn`. The tradeoff: task state persistence is slightly more verbose to configure (it's a memory layer in the agent's `memory` array rather than a field on `spawn`), but persistence is handled uniformly through one system with one lifecycle, one storage backend, and one set of scope rules. There is no second persistence mechanism to learn.
