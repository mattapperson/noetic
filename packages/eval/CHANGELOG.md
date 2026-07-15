## @noetic-tools/eval-v1.0.0 (2026-07-15)

* [codex] Add noetic plan-act code agent workflow (#36) ([8a41820](https://github.com/mattapperson/noetic/commit/8a41820)), closes [#36](https://github.com/mattapperson/noetic/issues/36)
* Combine these commits into a single commit message. ([e41abb2](https://github.com/mattapperson/noetic/commit/e41abb2))
* refactor(core,cli,eval,code-agent): break 12 import cycles to raise sentrux quality signal ([420ce8a](https://github.com/mattapperson/noetic/commit/420ce8a))
* refactor(eval)!: rename @noetic/eval to @noetic-tools/eval ([382cfa8](https://github.com/mattapperson/noetic/commit/382cfa8))
* feat: add @noetic/eval package for scored evaluation and optimization ([503d4ef](https://github.com/mattapperson/noetic/commit/503d4ef))
* feat: add testing spec, coverage scripts, and CI workflow ([1da8cfb](https://github.com/mattapperson/noetic/commit/1da8cfb))
* feat(core): rename to @noetic-tools/core, publish to npm, add release workflow ([9098b98](https://github.com/mattapperson/noetic/commit/9098b98))
* feat(core): run node, dynamic fork, and server tools in the JSON workflow runtime (#53) ([50416d1](https://github.com/mattapperson/noetic/commit/50416d1)), closes [#53](https://github.com/mattapperson/noetic/issues/53)
* feat(dx): implement DX spec 19 — export visibility, NoeticConfigError, JSDoc, CI scripts ([42cec28](https://github.com/mattapperson/noetic/commit/42cec28))
* feat(eval): add eval suites for skill patterns and widen describe() API ([092bc86](https://github.com/mattapperson/noetic/commit/092bc86))
* feat(eval): make @noetic/eval publishable to npm ([46a1511](https://github.com/mattapperson/noetic/commit/46a1511))
* feat(eval): remove callModel from eval config, add AST source discovery ([43027bb](https://github.com/mattapperson/noetic/commit/43027bb))
* feat(eval): wire AxGEPA optimization and fix eval framework bugs ([63aa005](https://github.com/mattapperson/noetic/commit/63aa005))
* fix: small TUI bugs, dev-loop ergonomics, and post-merge type/docs gaps (#45) ([2757902](https://github.com/mattapperson/noetic/commit/2757902)), closes [#45](https://github.com/mattapperson/noetic/issues/45)
* fix(core): init/recall/persist memory on harness.run() path (#49) ([3075d47](https://github.com/mattapperson/noetic/commit/3075d47)), closes [#49](https://github.com/mattapperson/noetic/issues/49) [#48](https://github.com/mattapperson/noetic/issues/48) [#48](https://github.com/mattapperson/noetic/issues/48)
* fix(core): wire step instructions through to LLM calls ([2193399](https://github.com/mattapperson/noetic/commit/2193399))
* fix(eval): exclude eval file from AST source discovery ([0dcc4bc](https://github.com/mattapperson/noetic/commit/0dcc4bc))
* fix(eval): fix typecheck errors, test failures, and stale model IDs ([f966cc1](https://github.com/mattapperson/noetic/commit/f966cc1))
* fix(eval): harden CLI, GEPA, scorers, write-back ([e64b252](https://github.com/mattapperson/noetic/commit/e64b252))
* build: resolve workspace deps to src via bun export condition ([b774d38](https://github.com/mattapperson/noetic/commit/b774d38))
* refactor: extract @noetic/code-agent package from cli ([4db3563](https://github.com/mattapperson/noetic/commit/4db3563))
* refactor: rename Runtime to AgentHarness across codebase ([e495095](https://github.com/mattapperson/noetic/commit/e495095))
* refactor(core): extract memory layer system into @noetic-tools/memory + @noetic-tools/types (#39) ([4a4adc5](https://github.com/mattapperson/noetic/commit/4a4adc5)), closes [#39](https://github.com/mattapperson/noetic/issues/39) [#36](https://github.com/mattapperson/noetic/issues/36)
* refactor(core): rename InMemoryAgentHarness to AgentHarness ([4fb5b22](https://github.com/mattapperson/noetic/commit/4fb5b22))
* refactor(core): replace CallModelFn with LlmProviderConfig and harness-owned OpenRouter client ([2d1d3c7](https://github.com/mattapperson/noetic/commit/2d1d3c7))
* chore: improve structural quality gates ([122d7ca](https://github.com/mattapperson/noetic/commit/122d7ca))
* chore: remove internal barrel files (#28) ([43523d1](https://github.com/mattapperson/noetic/commit/43523d1)), closes [#28](https://github.com/mattapperson/noetic/issues/28)

### BREAKING CHANGE

* the package is now @noetic-tools/eval. It has never been
published under @noetic/eval, so no released consumer is affected.

Two documented-but-broken imports surfaced while renaming their call sites:
- the adapters field-mappings module (documented in the eval skill) had no
  exports entry, so `@noetic-tools/eval/adapters/field-mappings/vercel-ai`
  would fail with ERR_PACKAGE_PATH_NOT_EXPORTED for published consumers.
  Added a subpath export; verified from a packed tarball.
- the root README imported { answerRelevancy, completeness } from a
  '/scorers' subpath that exports neither (scorers/index.ts exports only the
  `scorer` namespace), and used describe/it signatures that do not exist.
  Rewritten against the real API and typechecked.

Verified: biome + typecheck clean; tests match main (224 pass, 3 pre-existing
online-suite failures); packed tarball installs into a clean project and both
the root and subpath imports resolve under plain Node.
