## @noetic-tools/context-v1.9.0 (2026-10-26)

* feat(core): add infinite loops, recursive subflows, and decide-driven loop exits to JSON workflows ([c9c201a](https://github.com/mattapperson/noetic/commit/c9c201a))

## @noetic-tools/context-v1.8.0 (2026-10-25)

* feat(core): toolChoice, needsApproval enforcement, onParentUpdate and layer hook spans (#128) ([f0db6cd](https://github.com/mattapperson/noetic/commit/f0db6cd)), closes [#128](https://github.com/mattapperson/noetic/issues/128) [#124](https://github.com/mattapperson/noetic/issues/124) [#121](https://github.com/mattapperson/noetic/issues/121) [#122](https://github.com/mattapperson/noetic/issues/122) [#123](https://github.com/mattapperson/noetic/issues/123)

## @noetic-tools/context-v1.7.0 (2026-10-25)

* feat(core): fix spec mismatches in step variants, spawn and observability (#124) ([ab46b6a](https://github.com/mattapperson/noetic/commit/ab46b6a)), closes [#124](https://github.com/mattapperson/noetic/issues/124) [#121](https://github.com/mattapperson/noetic/issues/121) [#122](https://github.com/mattapperson/noetic/issues/122) [#123](https://github.com/mattapperson/noetic/issues/123) [#121](https://github.com/mattapperson/noetic/issues/121) [#122](https://github.com/mattapperson/noetic/issues/122) [#123](https://github.com/mattapperson/noetic/issues/123) [#121](https://github.com/mattapperson/noetic/issues/121) [#122](https://github.com/mattapperson/noetic/issues/122) [#123](https://github.com/mattapperson/noetic/issues/123)

## @noetic-tools/context-v1.6.0 (2026-10-24)

* feat(core): error model fixes and replay follow-ups for #111 and #115 (#119) ([d85827e](https://github.com/mattapperson/noetic/commit/d85827e)), closes [#111](https://github.com/mattapperson/noetic/issues/111) [#115](https://github.com/mattapperson/noetic/issues/115) [#119](https://github.com/mattapperson/noetic/issues/119) [#117](https://github.com/mattapperson/noetic/issues/117) [#115](https://github.com/mattapperson/noetic/issues/115) [#115](https://github.com/mattapperson/noetic/issues/115) [#111](https://github.com/mattapperson/noetic/issues/111) [#115](https://github.com/mattapperson/noetic/issues/115) [#111](https://github.com/mattapperson/noetic/issues/111) [#101](https://github.com/mattapperson/noetic/issues/101)

## @noetic-tools/context-v1.5.0 (2026-10-24)

* feat(core): release fixes for issues #110–#117 (#118) ([529c45d](https://github.com/mattapperson/noetic/commit/529c45d)), closes [#117](https://github.com/mattapperson/noetic/issues/117) [#118](https://github.com/mattapperson/noetic/issues/118) [#110](https://github.com/mattapperson/noetic/issues/110) [#112](https://github.com/mattapperson/noetic/issues/112) [#115](https://github.com/mattapperson/noetic/issues/115) [#110](https://github.com/mattapperson/noetic/issues/110) [#115](https://github.com/mattapperson/noetic/issues/115) [#114](https://github.com/mattapperson/noetic/issues/114) [#111](https://github.com/mattapperson/noetic/issues/111) [#111](https://github.com/mattapperson/noetic/issues/111) [#112](https://github.com/mattapperson/noetic/issues/112) [#113](https://github.com/mattapperson/noetic/issues/113) [#116](https://github.com/mattapperson/noetic/issues/116) [#110](https://github.com/mattapperson/noetic/issues/110) [#114](https://github.com/mattapperson/noetic/issues/114) [#115](https://github.com/mattapperson/noetic/issues/115) [#117](https://github.com/mattapperson/noetic/issues/117) [#110](https://github.com/mattapperson/noetic/issues/110)

## @noetic-tools/context-v1.4.0 (2026-10-21)

* feat(core): add decide step, routeSwitch, and decisionsHistoryLayer (#108) ([ad0215c](https://github.com/mattapperson/noetic/commit/ad0215c)), closes [#108](https://github.com/mattapperson/noetic/issues/108)

## @noetic-tools/context-v1.3.0 (2026-08-19)

* feat(acp): serve a harness as an ACP agent ([68bdc20](https://github.com/mattapperson/noetic/commit/68bdc20))

## @noetic-tools/context-v1.2.2 (2026-08-14)

* feat!: replace the sub-harness system with an Agent Client Protocol client (#89) ([eb4710d](https://github.com/mattapperson/noetic/commit/eb4710d)), closes [#89](https://github.com/mattapperson/noetic/issues/89)

## @noetic-tools/context-v1.2.1 (2026-08-12)

* feat!: unify Noetic public API naming (#68) ([38cb18f](https://github.com/mattapperson/noetic/commit/38cb18f)), closes [#68](https://github.com/mattapperson/noetic/issues/68)

## @noetic-tools/context-v1.2.0 (2026-08-03)

* feat(context): band the assembled view and pin anchored layers ([9fa94f4](https://github.com/mattapperson/noetic/commit/9fa94f4))

## @noetic-tools/context-v1.1.0 (2026-08-03)

* feat(context): rebuild the plan-mode briefing and hold recall to its budget ([4ea86e1](https://github.com/mattapperson/noetic/commit/4ea86e1))

## @noetic-tools/context-v1.0.0 (2026-08-02)

* chore(context): start the version line at 1.0.0 ([636a245](https://github.com/mattapperson/noetic/commit/636a245))
* fix: apply the rename to work that landed on main during the rebase ([aee8f21](https://github.com/mattapperson/noetic/commit/aee8f21))
* feat: rename the memory layer system to context layers ([123810f](https://github.com/mattapperson/noetic/commit/123810f))

# @noetic-tools/context

This package starts its version line at `1.0.0`. It is the continuation of
`@noetic-tools/memory`, renamed when the memory layer system became the context
layer system, but it publishes under a new npm name and so starts a new version
line rather than continuing from `@noetic-tools/memory@3.0.0`.

Every release up to and including `3.0.0` was published as
`@noetic-tools/memory`. That history is preserved verbatim in
[`packages/memory/CHANGELOG.md`](../memory/CHANGELOG.md), next to the
deprecation shim that still carries the old package name.

Entries below are generated by semantic-release.
