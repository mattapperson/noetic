/**
 * @noetic-tools/sub-harness-claude-code — run Anthropic's Claude Code agent as
 * a Noetic step via `step.claudeCode({ harness: claudeCode({ model }) })` or a
 * `claude-code` JSON workflow node.
 */

import type { SubHarness, SubHarnessRunner, SubHarnessSettings } from '@noetic-tools/sub-harness';
import { commonTool, defineSubHarness } from '@noetic-tools/sub-harness';
import { defaultClaudeCodeRunner } from './runner';

/** @public Options for {@link claudeCode}. Extends the shared sub-harness settings. */
export interface ClaudeCodeOptions extends SubHarnessSettings {
  /** Override the turn runner — e.g. for tests or a custom CLI invocation. */
  runner?: SubHarnessRunner;
}

const CLAUDE_CODE_TOOLS = [
  commonTool('Bash', 'shell', 'Run a shell command'),
  commonTool('Read', 'read-file', 'Read a file'),
  commonTool('Write', 'write-file', 'Write a file'),
  commonTool('Edit', 'edit-file', 'Edit a file'),
  commonTool('Glob', 'find-files', 'Find files by glob'),
  commonTool('Grep', 'search', 'Search file contents'),
];

/** @public Create a Claude Code sub-harness adapter. */
export function claudeCode(options: ClaudeCodeOptions = {}): SubHarness {
  const { runner, ...settings } = options;
  return defineSubHarness({
    harnessId: 'claude-code',
    runner: runner ?? defaultClaudeCodeRunner,
    builtinTools: CLAUDE_CODE_TOOLS,
    defaultSettings: settings,
  });
}

export { defaultClaudeCodeRunner, mapClaudeMessage } from './runner';
