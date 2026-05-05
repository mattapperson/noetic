/**
 * CLI re-export of the SDK's implementer launcher plus a thin wrapper
 * that keeps the historical CLI signature — `shell` is optional and
 * defaults to a local adapter; the `provisionFn` seam accepts the
 * CLI's `ProvisionWorktreeArgs` (which carries an optional `shell`).
 */

import type { StartImplementerRunResult } from '@noetic/code-agent/tasks';
import * as sdk from '@noetic/code-agent/tasks';
import { fileUrlToPath } from '@noetic/code-agent/tasks';
import {
  createLocalShellAdapter,
  createLocalSubprocessAdapter,
  defaultProcessSignaller,
} from '@noetic/core/adapters/node';

import type { ProvisionWorktreeArgs, ProvisionWorktreeResult } from './worktree-provision.js';

export type { LauncherProvisionRequest, StartImplementerRunResult } from '@noetic/code-agent/tasks';
export { ImplementerSpawnError } from '@noetic/code-agent/tasks';

/**
 * CLI-side provisionFn seam — accepts `ProvisionWorktreeArgs` (the CLI's
 * widened shape with optional `shell`) for backwards compatibility with
 * tests that typed their mocks against the old local signature.
 */
export type ProvisionWorktreeFn = (args: ProvisionWorktreeArgs) => Promise<ProvisionWorktreeResult>;

/**
 * Historical CLI argument shape. Mirrors the SDK shape but uses the
 * CLI's `ProvisionWorktreeFn` seam and lets callers omit `shell`
 * (defaulted to `createLocalShellAdapter()` at the wrapper boundary).
 */
export type StartImplementerRunArgs = Omit<sdk.StartImplementerRunArgs, 'provisionFn' | 'shell'> & {
  readonly provisionFn?: ProvisionWorktreeFn;
  readonly shell?: sdk.StartImplementerRunArgs['shell'];
};

/**
 * Resolve the CLI's local `implementer-runner.ts` path. The SDK's
 * launcher defaults `runnerScript` via `import.meta.url` inside the
 * SDK package, which points at the wrong directory in our repo layout
 * (the runner script lives in the CLI, not the SDK), so we override.
 */
function cliDefaultRunnerScript(): string {
  return fileUrlToPath(new URL('implementer-runner.ts', import.meta.url));
}

export async function startImplementerRun(
  args: StartImplementerRunArgs,
): Promise<StartImplementerRunResult> {
  const shell = args.shell ?? createLocalShellAdapter();
  const provisionFn = args.provisionFn;
  return sdk.startImplementerRun({
    ctx: args.ctx,
    taskId: args.taskId,
    parentTaskId: args.parentTaskId,
    featureId: args.featureId,
    branch: args.branch,
    subprocess: args.subprocess ?? createLocalSubprocessAdapter(),
    signaller: args.signaller ?? defaultProcessSignaller,
    now: args.now,
    runnerScript: args.runnerScript ?? cliDefaultRunnerScript(),
    env: args.env,
    shell,
    provisionFn: provisionFn
      ? (req: sdk.LauncherProvisionRequest) =>
          provisionFn({
            ...req,
            shell,
          })
      : undefined,
  });
}
