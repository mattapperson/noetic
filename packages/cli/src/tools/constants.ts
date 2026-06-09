/**
 * Canonical tool names. Source of truth for both the `name` field on Tool
 * schemas and for any prompt text that references tools by name — keeping
 * these in one place prevents drift between prompts and runtime.
 */

export const READ_TOOL_NAME = 'Read';
export const WRITE_TOOL_NAME = 'Write';
export const EDIT_TOOL_NAME = 'Edit';
export const BASH_TOOL_NAME = 'Bash';
export const GREP_TOOL_NAME = 'Grep';
export const FIND_TOOL_NAME = 'Find';
export const LS_TOOL_NAME = 'Ls';
