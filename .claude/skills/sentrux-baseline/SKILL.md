---
name: sentrux-baseline
description: Snapshot current sentrux metrics as a baseline so later changes can be diffed against it. Use when the user says "mark a baseline", "checkpoint quality here", "I'm about to refactor — save where we are". Pair with `sentrux-diff` after the work.
---

# Sentrux Baseline

Saves a mid-session quality baseline via the `plugin:sentrux:sentrux` MCP server.

## Steps

1. Call `mcp__plugin_sentrux_sentrux__scan` with the repo root path to refresh the index.
2. Call `mcp__plugin_sentrux_sentrux__session_start` — this snapshots current metrics as the comparison target for `session_end`.
3. Report the baseline:
   - Quality signal (0–1)
   - Top three dimensions by score (what's currently healthy — those are the things to protect)
   - One-line reminder: "run `/sentrux-diff` after your changes to see the delta"

## Guidance

- This is distinct from the `SessionStart` hook in `.claude/settings.json`. The hook uses the CLI (`sentrux gate --save .`) and fires automatically per Claude Code session. This skill uses the MCP tool and is invoked manually when the user wants an explicit in-session checkpoint.
- If `scan` reports zero files analyzed, stop and surface the error — usually means the path is wrong or the scanner failed.
- Don't run `session_end` from this skill. That belongs in `sentrux-diff`.
