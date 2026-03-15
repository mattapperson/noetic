#!/bin/bash
# PreToolUse hook: block biome-ignore comments from being written
# Runs before Write/Edit/MultiEdit to prevent suppression comments.

INPUT=$(cat)

command -v jq >/dev/null 2>&1 || { echo "jq is required for no-biome-ignore hook" >&2; exit 1; }

# Extract the relevant content in a single jq call based on tool type
CONTENT=$(printf '%s' "$INPUT" | jq -r '
  if .tool_name == "Write" then (.tool_input.content // empty)
  elif .tool_name == "Edit" then (.tool_input.new_string // empty)
  elif .tool_name == "MultiEdit" then ((.tool_input.edits // []) | map(.new_string) | join("\n"))
  else empty end
')

if [ -z "$CONTENT" ]; then
  exit 0
fi

# Check for biome-ignore comments
if printf '%s\n' "$CONTENT" | grep -qE '(//|/\*)\s*biome-ignore'; then
  echo "BLOCKED: biome-ignore comment detected." >&2
  echo "" >&2
  echo "Cheating is not allowed, fixing the root cause of issues is a hard requirement for success." >&2
  echo "" >&2
  echo "Remove the biome-ignore comment and fix the underlying code issue instead." >&2
  exit 2
fi
