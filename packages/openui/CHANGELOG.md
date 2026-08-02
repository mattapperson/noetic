## @noetic-tools/openui-v2.1.0 (2026-08-02)

* feat: rename the memory layer system to context layers ([123810f](https://github.com/mattapperson/noetic/commit/123810f))

## @noetic-tools/openui-v2.0.0 (2026-07-26)

* feat(core): batch read on StorageAdapter, so ledger restore is not an N+1 ([6bb7b87](https://github.com/mattapperson/noetic/commit/6bb7b87)), closes [#58](https://github.com/mattapperson/noetic/issues/58)

### BREAKING CHANGE

* `ScopedStorage` gains a required `getMany` method. Code
that implements the interface directly — in practice only test doubles, as
the framework constructs the real one via `createScopedStorage` — must add
it. `StorageAdapter.getMany` is optional and breaks nothing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Bp3JE94xvmxr4WWZ2bYjJJ

## @noetic-tools/openui-v1.1.1 (2026-07-24)

* fix(web): make the generative-UI docs typecheck ([211dea9](https://github.com/mattapperson/noetic/commit/211dea9))

## @noetic-tools/openui-v1.1.0 (2026-07-24)

* feat(memory): give durable-task-state a write API and a fan-out-safe merge ([f09d5b0](https://github.com/mattapperson/noetic/commit/f09d5b0))

## @noetic-tools/openui-v1.0.0 (2026-07-08)

* ci(release): publish @noetic-tools/openui to npm ([f2a1fd7](https://github.com/mattapperson/noetic/commit/f2a1fd7))
* fix(core): make serveOpenUi stream the rendered UI end-to-end ([c579315](https://github.com/mattapperson/noetic/commit/c579315))
* feat(core): generative UI via OpenUI (codec, surface layer, tool UI, transport) ([3a922d8](https://github.com/mattapperson/noetic/commit/3a922d8))
