/**
 * CLI entry point for spawning the planner runner. Thin wrapper around
 * the SDK launcher that overrides the default `runnerScript` path so
 * `bun run` points at the CLI's `planner-runner.ts` instead of the
 * SDK's own (different directory).
 */

import type { StartPlannerRunArgs, StartPlannerRunResult } from '@noetic-tools/code-agent/tasks';
import * as sdk from '@noetic-tools/code-agent/tasks';
import { fileUrlToPath } from '@noetic-tools/code-agent/tasks';

export type { StartPlannerRunArgs, StartPlannerRunResult } from '@noetic-tools/code-agent/tasks';
export { PlannerSpawnError, PlannerSpawnErrorCode } from '@noetic-tools/code-agent/tasks';

/**
 * Resolve the CLI's local `planner-runner.ts` path. The SDK's launcher
 * would default via its own `import.meta.url`, which points at the
 * wrong directory — the runner script lives in the CLI.
 */
function cliDefaultRunnerScript(): string {
  return fileUrlToPath(new URL('planner-runner.ts', import.meta.url));
}

export async function startPlannerRun(args: StartPlannerRunArgs): Promise<StartPlannerRunResult> {
  return sdk.startPlannerRun({
    ...args,
    runnerScript: args.runnerScript ?? cliDefaultRunnerScript(),
  });
}
