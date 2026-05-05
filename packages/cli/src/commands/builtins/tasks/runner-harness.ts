/**
 * CLI re-export of the SDK's runner harness plus a thin wrapper that
 * defaults `shell` to `createLocalShellAdapter()` — the SDK version
 * requires an explicit shell so it stays portable.
 */

import type { RunnerHarnessOpts, RunnerHarnessResult } from '@noetic/code-agent/tasks';
import * as sdk from '@noetic/code-agent/tasks';
import { createLocalShellAdapter } from '@noetic/core/adapters/node';

export type {
  RunnerHarnessOpts,
  RunnerHarnessResult,
  RunnerLoopHarness,
  RunnerRole,
  RunnerSignal,
  RunRunnerLoopOpts,
  RunRunnerNudgeOpts,
} from '@noetic/code-agent/tasks';
export { createRunnerSignal, escalateStalledRunner, runRunnerLoop } from '@noetic/code-agent/tasks';

/** CLI-side `createRunnerHarness`: `shell` is optional, defaults to local. */
export async function createRunnerHarness(
  opts: Omit<RunnerHarnessOpts, 'shell'> & {
    readonly shell?: RunnerHarnessOpts['shell'];
  },
): Promise<RunnerHarnessResult> {
  return sdk.createRunnerHarness({
    ...opts,
    shell: opts.shell ?? createLocalShellAdapter(),
  });
}
