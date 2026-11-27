## @noetic-tools/acp-v2.0.0-next.11 (2026-11-27)

* feat: say in a JSON workflow document everything a TypeScript workflow can (#185) ([d448249](https://github.com/mattapperson/noetic/commit/d448249)), closes [#185](https://github.com/mattapperson/noetic/issues/185) [#184](https://github.com/mattapperson/noetic/issues/184) [#182](https://github.com/mattapperson/noetic/issues/182) [#184](https://github.com/mattapperson/noetic/issues/184) [#184](https://github.com/mattapperson/noetic/issues/184)

## @noetic-tools/acp-v2.0.0-next.10 (2026-11-26)

* feat!: one subprocess adapter concept, and named fs, shell and subprocess adapters (#182) ([096c64d](https://github.com/mattapperson/noetic/commit/096c64d)), closes [#182](https://github.com/mattapperson/noetic/issues/182)

## @noetic-tools/acp-v2.0.0-next.9 (2026-11-26)

* Read Codex quota usage from ACP prompt replies (#176) ([68084b9](https://github.com/mattapperson/noetic/commit/68084b9)), closes [#176](https://github.com/mattapperson/noetic/issues/176)

## @noetic-tools/acp-v2.0.0-next.8 (2026-11-26)

* feat(acp): tell localMachine's wrap the variables the agent sets (#175) ([928c91f](https://github.com/mattapperson/noetic/commit/928c91f)), closes [#175](https://github.com/mattapperson/noetic/issues/175)

## @noetic-tools/acp-v2.0.0-next.7 (2026-11-26)

* feat(acp): what a host that starts its own agents reads from noetic (#174) ([e21dfed](https://github.com/mattapperson/noetic/commit/e21dfed)), closes [#174](https://github.com/mattapperson/noetic/issues/174) [#171](https://github.com/mattapperson/noetic/issues/171)

## @noetic-tools/acp-v2.0.0-next.6 (2026-11-26)

* feat: an agent's tool calls, plans and settings reach the host in one vocabulary (#172) ([cf712bf](https://github.com/mattapperson/noetic/commit/cf712bf)), closes [#172](https://github.com/mattapperson/noetic/issues/172) [#170](https://github.com/mattapperson/noetic/issues/170)

## @noetic-tools/acp-v2.0.0-next.5 (2026-11-25)

* feat: an agent step's turn reaches the host as a model call's does (#171) ([196b1e1](https://github.com/mattapperson/noetic/commit/196b1e1)), closes [#171](https://github.com/mattapperson/noetic/issues/171) [#169](https://github.com/mattapperson/noetic/issues/169)

## @noetic-tools/acp-v2.0.0-next.4 (2026-11-25)

* feat: an agent step's subagents are nested agents on the ordinary event stream (#170) ([31dd1b9](https://github.com/mattapperson/noetic/commit/31dd1b9)), closes [#170](https://github.com/mattapperson/noetic/issues/170) [#169](https://github.com/mattapperson/noetic/issues/169)

## @noetic-tools/acp-v2.0.0-next.3 (2026-11-25)

* feat: an agent step meets the host only through generic concepts (instructions, held questions, Noet ([858cdca](https://github.com/mattapperson/noetic/commit/858cdca)), closes [#169](https://github.com/mattapperson/noetic/issues/169)

### BREAKING CHANGE

* An ACP step's host-facing surface is generic.
`instructions` replaces `systemPrompt`, vendor `_meta` moves to the
adapter (`sessionMeta`), and the step options `onElicitation` /
`onSubagentUpdate` are gone: an agent's questions are held calls with
`reason: 'question'` (MCP `input_required` too), offered by default.
`HeldCall.reason` gains `'question'`. ACP steps throw
`NoeticConfigError` `AGENT_CAPABILITY_MISSING` or `NoeticError`
`step_failed`, never `AcpCapabilityError` / `AcpConnectError`.
`AcpAgentConnection` requires `fingerprintFor`;
`AcpBoundElicitationHandler` takes `AcpElicitationInfo`;
`AcpConnectError` has `gone`. A resume or reattach starts over only when
the agent is confirmed gone; any other failure fails the step.

Signed-off-by: Matt <me@mattapperson.com>

## @noetic-tools/acp-v2.0.0-next.2 (2026-11-25)

* feat(acp): native host support for #96–#100, agents that outlive their host, and reattach (#167) ([3953c32](https://github.com/mattapperson/noetic/commit/3953c32)), closes [#100](https://github.com/mattapperson/noetic/issues/100) [#167](https://github.com/mattapperson/noetic/issues/167) [#156](https://github.com/mattapperson/noetic/issues/156)

## @noetic-tools/acp-v2.0.0-next.1 (2026-11-25)

* fix: an approval never times out unless a timeout is set ([b4c762d](https://github.com/mattapperson/noetic/commit/b4c762d))
* fix(core): a decision that cannot be taken is refused, not half applied ([7d07818](https://github.com/mattapperson/noetic/commit/7d07818))
* feat: one approval seam for every path that asks a person ([f2979cc](https://github.com/mattapperson/noetic/commit/f2979cc))

### BREAKING CHANGE

* a step's call to a connection operation that needs
approval, on a harness with no approveToolCall, is held instead of
denied. A coding agent's permission request that nothing settles, on a
step whose policy names no default, is held instead of denied; name
`default: 'deny'` to keep the old behavior.

Specs 08, 12, 23, 27, 29, 31 and 35, the matching docs, and the
agent-builder skill are updated.

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>

## @noetic-tools/acp-v1.4.0 (2026-11-04)

* feat: one way to attach MCP servers, served to every agent (#156) ([2195f69](https://github.com/mattapperson/noetic/commit/2195f69)), closes [#156](https://github.com/mattapperson/noetic/issues/156)

## @noetic-tools/acp-v1.3.1 (2026-10-30)

* ci: publish prereleases from next to the next dist-tag (#152) ([0b247bc](https://github.com/mattapperson/noetic/commit/0b247bc)), closes [#152](https://github.com/mattapperson/noetic/issues/152)

## @noetic-tools/acp-v1.3.1-next.2 (2026-10-30)

* fix: close the harness review gaps and pass the structural gate ([a8d710b](https://github.com/mattapperson/noetic/commit/a8d710b))

## @noetic-tools/acp-v1.3.1-next.1 (2026-10-29)

* ci: publish prereleases from next to the next dist-tag ([5c9f714](https://github.com/mattapperson/noetic/commit/5c9f714))

## @noetic-tools/acp-v1.3.0 (2026-10-27)

* feat(core): resolve graceful stops with a drain report that carries each call's cost ([1250357](https://github.com/mattapperson/noetic/commit/1250357)), closes [#148](https://github.com/mattapperson/noetic/issues/148)

## @noetic-tools/acp-v1.2.0 (2026-10-24)

* feat(core): release fixes for issues #110–#117 (#118) ([529c45d](https://github.com/mattapperson/noetic/commit/529c45d)), closes [#117](https://github.com/mattapperson/noetic/issues/117) [#118](https://github.com/mattapperson/noetic/issues/118) [#110](https://github.com/mattapperson/noetic/issues/110) [#112](https://github.com/mattapperson/noetic/issues/112) [#115](https://github.com/mattapperson/noetic/issues/115) [#110](https://github.com/mattapperson/noetic/issues/110) [#115](https://github.com/mattapperson/noetic/issues/115) [#114](https://github.com/mattapperson/noetic/issues/114) [#111](https://github.com/mattapperson/noetic/issues/111) [#111](https://github.com/mattapperson/noetic/issues/111) [#112](https://github.com/mattapperson/noetic/issues/112) [#113](https://github.com/mattapperson/noetic/issues/113) [#116](https://github.com/mattapperson/noetic/issues/116) [#110](https://github.com/mattapperson/noetic/issues/110) [#114](https://github.com/mattapperson/noetic/issues/114) [#115](https://github.com/mattapperson/noetic/issues/115) [#117](https://github.com/mattapperson/noetic/issues/117) [#110](https://github.com/mattapperson/noetic/issues/110)

## @noetic-tools/acp-v1.1.1 (2026-08-19)

* fix(acp): green CI on main — kiira subpath mapping and complexity refactors ([dd3c4e1](https://github.com/mattapperson/noetic/commit/dd3c4e1))

## @noetic-tools/acp-v1.1.0 (2026-08-19)

* feat(acp): serve a harness as an ACP agent ([68bdc20](https://github.com/mattapperson/noetic/commit/68bdc20))

## @noetic-tools/acp-v1.0.0 (2026-08-14)

* feat!: replace the sub-harness system with an Agent Client Protocol client (#89) ([eb4710d](https://github.com/mattapperson/noetic/commit/eb4710d)), closes [#89](https://github.com/mattapperson/noetic/issues/89)
