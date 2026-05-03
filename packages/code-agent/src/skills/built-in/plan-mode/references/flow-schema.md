# FlowSchema reference

The `FlowSchema` (exported from `@noetic/core`) validates the plan-tree passed to `plan/setPlanTree`. This file documents every node kind in detail.

A plan-tree is a single root `FlowNode`. Every node must match the Zod schema — extra fields are preserved but unknown top-level kinds are rejected.

## Shared fields

Every node has:

- `id: string` — non-empty, unique within the tree. Used for log correlation and `subPlanRef` links.
- `subPlanRef?: string` — optional pointer to a sub-plan markdown file (e.g. `"explore-auth.md"`). The runtime reads it alongside the tree when present. Use when a node's instructions are long enough to deserve their own document.

Plus a discriminating `kind` field and kind-specific fields below.

## kind: `llm`

A single LLM invocation with specific instructions and optional tool references.

```json
{
  "kind": "llm",
  "id": "draft-migration",
  "instructions": "Write a migration script that renames the `users.email` column to `users.email_address`. Use Prisma.",
  "model": "anthropic/claude-sonnet-4",
  "tools": ["Read", "Write", "Edit"]
}
```

- `instructions: string` — the prompt for this step. Required.
- `model?: string` — override the default model. Omit to inherit from the harness.
- `tools?: string[]` — tool names (strings) resolved against the harness's live registry at execute time. Omit for access to the harness's full toolset.

**When to use:** a single, focused LLM task whose instructions differ from the harness default.

## kind: `subagent`

Delegate to a preset subagent. Presets are registered by plugins via `subagentPresets()` or built-in (commonly `explore`, `plan`). The preset controls which tools the subagent has, its system prompt, and its persona.

```json
{
  "kind": "subagent",
  "id": "explore-auth",
  "preset": "explore",
  "prompt": "Find all uses of `requireAuth` in packages/web and report their file paths with context."
}
```

- `preset: string` — non-empty. The preset name (e.g. `"explore"`, `"plan"`). Invalid presets fail at execute time.
- `prompt: string` — the task for the subagent.

**When to use:** for bounded, read-only investigations (`explore`) or structured planning (`plan`) whose results feed the parent's decisions. Prefer over `llm` when a preset already captures the persona you want.

## kind: `fork`

Run multiple branches with a merge mode.

```json
{
  "kind": "fork",
  "id": "parallel-explore",
  "mode": "all",
  "paths": [
    { "kind": "subagent", "id": "p1", "preset": "explore", "prompt": "Check auth module." },
    { "kind": "subagent", "id": "p2", "preset": "explore", "prompt": "Check session storage." }
  ]
}
```

- `mode: 'all' | 'race' | 'settle'`:
  - `all` — wait for every branch; merge results into an array.
  - `race` — first to return wins; cancel the rest.
  - `settle` — wait for every branch; record successes and failures without throwing.
- `paths: FlowNode[]` — at least one; each is a full `FlowNode` (recursive).

**When to use:** parallel exploration, racing multiple drafts, or tolerant settle-patterns when some branches may fail.

## kind: `spawn`

Run a child in an isolated execution context (fresh memory state derived from the parent's `onSpawn` hook).

```json
{
  "kind": "spawn",
  "id": "rename-file",
  "child": {
    "kind": "llm",
    "id": "rename-leaf",
    "instructions": "Apply the migration to packages/web/src/auth.ts."
  }
}
```

- `child: FlowNode` — exactly one child (recursive).

**When to use:** per-file or per-item work where each execution should not pollute the parent's context. Often used as the body of a fork or a sequence that iterates over inputs.

## kind: `sequence`

Run steps in order. Each step sees the previous step's output as input.

```json
{
  "kind": "sequence",
  "id": "audit-then-fix",
  "steps": [
    { "kind": "subagent", "id": "audit", "preset": "explore", "prompt": "Audit for X." },
    { "kind": "llm", "id": "fix", "instructions": "Based on the audit, apply the fix." }
  ]
}
```

- `steps: FlowNode[]` — at least one; each is a full `FlowNode` (recursive).

**When to use:** ordered pipelines where later steps depend on earlier outputs.

## Depth

Leaf nodes (`llm`, `subagent`) are depth 0. Structural nodes (`sequence`, `fork`, `spawn`) add 1 over their deepest child. Max depth is 5. Exceeding it fails `plan/setPlanTree` with an `exceeds maximum depth` error.

Examples:

- A bare `llm` node → depth 0.
- `sequence(llm, llm)` → depth 1.
- `sequence(fork(llm, llm), llm)` → depth 2.
- `sequence(sequence(sequence(sequence(sequence(llm)))))` → depth 5, boundary.

## Validation behaviour

The schema uses Zod's `discriminatedUnion` on `kind`. Consequences:

- Unknown `kind` values are rejected with a discrimination error.
- Empty `id` or empty `preset` → rejected.
- Empty `paths` or `steps` arrays → rejected (`min(1)`).
- Missing required kind-specific fields (e.g. `llm` without `instructions`) → rejected.
