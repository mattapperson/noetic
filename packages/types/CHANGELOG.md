## @noetic-tools/types-v1.0.0 (2026-06-10)

* fix: tighten item schema and shell command gates ([6d58546](https://github.com/mattapperson/noetic/commit/6d58546))
* feat(core)!: add async channel send back-pressure ([dcbdafa](https://github.com/mattapperson/noetic/commit/dcbdafa))
* build: resolve workspace deps to src via bun export condition ([b774d38](https://github.com/mattapperson/noetic/commit/b774d38))

### BREAKING CHANGE

* Context.send, AgentHarnessContract.send, and
ContextHarness.send return Promise<void> instead of void. Full
queue channels park internal senders (back-pressure) rather than
dropping the new value; callers must await or explicitly handle
the returned promise.

## @noetic-tools/types-v0.2.0 (2026-06-08)

* fix(core): lifecycle consistency + fail-loud init for memory layers ([6b0bd01](https://github.com/mattapperson/noetic/commit/6b0bd01))
* fix(core): per-layer memory bugs (budget, dedup, merge, capture, recovery) ([1092992](https://github.com/mattapperson/noetic/commit/1092992))
* feat(core): wire budget allocation, recall modes, assembleView cap, and re-render ([32e9f99](https://github.com/mattapperson/noetic/commit/32e9f99))

## @noetic-tools/types-v0.1.1 (2026-06-08)

* refactor(core): extract memory layer system into @noetic-tools/memory + @noetic-tools/types (#39) ([4a4adc5](https://github.com/mattapperson/noetic/commit/4a4adc5)), closes [#39](https://github.com/mattapperson/noetic/issues/39) [#36](https://github.com/mattapperson/noetic/issues/36)
