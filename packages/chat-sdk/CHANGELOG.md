## @noetic-tools/chat-sdk-v1.1.0 (2026-11-03)

* ci: publish prereleases from next to the next dist-tag (#152) ([0b247bc](https://github.com/mattapperson/noetic/commit/0b247bc)), closes [#152](https://github.com/mattapperson/noetic/issues/152)
* fix(core): keep harness mirrors and docs in step with the drain report ([3fd203f](https://github.com/mattapperson/noetic/commit/3fd203f))
* feat(core): release fixes for issues #110–#117 (#118) ([529c45d](https://github.com/mattapperson/noetic/commit/529c45d)), closes [#117](https://github.com/mattapperson/noetic/issues/117) [#118](https://github.com/mattapperson/noetic/issues/118) [#110](https://github.com/mattapperson/noetic/issues/110) [#112](https://github.com/mattapperson/noetic/issues/112) [#115](https://github.com/mattapperson/noetic/issues/115) [#110](https://github.com/mattapperson/noetic/issues/110) [#115](https://github.com/mattapperson/noetic/issues/115) [#114](https://github.com/mattapperson/noetic/issues/114) [#111](https://github.com/mattapperson/noetic/issues/111) [#111](https://github.com/mattapperson/noetic/issues/111) [#112](https://github.com/mattapperson/noetic/issues/112) [#113](https://github.com/mattapperson/noetic/issues/113) [#116](https://github.com/mattapperson/noetic/issues/116) [#110](https://github.com/mattapperson/noetic/issues/110) [#114](https://github.com/mattapperson/noetic/issues/114) [#115](https://github.com/mattapperson/noetic/issues/115) [#117](https://github.com/mattapperson/noetic/issues/117) [#110](https://github.com/mattapperson/noetic/issues/110)
* feat(core): steer a running turn with next-item delivery and onSteer layers (#139) ([bb468d8](https://github.com/mattapperson/noetic/commit/bb468d8)), closes [#139](https://github.com/mattapperson/noetic/issues/139)
* feat(core): toolChoice, needsApproval enforcement, onParentUpdate and layer hook spans (#128) ([f0db6cd](https://github.com/mattapperson/noetic/commit/f0db6cd)), closes [#128](https://github.com/mattapperson/noetic/issues/128) [#124](https://github.com/mattapperson/noetic/issues/124) [#121](https://github.com/mattapperson/noetic/issues/121) [#122](https://github.com/mattapperson/noetic/issues/122) [#123](https://github.com/mattapperson/noetic/issues/123)

## @noetic-tools/chat-sdk-v1.0.0 (2026-10-21)

* Docs site: NOETIC / section breadcrumb header + smaller mobile type (#37) ([e0bca9a](https://github.com/mattapperson/noetic/commit/e0bca9a)), closes [#37](https://github.com/mattapperson/noetic/issues/37)
* feat!: unify Noetic public API naming (#68) ([38cb18f](https://github.com/mattapperson/noetic/commit/38cb18f)), closes [#68](https://github.com/mattapperson/noetic/issues/68)
* feat(core,cli,chat-sdk): inbox-style message queue on AgentHarness (#32) ([dca9e93](https://github.com/mattapperson/noetic/commit/dca9e93)), closes [#32](https://github.com/mattapperson/noetic/issues/32)
* feat(chat-sdk): add @noetic/chat-sdk adapter package for chat-sdk.dev ([0680d89](https://github.com/mattapperson/noetic/commit/0680d89))
* feat(core): add chat-sdk.dev integration and external channel read surface (#66) ([793f441](https://github.com/mattapperson/noetic/commit/793f441)), closes [#66](https://github.com/mattapperson/noetic/issues/66)
* feat(core): rename to @noetic-tools/core, publish to npm, add release workflow ([9098b98](https://github.com/mattapperson/noetic/commit/9098b98))
* feat(core): support Standard Schema validators (#67) ([1751b6a](https://github.com/mattapperson/noetic/commit/1751b6a)), closes [#67](https://github.com/mattapperson/noetic/issues/67)
* refactor: remove @noetic/chat-sdk and @noetic/mirage packages ([9f38b34](https://github.com/mattapperson/noetic/commit/9f38b34))
* refactor(core): extract memory layer system into @noetic-tools/memory + @noetic-tools/types (#39) ([4a4adc5](https://github.com/mattapperson/noetic/commit/4a4adc5)), closes [#39](https://github.com/mattapperson/noetic/issues/39) [#36](https://github.com/mattapperson/noetic/issues/36)
* fix: resolve CI lint and typecheck failures on main (#26) ([db25ed9](https://github.com/mattapperson/noetic/commit/db25ed9)), closes [#26](https://github.com/mattapperson/noetic/issues/26)

### BREAKING CHANGE

* AgentHarnessContract and the context-side harness
interface gain getChannelStream, and completed executions now close
their external channels — ChannelHandle.send after the root execution
finishes throws channel_closed where it previously silently succeeded.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HkrR1XYrDR5fo7tsYQW4be

# @noetic-tools/chat-sdk
