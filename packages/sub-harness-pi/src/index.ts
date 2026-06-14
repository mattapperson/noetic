/**
 * @noetic-tools/sub-harness-pi — run the Pi coding agent as a Noetic step via
 * `step.pi({ id, harness: pi({ model }), prompt })` or a `pi` JSON workflow
 * node.
 */

import type { SubHarness, SubHarnessRunner, SubHarnessSettings } from '@noetic-tools/sub-harness';
import { commonTool, defineSubHarness } from '@noetic-tools/sub-harness';
import { createDefaultPiRunner } from './runner';

/** @public Options for {@link pi}. Extends the shared sub-harness settings. */
export interface PiOptions extends SubHarnessSettings {
  /** Override the turn runner — e.g. for tests or a custom SDK invocation. */
  runner?: SubHarnessRunner;
  /** Reasoning budget for the Pi agent, passed to the default runner. */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
}

const PI_TOOLS = [
  commonTool('bash', 'shell', 'Run a shell command'),
  commonTool('read', 'read-file', 'Read a file'),
  commonTool('write', 'write-file', 'Write a file'),
  commonTool('edit', 'edit-file', 'Edit a file'),
];

/** @public Create a Pi sub-harness adapter. */
export function pi(options: PiOptions = {}): SubHarness {
  const { runner, thinkingLevel, ...settings } = options;
  return defineSubHarness({
    harnessId: 'pi',
    runner: runner ?? createDefaultPiRunner(thinkingLevel),
    builtinTools: PI_TOOLS,
    defaultSettings: settings,
  });
}

export { defaultPiRunner, mapPiMessage } from './runner';
