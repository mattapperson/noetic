# PRD template

Use this template for the `content` argument to `plan/updatePrd`. Keep the PRD ≤50,000 characters. Lead with the section titles below, in order. Fill every section — do not skip the less glamorous ones (Reuse, Verification).

---

## Context

**What prompted this change.** The problem or need it addresses, the trigger (user request, incident, design decision), and the intended outcome. One paragraph, typically 3–6 sentences. If the motivation is deadline-driven or constrained by an external decision (compliance, migration), say so explicitly — it shapes scope decisions downstream.

Do not summarise the codebase here. Assume the reader knows the project but not why this particular change is happening now.

## Approach

**The single recommended approach.** Not alternatives, not pros-and-cons of every option you considered. Pick one and describe it end-to-end.

Cover:

- The overall strategy (e.g. "add a new memory layer that intercepts `recall`", "extend `FooBuilder` with an opt-in `retry` field").
- The key design decisions and the constraints that forced them.
- Any non-obvious trade-offs the reader would otherwise trip over.

If there was a meaningful alternative you rejected, mention it in one line with the reason. Do not enumerate every dead end.

## Files to modify

Bullet list of paths with a one-line description of the change per file. Example:

- `packages/core/src/memory/layers/plan.ts` — add `getPlanningSkillContent` hook; update `recallPlanning` to inject it.
- `packages/cli/src/harness/factory.ts` — pass the `plan-mode` skill's instructions through the new hook.
- `packages/cli/src/skills/built-in/plan-mode/SKILL.md` — **new** — authored skill content.

Mark new files with `**new**`. Mark renames/deletions explicitly.

## Reuse

**Existing functions/utilities/patterns you intend to reuse.** Prevent duplicated helpers. Include `path:line` references.

Example:

- `parseFrontmatter` (`packages/cli/src/skills/frontmatter.ts:38`) — shared YAML parser; reused by the built-in loader.
- `buildSkillCatalog` (`packages/cli/src/skills/catalog.ts:56`) — extend, don't fork; add a new merge branch.

If you are introducing a new utility that might be reused later, note it here with its intended export path.

## Verification

**How the user (or CI) will confirm the change works.** Be concrete — name the commands, the test files, the manual steps.

Include:

- Unit tests to add/update (path + what they assert).
- Integration/e2e checks (pilotty script, curl command, UI step).
- Regressions to watch for (what should NOT change).
- Typecheck/lint commands to run.

Example:

1. `bun test packages/cli/test/built-in-skills.test.ts` — catalog contains built-in skill; filesystem overrides it.
2. `bun test packages/core/test/memory/plan.test.ts` — FlowSchema accepted, depth boundary honoured.
3. `bun run typecheck` + `bunx biome check .` — clean.
4. Manual: `pilotty spawn ... bash -c "bun run src/cli/cli.ts"`, `/plan`, give a sample task, confirm model produces a valid FlowSchema tree and PRD.

---

Keep each section tight. A reviewer should be able to read the whole PRD in under two minutes.
