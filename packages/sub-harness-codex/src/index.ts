/**
 * @noetic-tools/sub-harness-codex — run OpenAI's Codex agent as a Noetic step
 * via `step.codex({ harness: codex({ model }) })` or a `codex` JSON workflow
 * node.
 *
 * @example
 * ```ts
 * import { codex } from '@noetic-tools/sub-harness-codex';
 *
 * const flow = step.codex({
 *   id: 'fix-bug',
 *   harness: codex({ model: 'gpt-5.3-codex' }),
 *   prompt: 'Fix the failing test in src/auth.ts',
 * });
 * ```
 */

import type { SubHarness, SubHarnessRunner, SubHarnessSettings } from '@noetic-tools/sub-harness';
import { commonTool, defineSubHarness } from '@noetic-tools/sub-harness';
import { defaultCodexRunner } from './runner';

/** @public Options for {@link codex}. Extends the shared sub-harness settings. */
export interface CodexOptions extends SubHarnessSettings {
  /** Override the turn runner — e.g. for tests or a custom CLI invocation. */
  runner?: SubHarnessRunner;
}

const CODEX_TOOLS = [
  commonTool('shell', 'shell', 'Run a shell command'),
  commonTool('read_file', 'read-file', 'Read a file'),
  commonTool('apply_patch', 'edit-file', 'Apply a patch to files'),
];

/** @public Create a Codex sub-harness adapter. */
export function codex(options: CodexOptions = {}): SubHarness {
  const { runner, ...settings } = options;
  return defineSubHarness({
    harnessId: 'codex',
    runner: runner ?? defaultCodexRunner,
    builtinTools: CODEX_TOOLS,
    defaultSettings: settings,
  });
}

export { defaultCodexRunner, mapCodexMessage } from './runner';
