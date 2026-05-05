/**
 * Spawns the `planner-runner.ts` wrapper as a detached `bun run` child
 * for a manual task that has been opted into autopilot but has no
 * hierarchy yet. Mirrors `implementer-launcher.ts`:
 *
 *   1. Reject if a live planner is already attached to the task.
 *   2. Spawn the wrapper with `NOETIC_TASK_DIR` env so the child can
 *      locate its task directory and project root.
 *   3. Persist `_planner.json` (sidecar before any state write so a
 *      crash leaves a record of the in-flight subprocess).
 *   4. Patch `task.json` to flip `autopilotState = 'planning'`.
 *   5. Append a `task:updated` event so daemon subscribers observe
 *      the spawn.
 */

import type { ProcessSignaller, SubprocessAdapter, SubprocessHandle } from '@noetic/core';

import {
  requireNodeProcessSignaller,
  requireNodeSubprocessAdapter,
} from './subprocess-required.js';

import { fileUrlToPath } from './file-url-to-path.js';
import type { TaskStoreContext } from './fs-store.js';
import { appendEvent, loadTask, saveTask } from './fs-store.js';
import { taskDirPaths } from './paths.js';
import { clearPlanner, loadPlanner, savePlanner } from './planner-state.js';
import { randomHex } from './random.js';
import type { Task } from './schemas.js';
import { AutopilotState, EventKind } from './schemas.js';

//#region Types

export interface StartPlannerRunArgs {
  readonly ctx: TaskStoreContext;
  readonly taskId: string;
  readonly subprocess?: SubprocessAdapter;
  readonly signaller?: ProcessSignaller;
  readonly now?: string;
  readonly runnerScript?: string;
  readonly env?: Record<string, string | undefined>;
}

export interface StartPlannerRunResult {
  readonly sessionId: string;
  readonly pid: number;
  readonly taskId: string;
  readonly previousAutopilotState: Task['autopilotState'];
  readonly autopilotState: Task['autopilotState'];
}

export const PlannerSpawnErrorCode = {
  AlreadyAttached: 'already-attached',
  SpawnFailed: 'spawn-failed',
} as const;

export type PlannerSpawnErrorCode =
  (typeof PlannerSpawnErrorCode)[keyof typeof PlannerSpawnErrorCode];

export class PlannerSpawnError extends Error {
  readonly code: PlannerSpawnErrorCode;
  constructor(code: PlannerSpawnErrorCode, message: string, cause: unknown = null) {
    super(message, {
      cause,
    });
    this.name = 'PlannerSpawnError';
    this.code = code;
  }
}

//#endregion

//#region Defaults

function defaultRunnerScript(): string {
  return fileUrlToPath(new URL('planner-runner.ts', import.meta.url));
}

function makeSessionId(taskId: string): string {
  return `${taskId}-${randomHex(4)}`;
}

//#endregion

//#region Helpers

interface IsLivePlannerArgs {
  readonly ctx: TaskStoreContext;
  readonly taskId: string;
  readonly signaller: ProcessSignaller;
}

async function isLivePlanner(args: IsLivePlannerArgs): Promise<boolean> {
  const existing = await loadPlanner(args.ctx, args.taskId);
  if (existing === null) {
    return false;
  }
  if (!args.signaller.isAlive(existing.pid)) {
    return false;
  }
  if (existing.pidStarttime === null) {
    return true;
  }
  const current = args.signaller.startTime(existing.pid);
  if (current === null) {
    return false;
  }
  return current === existing.pidStarttime;
}

interface SpawnRunnerArgs {
  readonly subprocess: SubprocessAdapter;
  readonly runnerScript: string;
  readonly cwd: string;
  readonly taskDir: string;
  readonly extraEnv: Record<string, string | undefined> | undefined;
}

interface SpawnRunnerOk {
  readonly kind: 'ok';
  readonly pid: number;
  readonly pidStarttime: string | null;
  readonly handle: SubprocessHandle;
}

interface SpawnRunnerError {
  readonly kind: 'error';
  readonly error: PlannerSpawnError;
}

type SpawnRunnerResult = SpawnRunnerOk | SpawnRunnerError;

function buildRunnerEnv(args: SpawnRunnerArgs): Record<string, string | undefined> {
  return {
    ...(args.extraEnv ?? {}),
    NOETIC_TASK_DIR: args.taskDir,
    NOETIC_TASK_CWD: args.cwd,
  };
}

function handlePid(handle: SubprocessHandle): number | null {
  const pid = handle.metadata?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return pid;
}

function handlePidStarttime(handle: SubprocessHandle): string | null {
  const pidStarttime = handle.metadata?.pidStarttime;
  return typeof pidStarttime === 'string' ? pidStarttime : null;
}

async function spawnRunner(args: SpawnRunnerArgs): Promise<SpawnRunnerResult> {
  let handle: SubprocessHandle;
  try {
    handle = await args.subprocess.spawn({
      command: 'bun',
      args: [
        'run',
        args.runnerScript,
      ],
      cwd: args.cwd,
      detached: true,
      env: buildRunnerEnv(args),
      metadata: {
        taskRole: 'planner',
      },
    });
  } catch (err) {
    return {
      kind: 'error',
      error: new PlannerSpawnError(
        PlannerSpawnErrorCode.SpawnFailed,
        'planner runner failed to start',
        err,
      ),
    };
  }

  const pid = handlePid(handle);
  if (pid === null) {
    await args.subprocess.stop(handle.id, 'missing pid metadata').catch(() => {
      /* best-effort cleanup */
    });
    return {
      kind: 'error',
      error: new PlannerSpawnError(
        PlannerSpawnErrorCode.SpawnFailed,
        'planner runner failed to start: subprocess adapter did not return pid metadata',
      ),
    };
  }

  const live = await args.subprocess.isAlive(handle);
  if (!live) {
    await args.subprocess.stop(handle.id, 'not alive after spawn').catch(() => {
      /* best-effort cleanup */
    });
    return {
      kind: 'error',
      error: new PlannerSpawnError(
        PlannerSpawnErrorCode.SpawnFailed,
        `planner runner pid=${pid} did not start (likely missing bun or invalid script)`,
      ),
    };
  }
  return {
    kind: 'ok',
    pid,
    pidStarttime: handlePidStarttime(handle),
    handle,
  };
}

interface PatchPlanningArgs {
  readonly ctx: TaskStoreContext;
  readonly taskId: string;
  readonly now: string;
}

interface PatchPlanningResult {
  readonly previousAutopilotState: Task['autopilotState'];
  readonly autopilotState: Task['autopilotState'];
}

async function patchTaskForPlanning(args: PatchPlanningArgs): Promise<PatchPlanningResult> {
  const task = await loadTask(args.ctx, args.taskId);
  const previousAutopilotState = task.autopilotState;
  const next: Task = {
    ...task,
    autopilotState: AutopilotState.Planning,
    paused: false,
    pauseReason: null,
    lastAutopilotActivityAt: args.now,
    updatedAt: args.now,
    lastSeenAt: args.now,
  };
  await saveTask(args.ctx, next);
  return {
    previousAutopilotState,
    autopilotState: AutopilotState.Planning,
  };
}

interface AbortChildArgs {
  readonly subprocess: SubprocessAdapter;
  readonly handle: SubprocessHandle;
}

async function abortChild(args: AbortChildArgs): Promise<void> {
  try {
    await args.subprocess.stop(args.handle.id, 'planner launch failed');
  } catch {
    /* swallow — child may already be gone */
  }
}

//#endregion

//#region Public API

/**
 * Spawn a planner runner for `taskId`. Throws {@link PlannerSpawnError}
 * if the wrapper child fails to start or if another live planner is
 * already attached.
 */
export async function startPlannerRun(args: StartPlannerRunArgs): Promise<StartPlannerRunResult> {
  const cwd = args.ctx.projectRoot;
  const subprocess = args.subprocess ?? requireNodeSubprocessAdapter();
  const signaller = args.signaller ?? requireNodeProcessSignaller;
  const now = args.now ?? new Date().toISOString();
  const runnerScript = args.runnerScript ?? defaultRunnerScript();

  const taskDir = taskDirPaths(args.ctx, args.taskId).dir;

  const live = await isLivePlanner({
    ctx: args.ctx,
    taskId: args.taskId,
    signaller,
  });
  if (live) {
    throw new PlannerSpawnError(
      PlannerSpawnErrorCode.AlreadyAttached,
      `planner already attached to task ${args.taskId}`,
    );
  }

  const spawned = await spawnRunner({
    subprocess,
    runnerScript,
    cwd,
    taskDir,
    extraEnv: args.env,
  });
  if (spawned.kind === 'error') {
    throw spawned.error;
  }

  const sessionId = makeSessionId(args.taskId);
  try {
    await savePlanner(args.ctx, {
      taskId: args.taskId,
      sessionId,
      pid: spawned.pid,
      pidStarttime: spawned.pidStarttime,
      startedAt: now,
      pausedAt: null,
    });
  } catch (err) {
    await abortChild({
      subprocess,
      handle: spawned.handle,
    });
    throw err;
  }

  let patch: PatchPlanningResult;
  try {
    patch = await patchTaskForPlanning({
      ctx: args.ctx,
      taskId: args.taskId,
      now,
    });
  } catch (err) {
    await abortChild({
      subprocess,
      handle: spawned.handle,
    });
    await clearPlanner(args.ctx, args.taskId).catch(() => {
      /* swallow — best-effort cleanup */
    });
    throw err;
  }

  await appendEvent(args.ctx, {
    taskId: args.taskId,
    kind: EventKind.TaskUpdated,
    payload: {
      previousAutopilotState: patch.previousAutopilotState,
      autopilotState: patch.autopilotState,
      sessionId,
      pid: spawned.pid,
      phase: 'spawn',
    },
    ts: now,
  });

  return {
    sessionId,
    pid: spawned.pid,
    taskId: args.taskId,
    previousAutopilotState: patch.previousAutopilotState,
    autopilotState: patch.autopilotState,
  };
}

//#endregion
