#!/bin/bash
# PostToolUse hook: auto-fix with biome then verify
# Runs after every Write/Edit to keep code lint-clean.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Skip non-TS/JS files
if [[ ! "$FILE_PATH" =~ \.(ts|tsx|js|jsx)$ ]]; then
  exit 0
fi

# Skip files outside the project (e.g. node_modules, .grit tests)
if [[ "$FILE_PATH" =~ node_modules|\.grit/tests ]]; then
  exit 0
fi

# Use git to find the repo root — works inside worktrees and subdirectories
FILE_DIR=$(dirname "$FILE_PATH")
GIT_ROOT=$(git -C "$FILE_DIR" rev-parse --show-toplevel 2>/dev/null)

if [ -z "$GIT_ROOT" ] || [ ! -f "$GIT_ROOT/biome.json" ]; then
  # No git root or no biome config there, skip
  exit 0
fi

BIOME="$GIT_ROOT/node_modules/.bin/biome"
if [ ! -x "$BIOME" ]; then
  # Fallback if local binary missing
  BIOME="bunx biome"
fi

cd "$GIT_ROOT"

# Auto-fix (unsafe) then check in one pass — --fix returns non-zero when unfixable issues remain
OUTPUT=$($BIOME check --fix --unsafe "$FILE_PATH" 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "Biome check failed for $FILE_PATH. You MUST fix these issues before continuing:" >&2
  echo "" >&2
  echo "$OUTPUT" >&2
  exit 2
fi
