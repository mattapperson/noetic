/**
 * Spawns the `planner-runner.ts` wrapper as a detached `bun run`
 * child for a manual task that has been opted into autopilot but has
 * no hierarchy yet. Mirrors `agent-ci-launcher.ts` /
 * `implementer-launcher.ts`:
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

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { Signaller } from './agent-ci-control.js';
import { defaultSignaller } from './agent-ci-control.js';
import type { TaskStoreContext } from './fs-store.js';
import { appendEvent, loadTask, saveTask } from './fs-store.js';
import { taskDirPaths } from './paths.js';
import { clearPlanner, loadPlanner, savePlanner } from './planner-state.js';
import type { Task } from './schemas.js';
import { AutopilotState, EventKind } from './schemas.js';

//#region Types

type SpawnedChild = Pick<ChildProcess, 'pid' | 'unref'> & {
  on(event: 'error', listener: (err: Error) => void): unknown;
};

export type PlannerSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => SpawnedChild;

export interface StartPlannerRunArgs {
  readonly ctx: TaskStoreContext;
  readonly taskId: string;
  readonly spawnFn?: PlannerSpawn;
  readonly signaller?: Signaller;
  readonly now?: string;
  readonly runnerScript?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface StartPlannerRunResult {
  readonly sessionId: string;
  readonly pid: number;
  readonly taskId: string;
  readonly previousAutopilotState: Task['autopilotState'];
  readonly autopilotState: Task['autopilotState'];
}

export class PlannerSpawnError extends Error {
  constructor(message: string, cause: unknown = null) {
    super(message, {
      cause,
    });
    this.name = 'PlannerSpawnError';
  }
}

//#endregion

//#region Defaults

const defaultSpawn: PlannerSpawn = (command, args, options) =>
  spawn(command, args.slice(), options);

function defaultRunnerScript(): string {
  return fileURLToPath(new URL('planner-runner.ts', import.meta.url));
}

function makeSessionId(taskId: string): string {
  return `${taskId}-${randomBytes(4).toString('hex')}`;
}

//#endregion

//#region Helpers

interface IsLivePlannerArgs {
  readonly ctx: TaskStoreContext;
  readonly taskId: string;
  readonly signaller: Signaller;
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
  readonly spawnFn: PlannerSpawn;
  readonly runnerScript: string;
  readonly cwd: string;
  readonly taskDir: string;
  readonly extraEnv: NodeJS.ProcessEnv | undefined;
  readonly signaller: Signaller;
}

interface SpawnRunnerOk {
  readonly kind: 'ok';
  readonly pid: number;
  readonly pidStarttime: string | null;
}

interface SpawnRunnerError {
  readonly kind: 'error';
  readonly error: PlannerSpawnError;
}

type SpawnRunnerResult = SpawnRunnerOk | SpawnRunnerError;

function buildRunnerEnv(args: SpawnRunnerArgs): NodeJS.ProcessEnv {
  const base = args.extraEnv ?? process.env;
  return {
    ...base,
    NOETIC_TASK_DIR: args.taskDir,
    NOETIC_TASK_CWD: args.cwd,
  };
}

function spawnRunner(args: SpawnRunnerArgs): SpawnRunnerResult {
  const child = args.spawnFn(
    'bun',
    [
      'run',
      args.runnerScript,
    ],
    {
      cwd: args.cwd,
      detached: true,
      stdio: 'ignore',
      env: buildRunnerEnv(args),
    },
  );
  let asyncSpawnError: unknown = null;
  child.on('error', (err: unknown) => {
    asyncSpawnError = err;
  });
  child.unref();

  if (child.pid === undefined) {
    return {
      kind: 'error',
      error: new PlannerSpawnError(
        'planner runner failed to start: no pid returned by spawn',
        asyncSpawnError,
      ),
    };
  }
  const pid = child.pid;
  if (!args.signaller.isAlive(pid)) {
    return {
      kind: 'error',
      error: new PlannerSpawnError(
        `planner runner pid=${pid} did not start (likely missing bun or invalid script)`,
        asyncSpawnError,
      ),
    };
  }
  return {
    kind: 'ok',
    pid,
    pidStarttime: args.signaller.startTime(pid),
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
  readonly signaller: Signaller;
  readonly pid: number;
}

function abortChild(args: AbortChildArgs): void {
  try {
    args.signaller.kill(-args.pid, 'SIGTERM');
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
  const spawnFn = args.spawnFn ?? defaultSpawn;
  const signaller = args.signaller ?? defaultSignaller;
  const now = args.now ?? new Date().toISOString();
  const runnerScript = args.runnerScript ?? defaultRunnerScript();

  const taskDir = taskDirPaths(args.ctx.projectRoot, args.taskId).dir;

  const live = await isLivePlanner({
    ctx: args.ctx,
    taskId: args.taskId,
    signaller,
  });
  if (live) {
    throw new PlannerSpawnError(`planner already attached to task ${args.taskId}`);
  }

  const spawned = spawnRunner({
    spawnFn,
    runnerScript,
    cwd,
    taskDir,
    extraEnv: args.env,
    signaller,
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
    abortChild({
      signaller,
      pid: spawned.pid,
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
    abortChild({
      signaller,
      pid: spawned.pid,
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
