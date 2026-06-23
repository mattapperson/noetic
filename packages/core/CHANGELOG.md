## @noetic-tools/core-v1.2.2 (2026-06-23)

* fix(core): wire traceExporter into model-call and workflow run path ([7af5890](https://github.com/mattapperson/noetic/commit/7af5890)), closes [#50](https://github.com/mattapperson/noetic/issues/50)

## @noetic-tools/core-v1.2.1 (2026-06-23)

* fix(core): init/recall/persist memory on harness.run() path (#49) ([3075d47](https://github.com/mattapperson/noetic/commit/3075d47)), closes [#49](https://github.com/mattapperson/noetic/issues/49) [#48](https://github.com/mattapperson/noetic/issues/48) [#48](https://github.com/mattapperson/noetic/issues/48)

## @noetic-tools/core-v1.2.0 (2026-06-15)

* feat(core): drive codeAgentWorkflow headlessly; SlopCodeBench uses it ([b959b8b](https://github.com/mattapperson/noetic/commit/b959b8b))

## @noetic-tools/core-v1.1.2 (2026-06-14)

* fix: small TUI bugs, dev-loop ergonomics, and post-merge type/docs gaps (#45) ([2757902](https://github.com/mattapperson/noetic/commit/2757902)), closes [#45](https://github.com/mattapperson/noetic/issues/45)
* Combine sub-harness steps for external coding agents ([314cb54](https://github.com/mattapperson/noetic/commit/314cb54))

## @noetic-tools/core-v1.1.1 (2026-06-14)

* fix(core): host workflow JSON schema so its $id URL resolves ([bc87e76](https://github.com/mattapperson/noetic/commit/bc87e76))

## @noetic-tools/core-v1.1.0 (2026-06-14)

* feat(core): publish JSON Schema for dynamic workflows + multi-model judge example ([d7add74](https://github.com/mattapperson/noetic/commit/d7add74))

## @noetic-tools/core-v1.0.0 (2026-06-10)

* fix: skip uninitialized layers, strip bun exports ([3c83c57](https://github.com/mattapperson/noetic/commit/3c83c57))
* fix: tighten item schema and shell command gates ([6d58546](https://github.com/mattapperson/noetic/commit/6d58546))
* feat(core)!: add async channel send back-pressure ([dcbdafa](https://github.com/mattapperson/noetic/commit/dcbdafa))
* feat(memory)!: harden layers, budget, lifecycle ([39cc778](https://github.com/mattapperson/noetic/commit/39cc778))
* build: resolve workspace deps to src via bun export condition ([b774d38](https://github.com/mattapperson/noetic/commit/b774d38))

### BREAKING CHANGE

* Context.send, AgentHarnessContract.send, and
ContextHarness.send return Promise<void> instead of void. Full
queue channels park internal senders (back-pressure) rather than
dropping the new value; callers must await or explicitly handle
the returned promise.
* durableTaskState() no longer accepts a config
object; DurableTaskStateConfig and DurableTaskStateSerializer
are removed.

## @noetic-tools/core-v0.3.0 (2026-06-08)

* fix(core): address adversarial review findings in memory layers ([bac97a0](https://github.com/mattapperson/noetic/commit/bac97a0))
* fix(core): durable-task-state persistence + steering guidance/casing/retries ([17a8ae8](https://github.com/mattapperson/noetic/commit/17a8ae8))
* fix(core): lifecycle consistency + fail-loud init for memory layers ([6b0bd01](https://github.com/mattapperson/noetic/commit/6b0bd01))
* fix(core): per-layer memory bugs (budget, dedup, merge, capture, recovery) ([1092992](https://github.com/mattapperson/noetic/commit/1092992))
* test(core): memory-layer audit tests (failing-by-design, prove layer bugs) [skip ci] ([f487dc6](https://github.com/mattapperson/noetic/commit/f487dc6))
* test(core): point memory audit tests at @noetic-tools/memory + types ([a4d17cc](https://github.com/mattapperson/noetic/commit/a4d17cc))
* feat(core): wire budget allocation, recall modes, assembleView cap, and re-render ([32e9f99](https://github.com/mattapperson/noetic/commit/32e9f99))
* refactor(core): extract memory layer system into @noetic-tools/memory + @noetic-tools/types (#39) ([4a4adc5](https://github.com/mattapperson/noetic/commit/4a4adc5)), closes [#39](https://github.com/mattapperson/noetic/issues/39) [#36](https://github.com/mattapperson/noetic/issues/36)

## @noetic-tools/core-v0.2.1 (2026-06-07)

* Combine these commits into a single commit message. ([e41abb2](https://github.com/mattapperson/noetic/commit/e41abb2))

## @noetic-tools/core-v0.2.0 (2026-06-05)

* feat(evals): add LongMemEval harness and temporal memory layer ([3df68cf](https://github.com/mattapperson/noetic/commit/3df68cf))

## @noetic-tools/core-v0.1.2 (2026-05-31)

* ci: default unsignalled core commits to a patch release ([afc473d](https://github.com/mattapperson/noetic/commit/afc473d))

## @noetic-tools/core-v0.1.1 (2026-05-30)

* fix(docs): correct model ids and Node ESM resolution ([3804935](https://github.com/mattapperson/noetic/commit/3804935))
* chore: remove internal barrel files (#28) ([43523d1](https://github.com/mattapperson/noetic/commit/43523d1)), closes [#28](https://github.com/mattapperson/noetic/issues/28)
* chore: rename @noetic/{cli,code-agent,platform-node} to @noetic-tools scope ([018991b](https://github.com/mattapperson/noetic/commit/018991b))

## @noetic-tools/core-v0.1.0 (2026-05-30)

* feat(core): add JSON workflow runtime — schema, hydrator, dynamic pattern ([436f57a](https://github.com/mattapperson/noetic/commit/436f57a))
* feat(core): align public API surface with framework docs ([180435c](https://github.com/mattapperson/noetic/commit/180435c))
* Docs site: NOETIC / section breadcrumb header + smaller mobile type (#37) ([e0bca9a](https://github.com/mattapperson/noetic/commit/e0bca9a)), closes [#37](https://github.com/mattapperson/noetic/issues/37)
