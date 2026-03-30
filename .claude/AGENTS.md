# Agent Instructions

## Workflow Rules

### Git Operations
- **DO NOT commit changes unless explicitly asked by the user**
- **DO NOT push changes unless explicitly asked by the user**
- Stage changes with `git add` only when preparing for a commit the user has requested
- Always verify changes with the user before committing

### Code Changes
- Make edits to files as requested
- Run linting/type checking to ensure code quality
- Wait for user confirmation before committing
- If the user says "commit" or "push", then proceed with those operations

### Communication
- Confirm approach before implementing complex changes
- Ask for clarification if requirements are ambiguous
- Provide clear explanations of what changes were made
