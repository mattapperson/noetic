# OpenRouter fork upstreaming plan

Status: active
Owner: Pi orchestrator in Herdr workspace `w10`
Upstream base: `origin/main` at `8a6665ba`
Source: `fork/port/openrouter-fixes` at `6df9b785` (old base `ead54108`)

## Objective

Semantically port the non-Standard-Schema improvements from `fork/port/openrouter-fixes` onto current `mattapperson/noetic` architecture as focused, independently reviewable pull requests. Historical commits are provenance, not patches: current source, specs, package boundaries, Standard Schema support from #67, and naming cutover from #68 are authoritative.

The program is complete only when every retained ledger item is either:

1. merged upstream;
2. an open, green, review-ready upstream PR with no unresolved feedback and explicit dependency state; or
3. dropped with concrete supersession or current-main evidence.

## Current-main overlap audit

Audit performed after fetching both remotes. `HEAD` and `origin/main` were both `8a6665ba`; source tip was `6df9b785`. Four independent read-only Pi audits compared the ledger against current symbols, specs, #67, #68, and PR #69.

### Naming and architecture adaptations

Historical names must not return:

| Historical source | Current main |
|---|---|
| `llm` / `step.llm` | `callModel` |
| `provide` | `withContext` |
| `every` | `schedule` |
| `branch` | `conditional` |
| `fork` | `inParallel` |
| `run` | `runCode` |
| memory / working-memory symbols | context / `scratchpad` / current layer names |
| `patterns/dynamic-workflow` | `builders/dynamic-workflow` |

`packages/context` remains dependent only on `packages/types`. Core must not import platform, OpenUI, or sub-harness adapter packages. Workflow ports must not recreate the historical builder-to-adapter Sentrux violation.

### Already upstream, superseded, or intentionally dropped

| Source/change | Disposition | Evidence |
|---|---|---|
| Standard Schema work | Dropped | Merged in #67 (`1751b6a9`); current OpenRouter adapter uses the shared Standard Schema validation path. |
| Tool-argument validation from `0e63664d` | Validation half dropped | Equivalent validation is in #67. Only resolved-tool lookup/memoization remains eligible under item 10. |
| `a792e90a` baseline cleanup | Dropped as a commit | Its old `fork` test hunk is superseded by #68 `inParallel`/`frameworkCast`; eval provider setup is now `callModelDefaults` + `resolveEnvLlm`; the lifecycle type widening is unrelated and has no demonstrated current failure. |
| Historical `UPSTREAMING.md` | Not ported | Used only for intent/provenance; durable facts belong in owning PR bodies, specs, docs, and tests. |
| Branch-specific drift tests | Not ported | Current behavior receives focused regression tests in each owning PR. |
| Unsupported `~60x` checkpoint claim | Omitted | Item 13 may make complexity claims; quantified claims require a committed reproducible benchmark. |
| Public bundled pattern layout from item 19 | Not ported without design approval | #68 removed `packages/core/src/patterns`; `specs/13-patterns.md` normatively says core ships no bundled agent patterns. |
| PR #69 behavior | Separate | [#69](https://github.com/mattapperson/noetic/pull/69) owns EventBroadcaster watermark trimming and latest-only generator progress. Item 11 must not touch those behaviors/files. |

### Item-by-item audit and PR ledger

States: `queued`, `implementing`, `review`, `open`, `merged`, `dropped`, `design-review`, `blocked`.

| # | Planned PR | Current-main audit | Dependencies | State | Branch / PR / evidence |
|---:|---|---|---|---|---|
| 1 | File-storage encoding, async writes, legacy reads | Absent: `packages/platform-node/src/file-storage.ts` still uses lossy single-phase encoding and sync filesystem operations; no legacy fallback. | none | queued | source `b9905ac5` + `653b3986` |
| 2 | Durable queue and subprocess IPC ordering | Absent: queue `clear()` resets sequence, ack scans storage, IPC dispatch is unsequenced, error frames are uncorrelated, subprocess identity uses spawned `ps`. Keep as one platform PR unless review shows queue vs IPC is materially clearer split. | soft after 1 to reduce platform conflicts | queued | remainder of `b9905ac5` |
| 3 | Sub-harness session/turn reliability | Absent: session cache stores sessions rather than in-flight promises; no turn idle watchdog, error-finish failure, or reasoning item retention. | none | queued | `0fd1b9ef` |
| 4 | Eval dirty-write guard and bounded case concurrency | Absent: no write guard/run pool, suite cases remain serial, dead `--budget` remains. | none | queued | first part of `aedf712f` |
| 5 | GEPA discovery, traversal, judge reuse | Absent: scope discovery, stable tool paths, composite traversal, and harness reuse gaps remain. Port traversal with current step kinds only. | 4 merged | blocked | remainder of `aedf712f` |
| 6 | OpenUI transport/state hardening | Absent: parser lacks prose-safe statement detection; surface has one global sequence watermark and unrestricted set events; state reads are not thread-keyed. | none | queued | `b095d1f5` |
| 7 | Result-aware configurable doom-loop protection | Absent: no round fingerprint or configurable identical-round threshold. | none | queued | `3fc95caf` + `33f44721` |
| 8 | Deferred observation distillation | Absent: `observations()` awaits its observer in the append path and carries long append timeouts. | none | queued | relevant `fb22ac35`; adapt observation naming |
| 9 | Opt-in filesystem/file-reference LLM scoring | Absent: `filesystem()` still defaults to Haiku scoring. Explicit breaking default: heuristic unless a model is configured. | none | queued | relevant `fb22ac35` |
| 10 | Memoized unified tools and SDK conversion | Partial: validation is upstream via #67, but tool collection/conversion is repeated and resolution remains linear. | none | queued | relevant `fb22ac35`; validation excluded |
| 11 | Channel reaping, loop snapshot efficiency, deterministic park jitter, inline dispatch | Absent in channel store/control/subprocess paths. Must not duplicate #69 EventBroadcaster or latest-yield changes. | coordinate with #69 only | queued | `27ddda8e` |
| 12 | Session-owned logs and warm layer hydration | Absent: sessions copy `accumulatedItems`; no session-owned log, truncation rollback, or scope-keyed warm hydration. | none | queued | `fc89dbab` + relevant `796f7ec2` fixes |
| 13 | Delta checkpoint batches, rollback-safe stitching, ledger continuity | Absent: checkpoints still embed the full item log; no batch stitching/truncation repair. | 12 merged | blocked | remaining `fc89dbab` + `796f7ec2`; benchmark before numeric claims |
| 14 | Declarative workflow runtime hardening | Absent: tool nodes bypass the shared execution path; no exact route mode, duplicate-id protection, dynamic path cache, size cap, or hydration-error revision loop. | none; blocks 20 | queued | `4cb90e35`; Sentrux-safe seam; regenerate both schemas when Zod changes |
| 15 | Compaction records, projection, pressure helpers | Absent: no compaction item/schema/projector helpers. | none | queued | `3d65b3e2` + `135ac3fd` |
| 16 | Fold compactions into model calls; emit context pressure | Absent. Folding must occur before system/history partitioning and pressure latch only on emission. | 15 merged | blocked | `1761e6b7` + `b83bdd91` |
| 17 | Deterministic minimum-first allocator | Absent: allocator remains 60/40 with unbounded `auto` and a `historyBudget` result. Explicit breaking/RFC review for the 2,000-token cap and interface removal. | 16 merged | blocked | `d8fb4f34` + `59497c48` |
| 18 | Assignable `context()` output at attachment seams | Absent: seams still use invariant `ContextConfig | ContextLayer[]`; port structural `ContextInput` to `withContext` and current names. | none | queued | `efc2b689` |
| 19 | Native multi-agent patterns | Primitives remain expressive, but a literal core pattern module conflicts with #68 and `specs/13-patterns.md`. Start with a proposal choosing examples/docs, a separate package, or a deliberate policy reversal. Standard Schema and current names are mandatory. | primitives stable; design approval | design-review | source `4cccf95d` |
| 20 | Declarative multi-agent nodes/hydrator seam | Absent and intentionally blocked. JSON nodes need an accepted item 19 registry/API and item 14's hardened hydrator seam. | 14 + accepted 19 merged | blocked | `77cb290d` + `928d63c3`; regenerate both schema artifacts and inspector glyphs |

## Dependency graph

```text
origin/main @ 8a6665ba
├─ 1 ──(soft conflict reduction)──► 2
├─ 3
├─ 4 ─────────────────────────────► 5
├─ 6
├─ 7
├─ 8
├─ 9
├─ 10
├─ 11  (parallel to #69; disjoint behavior)
├─ 12 ────────────────────────────► 13
├─ 14 ───────────────┐
├─ 15 ───────────────► 16 ────────► 17
├─ 18                │
└─ 19 design review ─┴────────────► 20
```

Dependent tranches `12→13`, `15→16→17`, and `14 + 19→20` sequence through merged upstream `main`; they are not maintained as long stacked diffs.

## First independent implementation wave

Delegate in parallel to isolated general-profile Pi workers, each based semantically on current main:

1. item 1 — platform-node file storage;
2. item 3 — sub-harness reliability;
3. item 4 — eval guard/concurrency; and
4. item 6 — OpenUI hardening.

These touch different primary packages and have no hard dependencies. Each worker implements and verifies only its bounded item. The orchestrator inspects every diff, runs a separate clean-context review, applies/fixes confirmed findings, performs fresh verification, creates signed DCO commits, pushes to `fork`, opens an upstream PR, and attaches monitoring.

The next independent wave is selected from items 7, 8, 9, 10, 11, 12, 14, 15, and 18 based on review/CI bandwidth. Item 5 waits for 4; item 2 follows 1 to avoid avoidable platform-node conflicts.

## Per-PR acceptance criteria

Every retained implementation PR must:

- be based on current merged `origin/main`, with dependent tranches rebased only after prerequisites merge;
- contain a semantic port, not a blind cherry-pick;
- use current public names and package boundaries;
- include focused regression tests and required spec/docs/skill changes;
- regenerate both workflow schema artifacts in the same commit when the workflow Zod schema changes;
- pass affected package tests and typecheck, root lint, relevant root/full tests, `sentrux check .`, and applicable local `agent-ci` workflows;
- receive a separate review-profile Pi review for standards, spec, correctness, and port completeness, with confirmed findings fixed and reverified;
- use Conventional Commit PR titles and signed, DCO-signed-off commits;
- explain what/why, source provenance, behavior or breaking changes, and test evidence;
- make no quantified performance claim without a reproducible benchmark;
- remain monitored for CI, merge conflicts, and review feedback; agent-authored GitHub messages begin with `Agent:`; and
- be recorded below with branch, URL, CI/review state, and merge SHA or concrete drop evidence.

## Live PR ledger

| Item | Branch | PR | CI | Reviews | Merge SHA / dependency | Last update |
|---:|---|---|---|---|---|---|
| 1 | `lukeparke/openrouter-file-storage` | [#70](https://github.com/mattapperson/noetic/pull/70) | CI/DCO/structural pass; compat blocked by missing upstream `OPENROUTER_API_KEY` | no feedback | review-ready; external compat dependency documented | 2026-08-12 opened |
| 2 | `lukeparke/openrouter-queue-ipc` | [#81](https://github.com/mattapperson/noetic/pull/81) | pending | no feedback | independent of #70 after split | 2026-08-12 opened |
| 3 | `lukeparke/openrouter-sub-harness-reliability` | [#71](https://github.com/mattapperson/noetic/pull/71) | pending | no feedback | independent | 2026-08-12 opened |
| 4 | `lukeparke/openrouter-eval-safety` | [#72](https://github.com/mattapperson/noetic/pull/72) | pending | no feedback | blocks 5 | 2026-08-12 opened |
| 5 | — | — | — | — | blocked by 4 merge | 2026-08-12 audit complete |
| 6 | `lukeparke/openrouter-openui-hardening` | [#73](https://github.com/mattapperson/noetic/pull/73) | pending | no feedback | independent | 2026-08-12 opened |
| 7 | `lukeparke/openrouter-doom-loop` | [#74](https://github.com/mattapperson/noetic/pull/74) | pending | no feedback | independent | 2026-08-12 opened |
| 8 | `lukeparke/openrouter-deferred-observations` | [#75](https://github.com/mattapperson/noetic/pull/75) | pending | no feedback | independent | 2026-08-12 opened |
| 9 | `lukeparke/openrouter-filesystem-scoring` | [#76](https://github.com/mattapperson/noetic/pull/76) | pending | no feedback | breaking default | 2026-08-12 opened |
| 10 | — | — | — | — | deferred after review found function-tool correctness and mutation-contract gaps; validation dropped via #67 | 2026-08-12 implementation rejected pending redesign |
| 11 | `lukeparke/openrouter-runtime-efficiency` | [#78](https://github.com/mattapperson/noetic/pull/78) | pending | no feedback | excludes [#69](https://github.com/mattapperson/noetic/pull/69) behavior | 2026-08-12 opened |
| 12 | `lukeparke/openrouter-session-log` | [#79](https://github.com/mattapperson/noetic/pull/79) | pending | no feedback | blocks 13 | 2026-08-12 opened |
| 13 | — | — | — | — | blocked by 12 | 2026-08-12 audit complete |
| 14 | — | — | — | — | independent; blocks 20 | 2026-08-12 audit complete |
| 15 | `lukeparke/openrouter-compaction-primitives` | [#80](https://github.com/mattapperson/noetic/pull/80) | pending | no feedback | blocks 16 | 2026-08-12 opened |
| 16 | — | — | — | — | blocked by 15 | 2026-08-12 audit complete |
| 17 | — | — | — | — | blocked by 16; RFC/breaking | 2026-08-12 audit complete |
| 18 | `lukeparke/openrouter-context-input` | [#77](https://github.com/mattapperson/noetic/pull/77) | pending | no feedback | independent | 2026-08-12 opened |
| 19 | — | — | — | — | proposal committed at `docs/plans/2026-08-12-002-multi-agent-patterns-proposal.md`; recommends examples/docs and rejects core policy reversal | 2026-08-12 design proposal complete |
| 20 | — | — | — | — | deferred/redesign required: examples cannot be declarative hydration targets; requires accepted package/registry plus item 14 | 2026-08-12 explicitly blocked |

## Program risks

- The plan is intentionally broad; concurrency is bounded by review and CI capacity rather than worker count.
- Public behavior changes in items 9 and 17 require explicit reviewer attention and release notes.
- Items 12–17 modify state/persistence semantics; compatibility and rollback tests are required, not just happy-path coverage.
- Item 14 must use or extract an allowed shared tool-dispatch seam instead of importing upward across Sentrux layers.
- Item 19 may be rejected as a core API on policy grounds. That is an acceptable documented drop; item 20 is then deferred or redesigned rather than forced through.
