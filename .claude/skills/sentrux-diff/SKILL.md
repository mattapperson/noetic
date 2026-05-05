---
name: sentrux-diff
description: Compare current sentrux metrics against the most recent baseline and report what got better or worse. Use when the user asks "did I break anything?", "diff quality since baseline", "what got worse?", or at the end of a refactor. Requires a prior `sentrux-baseline` or `session_start` call in the same MCP session.
---

# Sentrux Diff

Runs a quality-delta check via the `plugin:sentrux:sentrux` MCP server.

## Steps

1. Call `mcp__plugin_sentrux_sentrux__session_end` — this re-scans and diffs against the last baseline.
2. Report the delta:
   - **Quality signal change** — `before → after` with sign and magnitude
   - **Degraded dimensions** — list any that dropped more than 0.02, worst first
   - **Improved dimensions** — list any that rose more than 0.02 (briefly)
   - **Top 3 files by complexity delta** — if the MCP response includes file-level diffs

## Guidance

- If the response indicates no baseline exists, tell the user and suggest `/sentrux-baseline` first.
- If nothing changed, say "No regression detected — quality signal unchanged at X.XX" in one line.
- Don't editorialize — small fluctuations (< 0.01) are noise and should be omitted.
- After reporting, if quality regressed, ask whether to run `/sentrux-boundaries` to see if a rule violation explains it.
