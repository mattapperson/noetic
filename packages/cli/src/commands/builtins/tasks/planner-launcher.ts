/**
 * CLI re-export of the SDK planner launcher plus a thin compat wrapper
 * that preserves the historical CLI `spawnFn` seam. Tests pass a
 * `spawnFn: PlannerSpawn` that returns a fake child record; the wrapper
 * synthesises a `SubprocessAdapter` from it so the SDK launcher can
 * consume the same mock.
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';

import type { StartPlannerRunResult } from '@noetic/code-agent/tasks';
import * as sdk from '@noetic/code-agent/tasks';
import { fileUrlToPath } from '@noetic/code-agent/tasks';
import type {
  ProcessSignaller,
  SubprocessAdapter,
  SubprocessControlResult,
  SubprocessHandle,
  SubprocessRequest,
  SubprocessStopResult,
} from '@noetic/core';
import { createLocalSubprocessAdapter, defaultProcessSignaller } from '@noetic/core/adapters/node';

export type {
  StartPlannerRunArgs,
  StartPlannerRunResult,
} from '@noetic/code-agent/tasks';
export { PlannerSpawnError, PlannerSpawnErrorCode } from '@noetic/code-agent/tasks';

//#region Compat types

type SpawnedChild = Pick<ChildProcess, 'pid' | 'unref'> & {
  on(event: 'error', listener: (err: Error) => void): unknown;
};

/**
 * Legacy CLI spawn seam — returns a child-process-ish record rather
 * than a SubprocessHandle. Tests inject a fake.
 */
export type PlannerSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => SpawnedChild;

export interface StartPlannerRunArgsCli {
  readonly ctx: sdk.StartPlannerRunArgs['ctx'];
  readonly taskId: string;
  readonly signaller?: ProcessSignaller;
  readonly now?: string;
  readonly runnerScript?: string;
  readonly env?: Record<string, string | undefined>;
  /** Legacy seam — overrides the subprocess path; tests use this. */
  readonly spawnFn?: PlannerSpawn;
  /** Direct subprocess override (takes precedence over spawnFn). */
  readonly subprocess?: SubprocessAdapter;
}

//#endregion

//#region Helpers

/**
 * Build a minimal `SubprocessAdapter` that uses the legacy `PlannerSpawn`
 * seam for `spawn` and the shared `ProcessSignaller` for liveness/signal.
 * Only the surface the SDK launcher touches is implemented; other
 * methods fall back to not-found.
 */
function adapterFromSpawnFn(spawnFn: PlannerSpawn, signaller: ProcessSignaller): SubprocessAdapter {
  const handles = new Map<string, SubprocessHandle>();
  return {
    async spawn(request: SubprocessRequest) {
      const child = spawnFn(request.command, request.args ?? [], {
        cwd: request.cwd,
        detached: request.detached ?? false,
        env: request.env
          ? {
              ...process.env,
              ...request.env,
            }
          : undefined,
      });
      child.on('error', () => {
        /* swallow — caller surfaces via isAlive */
      });
      child.unref();
      const pid = child.pid ?? 0;
      const handle: SubprocessHandle = {
        id: `planner-${pid}-${Date.now()}`,
        status: 'running',
        startedAt: new Date().toISOString(),
        metadata: {
          pid,
          pidStarttime: signaller.startTime(pid),
        },
      };
      handles.set(handle.id, handle);
      return handle;
    },
    async get(id) {
      return handles.get(id) ?? null;
    },
    async stop(id): Promise<SubprocessStopResult> {
      const handle = handles.get(id);
      if (!handle) {
        return {
          kind: 'not_found',
          handleId: id,
        };
      }
      handles.delete(id);
      return {
        kind: 'stopped',
        handleId: id,
        handle,
      };
    },
    async pause(id): Promise<SubprocessControlResult> {
      return {
        kind: 'not_found',
        handleId: id,
      };
    },
    async resume(id): Promise<SubprocessControlResult> {
      return {
        kind: 'not_found',
        handleId: id,
      };
    },
    async isAlive(handle) {
      const pid = handle.metadata?.pid;
      return typeof pid === 'number' && signaller.isAlive(pid);
    },
  };
}

//#endregion

//#region Public API

/**
 * Resolve the CLI's local `planner-runner.ts` path. The SDK's launcher
 * would default via its own `import.meta.url`, which points at the
 * wrong directory — the runner script lives in the CLI.
 */
function cliDefaultRunnerScript(): string {
  return fileUrlToPath(new URL('planner-runner.ts', import.meta.url));
}

export async function startPlannerRun(
  args: StartPlannerRunArgsCli,
): Promise<StartPlannerRunResult> {
  const signaller = args.signaller ?? defaultProcessSignaller;
  const subprocess =
    args.subprocess ??
    (args.spawnFn ? adapterFromSpawnFn(args.spawnFn, signaller) : createLocalSubprocessAdapter());
  return sdk.startPlannerRun({
    ctx: args.ctx,
    taskId: args.taskId,
    signaller,
    now: args.now,
    runnerScript: args.runnerScript ?? cliDefaultRunnerScript(),
    env: args.env,
    subprocess,
  });
}

//#endregion
