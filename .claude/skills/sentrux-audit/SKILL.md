---
name: sentrux-audit
description: Run a full structural audit of the noetic repo via the sentrux MCP server. Use when the user asks "how is the codebase?", "audit the repo", "full sentrux check", or after a large refactor/merge. Returns a quality score, health breakdown, rule violations, and the top untested risky files.
---

# Sentrux Audit

Runs a full architectural audit via the `plugin:sentrux:sentrux` MCP server and produces a concise report.

## Steps

1. **Scan first** — call `mcp__plugin_sentrux_sentrux__scan` with `path = "/Users/mattapperson/Development/mattapperson/noetic"` (or the current repo root). All other MCP tools require the scan index to be fresh.
2. **Gather metrics in parallel** (single message, three tool calls):
   - `mcp__plugin_sentrux_sentrux__health` — quality signal with per-dimension breakdown
   - `mcp__plugin_sentrux_sentrux__check_rules` — violations of `.sentrux/rules.toml`
   - `mcp__plugin_sentrux_sentrux__test_gaps` with `limit = 10` — highest-risk untested source files
3. **Report** in this order:
   - **Quality signal** — the 0–1 number with its breakdown (modularity, acyclicity, depth, equality, redundancy)
   - **Top three regressions** — pick the three lowest-scoring dimensions from `health`
   - **Rule violations** — grouped by `[[boundaries]]` reason; for each, list files and one-line remediation hint
   - **Untested risk** — the top five files from `test_gaps` with their complexity scores

## Guidance

- Don't paraphrase. Prefer the numbers sentrux returns over prose.
- If `check_rules` returns zero violations, say so in one line and skip that section.
- If the user asks for deeper inspection after the report, mention that `dsm` (design structure matrix) and `git_stats` (churn/hotspots) are available via the MCP server.
- This skill does not modify files. For fixes, route the user to `sentrux-boundaries` (for rule violations) or suggest writing tests (for `test_gaps`).
