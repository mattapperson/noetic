# Worked examples

Three complete FlowSchema trees you can adapt. Each is paired with a short description of the scenario it fits.

## 1. Simple sequence: audit, then fix

**Scenario:** a targeted bug fix where you first explore to confirm the root cause, then apply the change.

```json
{
  "kind": "sequence",
  "id": "fix-null-check",
  "steps": [
    {
      "kind": "subagent",
      "id": "audit",
      "preset": "explore",
      "prompt": "Find every call site of `getUser(id)` that doesn't guard against a null return in packages/core."
    },
    {
      "kind": "llm",
      "id": "apply-fix",
      "instructions": "For each call site the audit found, add a null guard. Prefer early-return guard clauses over nested conditionals. Run the test suite after editing.",
      "tools": ["Read", "Edit", "Bash"]
    }
  ]
}
```

Depth: 1.

## 2. Parallel explore then consolidate

**Scenario:** a refactor that touches several independent modules. You want fast fan-out for discovery, then a single LLM pass to synthesise the findings into a migration plan.

```json
{
  "kind": "sequence",
  "id": "refactor-planner",
  "steps": [
    {
      "kind": "fork",
      "id": "discovery",
      "mode": "all",
      "paths": [
        {
          "kind": "subagent",
          "id": "explore-auth",
          "preset": "explore",
          "prompt": "Enumerate exported symbols and known callers in packages/core/src/auth."
        },
        {
          "kind": "subagent",
          "id": "explore-session",
          "preset": "explore",
          "prompt": "Enumerate exported symbols and known callers in packages/core/src/session."
        },
        {
          "kind": "subagent",
          "id": "explore-tokens",
          "preset": "explore",
          "prompt": "Enumerate exported symbols and known callers in packages/core/src/tokens."
        }
      ]
    },
    {
      "kind": "llm",
      "id": "consolidate",
      "instructions": "Using the three exploration reports, write a migration plan that renames these three modules to live under `packages/core/src/identity/`. Preserve existing exports via re-export shims so downstream callers don't break."
    }
  ]
}
```

Depth: 2.

## 3. Spawn-per-file refactor

**Scenario:** a mechanical refactor (e.g. rename a function across dozens of files). You want each file edited in isolation so one failure doesn't pollute the others, and you're happy for partial success.

```json
{
  "kind": "fork",
  "id": "rename-across-files",
  "mode": "settle",
  "paths": [
    {
      "kind": "spawn",
      "id": "rename-auth-ts",
      "subPlanRef": "rename-auth-ts.md",
      "child": {
        "kind": "llm",
        "id": "rename-auth-leaf",
        "instructions": "Rename `legacyLogin` to `login` in packages/core/src/auth.ts. Update callers within the same file. Run `bun test` for that package.",
        "tools": ["Read", "Edit", "Bash"]
      }
    },
    {
      "kind": "spawn",
      "id": "rename-session-ts",
      "subPlanRef": "rename-session-ts.md",
      "child": {
        "kind": "llm",
        "id": "rename-session-leaf",
        "instructions": "Rename `legacyLogin` to `login` in packages/core/src/session.ts. Update callers within the same file.",
        "tools": ["Read", "Edit", "Bash"]
      }
    },
    {
      "kind": "spawn",
      "id": "rename-cli-ts",
      "subPlanRef": "rename-cli-ts.md",
      "child": {
        "kind": "llm",
        "id": "rename-cli-leaf",
        "instructions": "Rename `legacyLogin` to `login` in packages/cli/src/auth-wrapper.ts.",
        "tools": ["Read", "Edit", "Bash"]
      }
    }
  ]
}
```

Depth: 2. Note the `subPlanRef` values — each spawn has a dedicated sub-plan file the runtime can load for per-node detail (these live in the same directory as the root plan.md).

`mode: 'settle'` means one file failing doesn't abort the others; the user sees successes and failures side-by-side in the result.
