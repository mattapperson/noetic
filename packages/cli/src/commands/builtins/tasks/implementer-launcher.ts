/**
 * Spawns the `implementer-runner.ts` wrapper as a detached `bun run`
 * child for a triaged feature. Mirrors `agent-ci-launcher.ts`:
 *
 *   1. Reject if a live implementer is already attached to the leaf
 *      task (verified pid + matching `pidStarttime`).
 *   2. Provision (or reuse) a git worktree for the feature's branch via
 *      {@link provisionWorktree}.
 *   3. Patch the leaf task's `worktreePath` / `branch` so reconcile
 *      and the kanban can locate the checkout.
 *   4. Spawn the wrapper with `NOETIC_*` env so the child can locate
 *      its task, parent, feature and worktree without sharing in-memory
 *      state.
 *   5. Persist `_implementer.json`.
 *   6. Append a `feature:loopStateChanged{phase: 'spawn'}` event on the
 *      parent task (where the feature lives) so daemon subscribers
 *      observe the spawn before the runner starts mutating the graph.
 *
 * On any failure after the spawn the child is torn down and the
 * sidecar removed so we never leave an orphan tracked by a half-written
 * record.
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Signaller } from './agent-ci-control.js';
import { defaultSignaller } from './agent-ci-control.js';
import type { TaskStoreContext } from './fs-store.js';
import { appendEvent, loadTask, saveTask } from './fs-store.js';
import { FeatureLoopState } from './hierarchy/schemas.js';
import { clearImplementer, loadImplementer, saveImplementer } from './implementer-state.js';
import { taskDirPaths } from './paths.js';
import type { Task } from './schemas.js';
import { EventKind } from './schemas.js';
import type { ProvisionWorktreeArgs, ProvisionWorktreeResult } from './worktree-provision.js';
import { provisionWorktree } from './worktree-provision.js';

//#region Types

type SpawnedChild = Pick<ChildProcess, 'pid' | 'unref'> & {
  on(event: 'error', listener: (err: Error) => void): unknown;
};

/** Pluggable spawn function — primarily a test seam. */
export type ImplementerSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => SpawnedChild;

/** Pluggable provisioner — primarily a test seam. */
export type ProvisionWorktreeFn = (args: ProvisionWorktreeArgs) => Promise<ProvisionWorktreeResult>;

export interface StartImplementerRunArgs {
  readonly ctx: TaskStoreContext;
  /** Leaf (worktree-source) task id whose `_implementer.json` we manage. */
  readonly taskId: string;
  /** Structured-task id that owns the feature's hierarchy. */
  readonly parentTaskId: string;
  /** Feature inside the parent's hierarchy that the agent will implement. */
  readonly featureId: string;
  /** Branch the worktree should land on. */
  readonly branch: string;
  /** Test seams. */
  readonly spawnFn?: ImplementerSpawn;
  readonly provisionFn?: ProvisionWorktreeFn;
  readonly signaller?: Signaller;
  readonly now?: string;
  readonly runnerScript?: string;
  /** Extra env passed through to the runner child. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface StartImplementerRunResult {
  readonly sessionId: string;
  readonly pid: number;
  readonly taskId: string;
  readonly parentTaskId: string;
  readonly featureId: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly provisionTool: ProvisionWorktreeResult['tool'];
}

/** Thrown when the wrapper child fails to start or a pre-spawn check rejects. */
export class ImplementerSpawnError extends Error {
  constructor(message: string, cause: unknown = null) {
    super(message, {
      cause,
    });
    this.name = 'ImplementerSpawnError';
  }
}

//#endregion

//#region Defaults

const defaultSpawn: ImplementerSpawn = (command, args, options) =>
  spawn(command, args.slice(), options);

function defaultRunnerScript(): string {
  return fileURLToPath(new URL('implementer-runner.ts', import.meta.url));
}

function makeSessionId(taskId: string): string {
  return `${taskId}-${randomBytes(4).toString('hex')}`;
}

//#endregion

//#region Helpers

interface IsLiveImplementerArgs {
  readonly ctx: TaskStoreContext;
  readonly taskId: string;
  readonly signaller: Signaller;
}

async function isLiveImplementer(args: IsLiveImplementerArgs): Promise<boolean> {
  const existing = await loadImplementer(args.ctx, args.taskId);
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
  readonly spawnFn: ImplementerSpawn;
  readonly runnerScript: string;
  readonly cwd: string;
  readonly taskDir: string;
  readonly parentTaskId: string;
  readonly featureId: string;
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
  readonly error: ImplementerSpawnError;
}

type SpawnRunnerResult = SpawnRunnerOk | SpawnRunnerError;

function buildRunnerEnv(args: SpawnRunnerArgs): NodeJS.ProcessEnv {
  const base = args.extraEnv ?? process.env;
  return {
    ...base,
    NOETIC_TASK_DIR: args.taskDir,
    NOETIC_PARENT_TASK_ID: args.parentTaskId,
    NOETIC_FEATURE_ID: args.featureId,
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
      error: new ImplementerSpawnError(
        'implementer runner failed to start: no pid returned by spawn',
        asyncSpawnError,
      ),
    };
  }
  const pid = child.pid;
  if (!args.signaller.isAlive(pid)) {
    return {
      kind: 'error',
      error: new ImplementerSpawnError(
        `implementer runner pid=${pid} did not start (likely missing bun or invalid script)`,
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

interface PatchLeafTaskArgs {
  readonly ctx: TaskStoreContext;
  readonly taskId: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly now: string;
}

async function patchLeafWorktree(args: PatchLeafTaskArgs): Promise<Task> {
  const existing = await loadTask(args.ctx, args.taskId);
  const next: Task = {
    ...existing,
    worktreePath: args.worktreePath,
    branch: args.branch,
    updatedAt: args.now,
    lastSeenAt: args.now,
  };
  await saveTask(args.ctx, next);
  return next;
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
 * Spawn an implementation agent runner for `featureId` under
 * `parentTaskId`. Throws {@link ImplementerSpawnError} if the wrapper
 * child fails to start, if another live implementer is already
 * attached to the leaf task, or if the worktree cannot be provisioned.
 */
export async function startImplementerRun(
  args: StartImplementerRunArgs,
): Promise<StartImplementerRunResult> {
  const branch = args.branch.trim();
  if (branch.length === 0) {
    throw new ImplementerSpawnError('branch is required');
  }
  const featureId = args.featureId.trim();
  if (featureId.length === 0) {
    throw new ImplementerSpawnError('featureId is required');
  }
  const spawnFn = args.spawnFn ?? defaultSpawn;
  const provisionFn = args.provisionFn ?? provisionWorktree;
  const signaller = args.signaller ?? defaultSignaller;
  const now = args.now ?? new Date().toISOString();
  const runnerScript = args.runnerScript ?? defaultRunnerScript();

  const taskDir = taskDirPaths(args.ctx.projectRoot, args.taskId).dir;

  const live = await isLiveImplementer({
    ctx: args.ctx,
    taskId: args.taskId,
    signaller,
  });
  if (live) {
    throw new ImplementerSpawnError(`implementer already attached to task ${args.taskId}`);
  }

  let provision: ProvisionWorktreeResult;
  try {
    provision = await provisionFn({
      projectRoot: args.ctx.projectRoot,
      branch,
    });
  } catch (err) {
    throw new ImplementerSpawnError(`worktree provisioning failed for ${branch}`, err);
  }
  const worktreePath = resolve(provision.worktreePath);

  // Spawn FIRST so the rest of the writes are conditional on a live
  // pid — mirrors agent-ci-launcher's contract: no observable
  // half-state where the leaf task points at a worktree but no agent
  // is running.
  const spawned = spawnRunner({
    spawnFn,
    runnerScript,
    cwd: worktreePath,
    taskDir,
    parentTaskId: args.parentTaskId,
    featureId,
    extraEnv: args.env,
    signaller,
  });
  if (spawned.kind === 'error') {
    throw spawned.error;
  }

  const sessionId = makeSessionId(args.taskId);
  try {
    await saveImplementer(args.ctx, {
      taskId: args.taskId,
      parentTaskId: args.parentTaskId,
      featureId,
      sessionId,
      pid: spawned.pid,
      pidStarttime: spawned.pidStarttime,
      worktreePath,
      branch,
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

  try {
    await patchLeafWorktree({
      ctx: args.ctx,
      taskId: args.taskId,
      worktreePath,
      branch,
      now,
    });
    await appendEvent(args.ctx, {
      taskId: args.taskId,
      kind: EventKind.TaskUpdated,
      payload: {
        worktreePath,
        branch,
        provisionTool: provision.tool,
      },
      ts: now,
    });
    await appendEvent(args.ctx, {
      taskId: args.parentTaskId,
      kind: EventKind.FeatureLoopStateChanged,
      payload: {
        featureId,
        leafTaskId: args.taskId,
        loopState: FeatureLoopState.Implementing,
        sessionId,
        pid: spawned.pid,
        worktreePath,
        branch,
        phase: 'spawn',
      },
      ts: now,
    });
  } catch (err) {
    abortChild({
      signaller,
      pid: spawned.pid,
    });
    await clearImplementer(args.ctx, args.taskId).catch(() => {
      /* swallow — best-effort cleanup */
    });
    throw err;
  }

  return {
    sessionId,
    pid: spawned.pid,
    taskId: args.taskId,
    parentTaskId: args.parentTaskId,
    featureId,
    branch,
    worktreePath,
    provisionTool: provision.tool,
  };
}

//#endregion
