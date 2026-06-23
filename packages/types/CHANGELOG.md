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
