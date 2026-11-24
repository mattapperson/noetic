#!/bin/bash
# PostToolUse hook: block biome-ignore comments after Write/Edit/MultiEdit
# Checks the resulting file on disk for suppression comments.

INPUT=$(cat)

command -v jq >/dev/null 2>&1 || { echo "jq is required for no-biome-ignore hook" >&2; exit 1; }

FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')

# Skip if no file path or non-TS/JS file
if [ -z "$FILE_PATH" ] || [[ ! "$FILE_PATH" =~ \.(ts|tsx|js|jsx)$ ]]; then
  exit 0
fi

# Skip files outside the project
if [[ "$FILE_PATH" =~ node_modules|\.grit/tests ]]; then
  exit 0
fi

# Check the file on disk for biome-ignore comments
if grep -qE '(//|/\*)\s*biome-ignore' "$FILE_PATH" 2>/dev/null; then
  echo "BLOCKED: biome-ignore comment detected in $FILE_PATH." >&2
  echo "" >&2
  echo "Cheating is not allowed, fixing the root cause of issues is a hard requirement for success." >&2
  echo "" >&2
  echo "Remove the biome-ignore comment and fix the underlying code issue instead." >&2
  exit 2
fi
