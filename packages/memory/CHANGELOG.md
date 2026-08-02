## @noetic-tools/memory-v3.1.0 (2026-08-02)

* feat: rename the memory layer system to context layers ([123810f](https://github.com/mattapperson/noetic/commit/123810f))

## @noetic-tools/memory-v3.0.0 (2026-08-02)

* fix: harden step.workflow caching and plan-layer state loading ([3b10168](https://github.com/mattapperson/noetic/commit/3b10168))
* feat(memory)!: rebuild plan layer on WorkflowDocument with named workflows ([caf5c91](https://github.com/mattapperson/noetic/commit/caf5c91))

### BREAKING CHANGE

* FlowSchema/FlowNode and validateFlow/walkFlow/flowDepth
are removed from @noetic-tools/memory and @noetic-tools/core
(packages/memory/src/memory/flow-schema.ts and
packages/core/src/patterns/flow.ts deleted). PlanState.planTree is now a
WorkflowDocument and PlanState gains workflows.
PlanMemoryConfig.maxTreeDepth is renamed maxDepth; plan/setPlanTree
takes { document } instead of { tree }. Persisted legacy plan trees are
reset to null on load.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YaQitK6c9QsjU518ry8uX4

## @noetic-tools/memory-v2.0.0 (2026-07-26)

* feat(core): batch read on StorageAdapter, so ledger restore is not an N+1 ([6bb7b87](https://github.com/mattapperson/noetic/commit/6bb7b87)), closes [#58](https://github.com/mattapperson/noetic/issues/58)

### BREAKING CHANGE

* `ScopedStorage` gains a required `getMany` method. Code
that implements the interface directly — in practice only test doubles, as
the framework constructs the real one via `createScopedStorage` — must add
it. `StorageAdapter.getMany` is optional and breaks nothing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Bp3JE94xvmxr4WWZ2bYjJJ

## @noetic-tools/memory-v1.1.0 (2026-07-24)

* feat(memory): give durable-task-state a write API and a fan-out-safe merge ([f09d5b0](https://github.com/mattapperson/noetic/commit/f09d5b0))

## @noetic-tools/memory-v1.0.3 (2026-07-20)

* fix(memory): accept plan/setPlanTree tree as object or JSON string ([25a4a72](https://github.com/mattapperson/noetic/commit/25a4a72))

## @noetic-tools/memory-v1.0.2 (2026-07-20)

* fix(memory): wrap plan/setPlanTree input in an object ([8f6f0ba](https://github.com/mattapperson/noetic/commit/8f6f0ba))

## @noetic-tools/memory-v1.0.1 (2026-06-10)

* fix: skip uninitialized layers, strip bun exports ([3c83c57](https://github.com/mattapperson/noetic/commit/3c83c57))

## @noetic-tools/memory-v1.0.0 (2026-06-10)

* feat(memory)!: harden layers, budget, lifecycle ([39cc778](https://github.com/mattapperson/noetic/commit/39cc778))
* build: resolve workspace deps to src via bun export condition ([b774d38](https://github.com/mattapperson/noetic/commit/b774d38))

### BREAKING CHANGE

* durableTaskState() no longer accepts a config
object; DurableTaskStateConfig and DurableTaskStateSerializer
are removed.

## @noetic-tools/memory-v0.2.0 (2026-06-08)

* fix(core): address adversarial review findings in memory layers ([bac97a0](https://github.com/mattapperson/noetic/commit/bac97a0))
* fix(core): durable-task-state persistence + steering guidance/casing/retries ([17a8ae8](https://github.com/mattapperson/noetic/commit/17a8ae8))
* fix(core): lifecycle consistency + fail-loud init for memory layers ([6b0bd01](https://github.com/mattapperson/noetic/commit/6b0bd01))
* fix(core): per-layer memory bugs (budget, dedup, merge, capture, recovery) ([1092992](https://github.com/mattapperson/noetic/commit/1092992))
* fix(core): repair plan memory layer state machine and recall ([55e961f](https://github.com/mattapperson/noetic/commit/55e961f))
* feat(core): wire budget allocation, recall modes, assembleView cap, and re-render ([32e9f99](https://github.com/mattapperson/noetic/commit/32e9f99))
* refactor(core): extract memory layer system into @noetic-tools/memory + @noetic-tools/types (#39) ([4a4adc5](https://github.com/mattapperson/noetic/commit/4a4adc5)), closes [#39](https://github.com/mattapperson/noetic/issues/39) [#36](https://github.com/mattapperson/noetic/issues/36)
