#!/bin/bash
# SessionStart hook: save the sentrux quality baseline for this session.
# Runs `sentrux gate --save .` from the repo root so later `Stop` hooks can
# compare against it.

# Soft-exit if sentrux isn't installed (keeps the repo usable for contributors
# without the plugin).
if ! command -v sentrux >/dev/null 2>&1; then
  exit 0
fi

# Need a rules.toml to gate against — if there isn't one, nothing to do.
GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$GIT_ROOT" ] || [ ! -f "$GIT_ROOT/.sentrux/rules.toml" ]; then
  exit 0
fi

cd "$GIT_ROOT"
sentrux gate --save . >/dev/null 2>&1
exit 0
