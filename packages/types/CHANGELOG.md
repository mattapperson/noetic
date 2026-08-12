## @noetic-tools/types-v3.2.0 (2026-08-12)

* feat(core): support Standard Schema validators (#67) ([1751b6a](https://github.com/mattapperson/noetic/commit/1751b6a)), closes [#67](https://github.com/mattapperson/noetic/issues/67)

## @noetic-tools/types-v3.1.0 (2026-08-03)

* feat(types): add context-layer placement, renderDelta, and cache-anchoring types ([c7f53b4](https://github.com/mattapperson/noetic/commit/c7f53b4))

## @noetic-tools/types-v3.0.0 (2026-08-02)

* feat(core): add chat-sdk.dev integration and external channel read surface (#66) ([793f441](https://github.com/mattapperson/noetic/commit/793f441)), closes [#66](https://github.com/mattapperson/noetic/issues/66)

### BREAKING CHANGE

* AgentHarnessContract and the context-side harness
interface gain getChannelStream, and completed executions now close
their external channels — ChannelHandle.send after the root execution
finishes throws channel_closed where it previously silently succeeded.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HkrR1XYrDR5fo7tsYQW4be

## @noetic-tools/types-v2.3.0 (2026-08-02)

* feat: rename the memory layer system to context layers ([123810f](https://github.com/mattapperson/noetic/commit/123810f))

## @noetic-tools/types-v2.2.0 (2026-08-02)

* feat(core): add subflow workflow node with named sub-workflow registry ([82c2529](https://github.com/mattapperson/noetic/commit/82c2529))
* feat(types): host the JSON workflow schema (moved from @noetic-tools/core) ([7f37ad6](https://github.com/mattapperson/noetic/commit/7f37ad6))

## @noetic-tools/types-v2.1.1 (2026-07-26)

* fix(core): cascade abort to child contexts and implement harness.cancel ([6d36c97](https://github.com/mattapperson/noetic/commit/6d36c97))

## @noetic-tools/types-v2.1.0 (2026-07-26)

* feat(core): let restore() take the caller's context wiring ([2f28912](https://github.com/mattapperson/noetic/commit/2f28912)), closes [#59](https://github.com/mattapperson/noetic/issues/59)

## @noetic-tools/types-v2.0.0 (2026-07-26)

* feat(core): batch read on StorageAdapter, so ledger restore is not an N+1 ([6bb7b87](https://github.com/mattapperson/noetic/commit/6bb7b87)), closes [#58](https://github.com/mattapperson/noetic/issues/58)

### BREAKING CHANGE

* `ScopedStorage` gains a required `getMany` method. Code
that implements the interface directly — in practice only test doubles, as
the framework constructs the real one via `createScopedStorage` — must add
it. `StorageAdapter.getMany` is optional and breaks nothing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Bp3JE94xvmxr4WWZ2bYjJJ

## @noetic-tools/types-v1.4.0 (2026-07-24)

* feat(memory): give durable-task-state a write API and a fan-out-safe merge ([f09d5b0](https://github.com/mattapperson/noetic/commit/f09d5b0))

## @noetic-tools/types-v1.3.0 (2026-07-07)

* feat(core): generative UI via OpenUI (codec, surface layer, tool UI, transport) ([3a922d8](https://github.com/mattapperson/noetic/commit/3a922d8))

## @noetic-tools/types-v1.2.0 (2026-06-30)

* feat(core): run node, dynamic fork, and server tools in the JSON workflow runtime (#53) ([50416d1](https://github.com/mattapperson/noetic/commit/50416d1)), closes [#53](https://github.com/mattapperson/noetic/issues/53)

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
