/**
 * CLI wrapper around `@noetic/code-agent`'s portable `provisionWorktree`.
 *
 * The SDK version requires an explicit `ShellAdapter`; the CLI defaults
 * it to `createLocalShellAdapter()` so existing call sites and tests
 * that omit `shell` keep working.
 */

import type { ProvisionWorktreeResult } from '@noetic/code-agent/tasks';
import * as sdk from '@noetic/code-agent/tasks';
import type { ShellAdapter } from '@noetic/core';
import { createLocalShellAdapter } from '@noetic/core/adapters/node';

export type { ProvisionWorktreeResult } from '@noetic/code-agent/tasks';
export { ProvisionTool, WorktreeProvisionError } from '@noetic/code-agent/tasks';

/** CLI-side arg shape: `shell` is optional and defaults to a local adapter. */
export interface ProvisionWorktreeArgs {
  readonly projectRoot: string;
  readonly branch: string;
  readonly cwd?: string;
  readonly shell?: ShellAdapter;
}

export async function provisionWorktree(
  args: ProvisionWorktreeArgs,
): Promise<ProvisionWorktreeResult> {
  return sdk.provisionWorktree({
    projectRoot: args.projectRoot,
    branch: args.branch,
    cwd: args.cwd,
    shell: args.shell ?? createLocalShellAdapter(),
  });
}
