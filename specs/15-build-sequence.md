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

## Stage 3: Spawn and Context Isolation

**Specs:** `04-spawn`

`spawn`, where the child starts with an empty `ItemLog` and the optional `context` (a `ContextConfig` or `ContextLayer[]`) replaces the parent's layers for the child. Write a **verify-and-retry** loop: a spawned attempt, a verdict on its output, and a retry that feeds the failure back in. This forces context isolation and the `prepareNext` feedback loop. State persistence across spawn boundaries is deferred to Stage 7 (context layers).

## Stage 4: Channels and External Channels

**Specs:** `06-channels`

`channel` with `value` and `queue` modes. Write a two-step pipeline where one step produces and another consumes. This forces the async blocking model. Implement `tryRecv` for non-blocking reads.

Add external channel declaration (`external: true`), `getChannelHandle`, `ChannelHandle.send`, and `channel_closed` error. Test the dual-agent pattern with external channels: verify that external `handle.send()` delivers to a running execution, that `handle.closed` reflects execution completion, and that `channel_closed` is thrown on post-completion sends.

## Stage 5: Spawn Adapter Routing

**Specs:** `04-spawn` (SubprocessAdapter routing, detached spawn)

Route every dispatch through a `SubprocessAdapter`, resolved per call as `detachedOverride.subprocess ?? step.subprocess ?? harness.subprocess`, with the harness defaulting to `createInMemorySubprocessAdapter()`. Write a background sub-agent with `harness.detachedSpawn(...)` and await it through its `DetachedHandle`. This forces the adapter contract and the step registry that lets an adapter dispatch a child by id.

## Stage 6: Conditional and Plans

**Specs:** `03-control-flow` (conditional), `26-json-workflow-runtime` (hydrateWorkflow, dynamicWorkflow)

`conditional` and `hydrateWorkflow`. Write the **dynamic plan** pattern: a planner emits a `WorkflowDocument` as structured output, `dynamicWorkflow` validates and hydrates it into a native `Step` tree, and the interpreter executes it. This forces node → builder resolution and the `maxRevisions` cycle that feeds validation errors back to the planner.

## Stage 7: Context Layer System

**Specs:** `11-context-layer-system`, `12-builtin-context-layers` (scratchpad)

Implement the `ContextLayer` interface, the Projector (View assembly), and the `scratchpad()` built-in. The Projector assembles system prompt item (`role: system`) + layer output items (`role: developer`) + conversation history items into `Item[]`. `recallLayers` returns `Item[]`. `storeLayers` receives `LLMResponse` (with items + usage). Write a ReAct agent with a scratchpad and verify the recall/store lifecycle runs correctly on each iteration. This forces the budget allocation algorithm and the slot-ordering system.

## Stage 8: Context Layers Across Spawn Boundaries

**Specs:** `11-context-layer-system` (onSpawn/onReturn), `12-builtin-context-layers` (taskState, observations)

Implement `onSpawn`/`onReturn` hooks. Write a loop that spawns one child per iteration with `scratchpad({ scope: 'resource' })` and `taskState()`. Verify that both structured state and task artifacts persist across spawn boundaries while the ItemLog resets. Add `observations()` and verify that observations compress across iterations.

## Stage 9: Error Model

**Specs:** `09-error-model`

Deliberately inject failures at every level and verify propagation matches the defined rules. Test `onError` on loops, `fork_partial` recovery, `spawn_summary_failed` fallback. Test context layer error policies: init failure disables the layer, recall failure skips iteration, store failure is logged but doesn't block. Test `channel_closed` error on external channel handles.

## Stage 10: Observability

**Specs:** `10-observability`

Add span creation to the `execute` interpreter. Verify the trace tree matches the execution tree for all patterns. Verify context layer trace spans include budget allocation, token usage, and hook duration.

## Stage 11a: Graduation-Clause Lint

**Specs:** `14-design-decisions` (`@unstable` on a public surface)

A precondition for Stage 11, because it is the first work to ship `@public @unstable` exports and an unenforced stability convention decays. Scope it to one rule: `scripts/check-export-tags.ts` fails when a `@public @unstable` export carries no `Graduates when: …` clause. The script is a ~150-line regex validator already structured for exactly this kind of addition, and the rule applies only to that tag pairing — `./unstable` module exports are permanently extender-facing and are not on a path to stability, so demanding criteria there would be wrong. That is the whole stage — with one honest limit. The checker's regex matches only `export { X } from` named re-exports; `packages/types/src/index.ts` is wholly `export * from`, so the contract types this spec puts in `types` are **not checkable** by it and carry `@unstable` by convention only. Do not add that file to `ENTRY_POINTS` — a gate that can never fail is worse than none. `@noetic-tools/system-one` uses named re-exports so it *is* checkable; its entry is added in Stage 11 when the package exists.

The broader API-surface manifest is deliberately **not** here; see Stage 14. It solves a pre-existing problem unrelated to shipping `step.decide`, and putting it on this feature's critical path would be a second project wearing a prerequisite's clothes.

## Stage 11: System One Contract and Client

**Specs:** `32-system-one-decisions` (contract, client package)

The `SystemOneClient` contract in `@noetic-tools/types` — questions, answers, `SystemOneLimits`, and the `system_one_failed` error kind — then `@noetic-tools/system-one` implementing it as an adapter over the vendor's official `@typesafe-ai/sdk`, which already ships the question builders, the response types, the equivalent of `AnswerFor`/`DecideResult`, a typed error hierarchy, retry, and a `baseURL` that covers self-hosted endpoints. The package's real work is the *seam*, and it is a genuine translation layer rather than a pass-through: the two type hierarchies are incompatible in both directions under `strict` — the SDK's `instructions` is optional and nullable where Noetic's is required, and Noetic's JSON-safe `DecisionState` is not assignable to the SDK's `EntryType`. So Noetic ships its own `noul`/`choice`/`score` constructing its own types, and the adapter maps both ways, validating JSON-safety with Zod at the boundary. It also maps SDK error classes onto `NoeticConfigError` / `system_one_failed`, declares per-backend `limits`, and keeps the vendor-neutral contract intact so a later OpenRouter skin is a second adapter rather than a rewrite. Adding the package needs a `[[layers]]` entry at `order = 87` (the `acp`/`openui`/`agent-plugins` tier) plus a `[[boundaries]]` rule forbidding `packages/core/src/**` → `packages/system-one/src/**` — note boundaries are written as **path globs**, not layer names. The gate that matters for a pre-1.0 dependency is a contract-conformance test asserting the adapter still satisfies `SystemOneClient`, that each SDK error class maps to the documented kind, and — as a compiled type-level fixture — that the documented worked example typechecks in both directions. That last assertion is the one an SDK bump breaks first. It runs without credentials, unlike the live smoke test.

## Stage 12: `step.decide` and the Decision Step

**Specs:** `32-system-one-decisions` (step primitive, JSON workflow)

`StepDecide` in the `Step` union, the `step.decide()` builder, and `executeDecide` in the interpreter — all tagged `@unstable` alongside `@public` (spec 32's Stability section names what graduates them), and the node's stability comes from the `UNSTABLE_WORKFLOW_NODES` map rather than a hand-typed string, emitting both an `UNSTABLE:`-prefixed `description` (the channel editors actually surface) and an `x-noetic-stability` annotation, with the schema drift-gate test asserting both published copies carry them. This forces the typed-answer inference (`DecideResult` mapping question ids to answer types) and the usage-accounting question — decisions carry input tokens and free output tokens, so `trackDecisionUsage` mirrors `trackUsage` rather than routing through the LLM path. Add the `decide` JSON workflow node — its client resolved from a `systemOneClients` hydration registry mirroring `acpAgents`, its state the node's string input, its output `stringifyResult(DecideResult)` — and extend `conditional`'s route into the small predicate union (`outputContains` as the default, `outputEquals`, and `field` with `equals`/`gte`) so a JSON author can route on a chosen label or a confidence tier; a bare-string `match` stays valid. `decide` joins the durable-resume memo set with a content hash of its resolved `state` and `questions`, re-running on mismatch, because the ledger's own check is `stepId`+`kind` only. Regenerate both schema artifacts in the same commit. Write a triage agent that routes on a `choice` and verify the answer narrows to the declared option union at compile time.

## Stage 13: Decision-Backed Context and Conditions

**Specs:** `32-system-one-decisions` (compaction layer, condition/routing/guardrail/scorer upgrades)

`decisionCompaction()` as a `projectHistory` layer: pair calls to results by `callId`, pin the last complete exchange (bounded by `preserveRecentMessages` as an item ceiling, falling back to the item pin when no user message exists), run at `HISTORY_WINDOW_SLOT + 5` so it judges exactly the window `history()` kept, render a judging state through the fitting ladder, score two nouls per unpinned call in **one** request, rebuild, and run `stripUnresolvedToolCalls` as the orphan backstop. Four things make this safe rather than merely clever, and none is optional: `keepThreshold` ships **no default** (too low silently deletes context undetectably, too high only wastes tokens — an asymmetry a midpoint cannot arbitrate on an uncalibrated statistic); calls that overflow one request are left unscored rather than paying K× the re-sent state; the hook creates an `AbortController` and passes its signal into `client.evaluate` because the lifecycle's `withTimeout` never cancels the loser and would otherwise leak retrying requests every turn; and it carries an `enabled` predicate re-evaluated every turn (a captured boolean would need a redeploy; the docs show the env-var form) plus `compaction.*` **span** events — not framework events, which a `projectHistory` hook cannot reach because `ExecutionContext` exposes only `trace.addEvent` while the broadcaster needs a full `Context`. Span events are inert without a tracing backend, so say that rather than implying parity with `step.decide`. `timeouts.projectHistory` must be set explicitly — the lifecycle default is 5s, which a network call will blow. This is where the delete-never-summarize invariant gets tested: assert kept items are byte-identical, that no result survives without its call over generated transcripts, and that a timeout actually fires the abort signal — exercised through the real `projectHistoryLayers` wrapper, since the layer in isolation has no competing outer timer and its own deadline must be strictly shorter than the lifecycle's, measured from hook entry. Then the smaller surfaces: `decisionCondition()` (and the optional client path on `aiCondition`, which retires its silent `return false` on parse failure), `decisionSwitch()`, `until.decided()`, and `decisionScorer()`. Extract `history()`'s exchange-expansion helper to a shared utility first, so both layers agree on what an exchange is. Everything here fails **open** — a judge outage degrades an agent to uncompacted context, never to lost context. Tool-call guardrails were considered and cut; see spec 32's Future Considerations for why.

## Stage 14: Public API Surface Manifest

**Specs:** `14-design-decisions` (`@unstable` on a public surface)

Independent of the System One work and not a precondition for it. Extend `scripts/check-export-tags.ts` to emit `packages/core/api-surface.md` — a committed manifest of every exported symbol and its stability class, unstable ones tabled alongside their graduation criterion — plus a `--check` mode that fails on drift wired into `check:exports`, and a `gen:api-surface` script to regenerate. Same generated-artifact-plus-drift-gate shape as the workflow JSON Schema.

The problem it solves is older and broader than any one feature: nothing today makes a change to core's published surface visible as a diff, so a *stable* symbol can quietly change shape with no reviewer prompted to ask whether the commit owes a `BREAKING CHANGE:` footer. semantic-release reads commit footers, not JSDoc, so no tool can infer that intent — the manifest does not try to, it makes the consequence impossible to miss where the judgement is actually made. Prove all three paths rather than asserting them: the graduation rule firing, a tagged symbol landing in the manifest with its criterion extracted, and the drift gate failing on a stale file. Document both commands in CLAUDE.md and add the regenerate-in-the-same-commit rule to `.claude/rules/sync-spec-code-docs.md`, mirroring Requirement 6.
