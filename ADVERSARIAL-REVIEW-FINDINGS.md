# Adversarial Review Findings �� Noetic Agent Framework

**Date**: 2026-03-28
**Scope**: Core library (`@noetic/core`), documentation (`packages/web`), live OpenRouter integration
**Method**: Built non-trivial multi-operator agents (mocked + live), verified OpenResponses compliance, audited docs against code, probed edge cases

---

## Category A: Runtime Bugs (Critical)

### A1. Tool calls are invisible to Noetic when using real OpenRouter SDK
**Severity**: Critical
**Files**: `packages/core/src/adapters/openrouter.ts`, `packages/core/src/interpreter/execute-llm.ts`

The OpenRouter SDK executes tool calls internally via the `execute` callback in `convertTools()`. The `getResponse()` method returns only the final assistant message — no `function_call` or `function_call_output` items appear in `response.output`.

**Impact**:
- `ctx.itemLog` never contains function_call/function_call_output items from real tool use
- `lastStepMeta.toolCalls` is always `undefined` for real tool interactions
- Observability is blind to tool execution (no trace spans for individual tool calls)
- Memory layer `store()` hooks never see tool interaction items

**Verified in**: `test/live-openrouter.test.ts` — "tool calls are executed by SDK but invisible to Noetic itemLog"

### A2. `until.noToolCalls()` always stops after 1 iteration with real SDK
**Severity**: Critical
**Files**: `packages/core/src/until/predicates.ts`, `packages/core/src/patterns/react.ts`

Because the SDK hides tool calls (A1), `snapshot.lastStepMeta?.toolCalls` is always `undefined`. The `noToolCalls()` predicate always returns `{ stop: true }` on the first iteration.

**Impact**:
- The `react()` pattern's loop is meaningless — it always exits after 1 iteration
- Any `loop` + `until.noToolCalls()` pattern is broken
- This "works" accidentally because the SDK already ran the full tool loop internally, but the Noetic loop adds no value

**Verified in**: `test/live-openrouter.test.ts` — "until.noToolCalls always stops after 1 iteration"

### A3. Token/cost tracking only reflects final SDK round
**Severity**: Major
**Files**: `packages/core/src/runtime/agent-harness.ts:153-159`

When the SDK handles a multi-round tool conversation internally, the `usage` object in the response only contains the final round's token counts. Intermediate tool call rounds' tokens are lost.

**Verified by**: Direct SDK test showing 3 tool calls executed but `usage.inputTokens: 159` (only final round).

### A4. Structured output has no JSON format enforcement
**Severity**: Major
**Files**: `packages/core/src/interpreter/execute-llm.ts:86-111`, `packages/core/src/runtime/agent-harness.ts:141-148`

When `step.llm` has an `output` Zod schema, the framework parses the LLM response as JSON. However, no `response_format: { type: "json_object" }` parameter is sent to the model. The model often responds with plain text, causing `llm_parse_error`.

**Verified in**: `test/live-openrouter.test.ts` — model returned `"7 * 8 = 56."` instead of JSON.

---

## Category B: Doc Bugs (Code-vs-Docs Mismatches)

### B1. `body:` instead of `steps:` in loop examples
**Severity**: Major (copy-paste from docs won't compile)
**Locations**:
- `packages/web/content/docs/examples/pipeline-agent.mdx:62`
- `packages/web/content/docs/examples/branching-agent.mdx:76`
- `packages/web/content/docs/operators/spawn.mdx:109, 201, 256`
- `packages/web/content/docs/patterns/react.mdx:80`
- `packages/web/content/docs/errors.mdx:94`
- `packages/web/content/docs/patterns/ralph-wiggum.mdx:91`

**Fix**: Replace `body:` with `steps:` in all loop configurations. The actual `StepLoop` type and `loop()` builder use `steps: ReadonlyArray<Step<I, O>>`.

### B2. `step.run('id', fn)` positional API does not exist
**Severity**: Major (copy-paste from docs won't compile)
**Locations**:
- `packages/web/content/docs/context.mdx:11`
- `packages/web/content/docs/observability.mdx:56`
- `packages/web/content/docs/operators/channels.mdx:18, 23, 210`

**Fix**: Replace `step.run('id', fn)` with `step.run({ id: 'id', execute: fn })`. The actual builder signature requires an options object.

### B3. `kind: 'message'` instead of `type: 'message'`
**Severity**: Major (runtime errors in user code)
**Locations**:
- `packages/web/content/docs/operators/spawn.mdx:66, 129`
- `packages/web/content/docs/patterns/recursive-llm.mdx:51`

**Fix**: Replace `kind: 'message'` with `type: 'message'`. The `Item` discriminated union uses `type`, not `kind`.

---

## Category C: OpenResponses Compliance

### C1. Items from mocked callModel are fully compliant
**Status**: Pass
All items created by the framework (via `createMessage`, `responseToNoeticItems`) correctly include `id`, `status`, `type`, and properly typed `content` arrays with `output_text`/`input_text` content parts.

### C2. Items from live OpenRouter are compliant
**Status**: Pass (for items that ARE returned)
Assistant messages from live API calls have valid `id`, `status: 'completed'`, `type: 'message'`, `role: 'assistant'`, and `content: [{ type: 'output_text', text }]`.

### C3. Tool interaction items are missing from live responses
**Status**: Fail (see A1)
`function_call` and `function_call_output` items never appear in the itemLog when using the real SDK, even though tools were executed.

### C4. `response.outputText` is always `undefined` from SDK
**Status**: Informational
The SDK never populates `outputText` on the response. The fallback path in `responseToNoeticItems()` (lines 246-259) is dead code in practice. This isn't a bug because messages ARE in `response.output`, but the fallback provides no value.

---

## Category D: Edge Cases Verified

All edge case tests pass. Key behaviors confirmed:

| Edge Case | Result | File |
|-----------|--------|------|
| Empty fork paths (all) | merge([]) called | adversarial-edge-cases.test.ts |
| Empty fork paths (race) | fork_partial thrown | adversarial-edge-cases.test.ts |
| Empty fork paths (settle) | merge([]) called | adversarial-edge-cases.test.ts |
| Loop all-skip + maxIterations | step_failed "exceeded maximum iterations" | adversarial-edge-cases.test.ts |
| Loop predicate throws | Treated as stop:true, returns lastOutput | adversarial-edge-cases.test.ts |
| Channel recv timeout | channel_timeout with correct name/timeout | adversarial-edge-cases.test.ts |
| Topic tryRecv | Always returns null | adversarial-edge-cases.test.ts |
| Non-JSON structured output | llm_parse_error with raw + zodError | adversarial-edge-cases.test.ts |
| Wrong-schema JSON output | llm_parse_error with zodError.issues | adversarial-edge-cases.test.ts |
| Steering retry exhaustion | Falls through after 4 calls (1+3 retries) | adversarial-edge-cases.test.ts |
| Race fork abort propagation | Winner resolves, losers aborted | adversarial-edge-cases.test.ts |
| Fork concurrency=1 | Sequential execution verified | adversarial-edge-cases.test.ts |
| Branch null route | Input passed through | adversarial-edge-cases.test.ts |
| maxIterations=0, -1, Infinity | Rejected with step_failed | adversarial-edge-cases.test.ts |

---

## Category E: Design Concerns

### E1. SDK tool execution model creates an abstraction mismatch
The OpenRouter SDK's `callModel` with `execute` callbacks creates a "batteries-included" tool loop that bypasses Noetic's own loop/until machinery. This means Noetic's composable operator model (the core selling point) is partially bypassed for the most common use case (tool-using agents).

**Options to consider**:
1. Use the SDK in "raw" mode (without `execute` callbacks) and handle tool execution in Noetic's interpreter
2. Add an event/callback hook to the SDK's internal tool loop to capture intermediate items
3. Document this as intentional and adjust `noToolCalls()` semantics

### E2. `frameworkCast` usage is widespread
The codebase uses `frameworkCast<T>(value)` extensively to bridge type gaps. This is effectively an unchecked `as unknown as T` cast. While individually justified, the pattern makes it easy to introduce runtime type mismatches, particularly in the loop's `prepareNext` default path where `lastOutput: O` is cast to `I`.

### E3. Memory layer budget system is untested end-to-end
The budget allocation algorithm in `memory/budget.ts` and the view assembly in `memory/projector.ts` have unit tests, but no integration test verifies that budget limits actually constrain what gets injected into LLM context during a real execution.

---

## Test Artifacts

| File | Tests | Purpose |
|------|-------|---------|
| `test/adversarial-review.test.ts` | 12 | Multi-operator pipeline (branch, fork, loop, channel, tool) |
| `test/adversarial-edge-cases.test.ts` | 16 | Edge cases (empty forks, loop errors, channel timeouts, steering) |
| `test/live-openrouter.test.ts` | 5 | Live OpenRouter integration (requires `NOETIC_LIVE_TESTS=1`) |

**Run live tests**: `NOETIC_LIVE_TESTS=1 bun test test/live-openrouter.test.ts --timeout 60000`

---

## Summary

| Category | Critical | Major | Minor | Info |
|----------|----------|-------|-------|------|
| Runtime bugs | 2 (A1, A2) | 2 (A3, A4) | 0 | 0 |
| Doc bugs | 0 | 3 (B1, B2, B3) | 0 | 0 |
| OpenResponses | 0 | 1 (C3) | 0 | 1 (C4) |
| Design concerns | 0 | 0 | 0 | 3 (E1-E3) |

The most impactful finding is **A1/A2**: the OpenRouter SDK's internal tool execution creates an abstraction mismatch where Noetic's loop/tool/observability operators are bypassed for real tool-using agents. This affects the core `react()` pattern and any agent using tools with loops.
