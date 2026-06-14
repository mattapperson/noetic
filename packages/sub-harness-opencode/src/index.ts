/**
 * @noetic-tools/sub-harness-opencode — run the opencode agent as a Noetic step
 * via `step.opencode({ id, harness: opencode({ model }), prompt })` or an
 * `opencode` JSON workflow node.
 */

import type { SubHarness, SubHarnessRunner, SubHarnessSettings } from '@noetic-tools/sub-harness';
import { commonTool, defineSubHarness } from '@noetic-tools/sub-harness';
import { defaultOpencodeRunner } from './runner';

/** @public Options for {@link opencode}. Extends the shared sub-harness settings. */
export interface OpencodeOptions extends SubHarnessSettings {
  /** Override the turn runner — e.g. for tests or a custom CLI invocation. */
  runner?: SubHarnessRunner;
}

const OPENCODE_TOOLS = [
  commonTool('bash', 'shell', 'Run a shell command'),
  commonTool('read', 'read-file'),
  commonTool('write', 'write-file'),
  commonTool('edit', 'edit-file'),
  commonTool('grep', 'search'),
];

/** @public Create an opencode sub-harness adapter. */
export function opencode(options: OpencodeOptions = {}): SubHarness {
  const { runner, ...settings } = options;
  return defineSubHarness({
    harnessId: 'opencode',
    runner: runner ?? defaultOpencodeRunner,
    builtinTools: OPENCODE_TOOLS,
    defaultSettings: settings,
  });
}

export { defaultOpencodeRunner, mapOpencodeMessage } from './runner';
