# Build Sequence

> **Depends On:** All specs (maps features to stages)
> **Exports:** (none — implementation ordering)

---

Each stage produces a working system that can be tested. The spec updates after each stage to match what was actually built.

## Stage 1: Core Interpreter

**Specs:** `01-step-type`, `02-step-variants` (runCode + callModel mocked)

The discriminated union `Step` type and the `execute` interpreter. Get the core switch working with `runCode`, `callModel` (mocked), and `loop` + `until`. `ItemLog` established here — the LLM provider returns items, runtime appends to `ItemLog`. Write **ReAct** against this.

## Stage 2: inParallel

**Specs:** `03-control-flow`

`inParallel` with all three modes (`all`, `race`, `settle`). Write the parallel search pattern. This forces the merge types and `SettleResult` to be nailed down.

## Stage 3: Spawn with Fresh Context

**Specs:** `04-spawn`

`spawn` with `fresh` + `full`. Write **Ralph Wiggum**. This forces context isolation and the `prepareNext` feedback loop. State persistence across fresh boundaries is deferred to Stage 7 (context layers).

## Stage 4: Channels and External Channels

**Specs:** `06-channels`

`channel` with `value` and `queue` modes. Write a two-step pipeline where one step produces and another consumes. This forces the async blocking model. Implement `tryRecv` for non-blocking reads.

Add external channel declaration (`external: true`), `getChannelHandle`, `ChannelHandle.send`, and `channel_closed` error. Test the dual-agent pattern with external channels: verify that external `handle.send()` delivers to a running execution, that `handle.closed` reflects execution completion, and that `channel_closed` is thrown on post-completion sends.

## Stage 5: Spawn with Summary/Schema

**Specs:** `04-spawn` (summary + schema overloads)

`spawn` with `summary` and `schema` contextOut strategies. Write **Slate thread weaving**. This forces the summary LLM call integration and the type overloads.

## Stage 6: Conditional and Plans

**Specs:** `03-control-flow` (conditional), `13-patterns` (compilePlan, adaptivePlan)

`conditional` and `compilePlan`. Write the **dynamic plan** pattern and **adaptive plan** loop. This forces agent resolution and the adaptive revision cycle.

## Stage 7: Context Layer System

**Specs:** `11-context-layer-system`, `12-builtin-context-layers` (scratchpad)

Implement the `ContextLayer` interface, the Projector (View assembly), and the `scratchpad()` built-in. The Projector assembles system prompt item (`role: system`) + layer output items (`role: developer`) + conversation history items into `Item[]`. `recallLayers` returns `Item[]`. `storeLayers` receives `LLMResponse` (with items + usage). Write a ReAct agent with a scratchpad and verify the recall/store lifecycle runs correctly on each iteration. This forces the budget allocation algorithm and the slot-ordering system.

## Stage 8: Context Layers Across Spawn Boundaries

**Specs:** `11-context-layer-system` (onSpawn/onReturn), `12-builtin-context-layers` (taskState, observations)

Implement `onSpawn`/`onReturn` hooks. Write Ralph Wiggum with `scratchpad({ scope: 'resource' })` and `taskState()`. Verify that both structured state and task artifacts persist across fresh-context iterations while the ItemLog resets. Add `observations()` and verify that observations compress across iterations.

## Stage 9: Error Model

**Specs:** `09-error-model`

Deliberately inject failures at every level and verify propagation matches the defined rules. Test `onError` on loops, `fork_partial` recovery, `spawn_summary_failed` fallback. Test context layer error policies: init failure disables the layer, recall failure skips iteration, store failure is logged but doesn't block. Test `channel_closed` error on external channel handles.

## Stage 10: Observability

**Specs:** `10-observability`

Add span creation to the `execute` interpreter. Verify the trace tree matches the execution tree for all patterns. Verify context layer trace spans include budget allocation, token usage, and hook duration.
