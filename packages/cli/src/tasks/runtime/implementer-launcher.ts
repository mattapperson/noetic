/**
 * CLI entry point for spawning the implementer runner. Thin wrapper
 * around the SDK launcher that overrides the default `runnerScript`
 * path so `bun run` points at the CLI's `implementer-runner.ts`
 * instead of the SDK's own (different directory), and defaults
 * `shell` to a local adapter when the caller hasn't supplied one.
 */

import type { StartImplementerRunResult } from '@noetic/code-agent/tasks';
import * as sdk from '@noetic/code-agent/tasks';
import { fileUrlToPath } from '@noetic/code-agent/tasks';
import { createLocalShellAdapter } from '@noetic/core/adapters/node';

export type {
  LauncherProvisionRequest,
  StartImplementerRunResult,
} from '@noetic/code-agent/tasks';
export { ImplementerSpawnError } from '@noetic/code-agent/tasks';

/**
 * CLI argument shape: `shell` is optional (defaults to
 * `createLocalShellAdapter()`) because production CLI callers always
 * want the local shell. Everything else mirrors the SDK shape.
 */
export type StartImplementerRunArgs = Omit<sdk.StartImplementerRunArgs, 'shell'> & {
  readonly shell?: sdk.StartImplementerRunArgs['shell'];
};

function cliDefaultRunnerScript(): string {
  return fileUrlToPath(new URL('implementer-runner.ts', import.meta.url));
}

export async function startImplementerRun(
  args: StartImplementerRunArgs,
): Promise<StartImplementerRunResult> {
  return sdk.startImplementerRun({
    ...args,
    runnerScript: args.runnerScript ?? cliDefaultRunnerScript(),
    shell: args.shell ?? createLocalShellAdapter(),
  });
}
