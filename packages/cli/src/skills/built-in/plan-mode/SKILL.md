---
name: plan-mode
description: Author plan.md PRDs and FlowSchema plan-trees during noetic plan mode. This skill should be consulted whenever the agent is in plan mode and about to call plan/updatePrd or plan/setPlanTree.
when-to-use: Automatically active during plan mode (PlanPhase.Planning).
user-invocable: false
model-invocable: false
---

# Plan-mode authoring guide

You are in plan mode. Your job is to produce two artifacts for the user to approve:

1. A **PRD** (plan.md) — a markdown document that explains what you will do and why.
2. An optional **plan-tree** (FlowSchema JSON) — a DAG describing how the implementation will be orchestrated at execute time.

The PRD is required. The plan-tree is optional: include it only when the task benefits from custom orchestration (parallel exploration, per-file refactors, multi-step pipelines). For straightforward linear work, skip it.

Do not invent formats. The schemas below are enforced by Zod — malformed input is rejected.

## The five phases

1. **Initial Understanding** — explore the codebase with `Read`, `Grep`, `Find`, `Ls`. Fan out with `{ kind: "subagent", preset: "explore", prompt: "..." }` nodes for independent strands (max 3 in parallel).
2. **Design** — synthesise findings into a single recommended approach. Optionally use `{ kind: "subagent", preset: "plan", prompt: "..." }` nodes to stress-test alternatives.
3. **Review** — read the critical files directly so you understand them first-hand. If anything is ambiguous, ask the user a focused question.
4. **Final Plan** — call `plan/updatePrd` with the PRD. If the task warrants orchestration, also call `plan/setPlanTree` with a FlowSchema tree. See `references/prd-template.md` and `references/flow-schema.md`.
5. **Exit** — call `plan/exitPlanMode` with `{ action: "execute" }` to request user approval. If the user rejects, you stay in plan mode and revise.

## PRD structure

The PRD is markdown, ≤50,000 characters. Required sections, in order:

- **Context** — why this change (the problem, the trigger, the intended outcome).
- **Approach** — your single recommended approach. Not alternatives, not a shopping list. One coherent plan.
- **Files to modify** — bullet list of paths with a one-line description of the change per file.
- **Reuse** — existing functions/utilities/patterns you intend to reuse, with `path:line` references.
- **Verification** — how the user (or CI) will know the change works: tests to run, manual steps, expected behaviour.

Open `references/prd-template.md` for a fill-in template.

## Plan-tree (FlowSchema)

The plan-tree is a single root `FlowNode`. It is a discriminated union with five kinds:

| kind | When to use |
|------|-------------|
| `llm` | A single LLM invocation with specific instructions and tool references (by name). |
| `subagent` | Delegate to a preset subagent (e.g. `explore`, `plan`). The preset controls tool access and persona. |
| `fork` | Run multiple branches with `mode: 'all' \| 'race' \| 'settle'`. Use for parallel exploration or A/B drafting. |
| `spawn` | Run a child in an isolated execution context (fresh state). Use for per-file/per-item work. |
| `sequence` | Run `steps` one after another. Each step sees the previous output. |

Every node has `id` (unique, non-empty string) and optional `subPlanRef` (a pointer to a per-node sub-plan markdown file, e.g. `"node-explore.md"`).

Max tree depth: 5 (leaf nodes are depth 0; each nested structural node adds 1).

Full schema with per-kind field reference: `references/flow-schema.md`.
Three worked examples (sequence, parallel explore, spawn-per-file): `references/examples.md`.

## Tool actions available in plan mode

- `plan/updatePrd` — `{ content: string }`. Stores the PRD. Rejected if length > 50,000 or phase ≠ Planning.
- `plan/setPlanTree` — a `FlowNode`. Rejected if tree depth > 5 or phase ≠ Planning. Optional.
- `plan/exitPlanMode` — `{ action: "execute" | "cancel" }`. `execute` triggers the approval gate; `cancel` discards the plan. Rejected if no PRD has been written (for execute).

## Constraints

- Read-only tools only: `Read`, `Grep`, `Find`, `Ls`. Do NOT call `Write`, `Edit`, `Bash`, or any mutating tool — the layer denies them.
- End every turn either by asking the user a focused clarifying question or by calling `plan/exitPlanMode`. Do not call multiple `plan/*` actions in separate turns when they could be grouped.
- Do not paste the entire plan-tree into the PRD. The tree goes through `plan/setPlanTree`; the PRD explains the approach in prose.
- If you cannot produce a plan because the task is under-specified, stop and ask the user.
