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
