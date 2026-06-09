---
name: sentrux-boundaries
description: Check `.sentrux/rules.toml` for layer and boundary violations and suggest fixes. Use when the user asks "does this respect the architecture?", "any rule violations?", "check boundaries", or "are we following the layering?". Reads the `reason` field on each violation to tailor the fix suggestion.
---

# Sentrux Boundaries

Validates architectural rules defined in `.sentrux/rules.toml` via the `plugin:sentrux:sentrux` MCP server.

## Steps

1. Call `mcp__plugin_sentrux_sentrux__scan` on the repo root if the index isn't fresh.
2. Call `mcp__plugin_sentrux_sentrux__check_rules`.
3. For each violation:
   - Classify as **`[[boundaries]]` violation** (has a `reason` string from the TOML) or **layer_direction drift** (implicit, from the layer ordering).
   - For a handful of representative violations (no more than 5, highest-signal first), read the offending file and 20 lines of context around the import statement.
   - Suggest a fix:
     - **Memory → core interpreter/runtime** (acyclicity + tree-shakability): offer to move the referenced helper inline into `packages/memory/src/` or duplicate a narrow utility to avoid pulling the larger module.
     - **Sibling-package imports** (e.g. eval → code-agent): offer to move the shared code into `@noetic-tools/core` or refactor the caller to not need it.
     - **Layer_direction drift within cli/**: offer to invert the dependency (e.g. extract the shared type into `cli-foundations`) or accept the drift and adjust `specs/22-cli-architecture.md` if the intent has changed.
4. Group the report by `reason` field so the user sees the architectural theme, not just file pairs.

## Guidance

- Do not auto-fix without asking. List the suggestions and let the user pick.
- If `check_rules` returns zero violations, say so in one line. Don't invent issues.
- Cross-reference `specs/00-overview.md` and `specs/22-cli-architecture.md` when explaining why a rule exists — the spec is the primary source of intent, `rules.toml` just enforces it.
- Boundaries with `memory layers must be tree-shakable` in their reason are the highest-priority; flag those at the top of the report.
