## @noetic-tools/types-v1.1.0 (2026-06-27)

* feat(types): add 'noetic' LLM provider option and baseUrl override ([75e8c97](https://github.com/mattapperson/noetic/commit/75e8c97))

## @noetic-tools/types-v1.0.3 (2026-06-24)

* fix(core): link llm.call/tool.call spans to their workflow node (NoeticAttr.NODE_ID) (#51) ([a8bcfd2](https://github.com/mattapperson/noetic/commit/a8bcfd2)), closes [#51](https://github.com/mattapperson/noetic/issues/51)

## @noetic-tools/types-v1.0.2 (2026-06-23)

* fix(core): wire traceExporter into model-call and workflow run path ([7af5890](https://github.com/mattapperson/noetic/commit/7af5890)), closes [#50](https://github.com/mattapperson/noetic/issues/50)

## @noetic-tools/types-v1.0.1 (2026-06-14)

* Combine sub-harness steps for external coding agents ([314cb54](https://github.com/mattapperson/noetic/commit/314cb54))

## @noetic-tools/types-v1.0.0 (2026-06-10)

* ci: combine package releases into one sequential workflow ([cf54aef](https://github.com/mattapperson/noetic/commit/cf54aef))
* chore(types): release 1.0.0 [skip ci] ([940508c](https://github.com/mattapperson/noetic/commit/940508c))
* fix: tighten item schema and shell command gates ([6d58546](https://github.com/mattapperson/noetic/commit/6d58546))
* feat(core)!: add async channel send back-pressure ([dcbdafa](https://github.com/mattapperson/noetic/commit/dcbdafa))
* build: resolve workspace deps to src via bun export condition ([b774d38](https://github.com/mattapperson/noetic/commit/b774d38))

### BREAKING CHANGE

* Context.send, AgentHarnessContract.send, and
ContextHarness.send return Promise<void> instead of void. Full
queue channels park internal senders (back-pressure) rather than
dropping the new value; callers must await or explicitly handle
the returned promise.

## @noetic-tools/types-v0.1.1 (2026-06-08)

* refactor(core): extract memory layer system into @noetic-tools/memory + @noetic-tools/types (#39) ([4a4adc5](https://github.com/mattapperson/noetic/commit/4a4adc5)), closes [#39](https://github.com/mattapperson/noetic/issues/39) [#36](https://github.com/mattapperson/noetic/issues/36)
