#!/bin/bash
# Stop hook: compare current quality against the baseline saved at session start.
# Non-zero exit surfaces the degradation to the agent without hard-blocking.

if ! command -v sentrux >/dev/null 2>&1; then
  exit 0
fi

GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$GIT_ROOT" ] || [ ! -f "$GIT_ROOT/.sentrux/rules.toml" ]; then
  exit 0
fi

cd "$GIT_ROOT"
OUTPUT=$(sentrux gate . 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "Sentrux quality gate regressed. Review the score delta and consider reverting or fixing:" >&2
  echo "" >&2
  echo "$OUTPUT" >&2
fi

exit $EXIT_CODE
