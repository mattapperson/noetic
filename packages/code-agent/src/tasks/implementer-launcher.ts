/**
 * Spawns the `implementer-runner.ts` wrapper as a detached `bun run`
 * child for a triaged feature.
 *
 *   1. Reject if a live implementer is already attached to the leaf
 *      task (detected via the adapter's handle manifest — the
 *      in-memory `listLive()` + local-adapter pidStarttime drift check
 *      replace the old sidecar-based detection).
 *   2. Provision (or reuse) a git worktree for the feature's branch via
 *      {@link provisionWorktree}.
 *   3. Patch the leaf task's `worktreePath` / `branch` so reconcile
 *      and the kanban can locate the checkout.
 *   4. Spawn the wrapper with `NOETIC_*` env so the child can locate
 *      its task, parent, feature and worktree without sharing in-memory
 *      state. The adapter persists the handle manifest at `spawn()`
 *      time so peer callers + restarts can find the live child.
 *   5. Append a `feature:loopStateChanged{phase: 'spawn'}` event on the
 *      parent task (where the feature lives) so daemon subscribers
 *      observe the spawn before the runner starts mutating the graph.
 *
 * On any failure after the spawn the child is torn down so we never
 * leave an orphan tracked by a half-written record.
 */

import type { ShellAdapter, SubprocessAdapter, SubprocessHandle } from '@noetic-tools/core';

import { fileUrlToPath } from './file-url-to-path.js';
import type { TaskStoreContext } from './fs-store.js';
import { appendEvent, loadTask, saveTask } from './fs-store.js';
import { FeatureLoopState } from './hierarchy/schemas.js';
import { taskDirPaths } from './paths.js';
import { randomHex } from './random.js';
import type { Task } from './schemas.js';
import { EventKind } from './schemas.js';
import { findLiveTaskHandle, TaskRole } from './task-runtime-index.js';
import type { ProvisionWorktreeResult } from './worktree-provision.js';
import { provisionWorktree } from './worktree-provision.js';

//#region Types

/** Per-call arguments that callers pass to their own `provisionFn`. */
export interface LauncherProvisionRequest {
  readonly projectRoot: string;
  readonly branch: string;
}

/** Pluggable provisioner — primarily a test seam. */
export type ProvisionWorktreeFn = (
  args: LauncherProvisionRequest,
) => Promise<ProvisionWorktreeResult>;

export interface StartImplementerRunArgs {
  readonly ctx: TaskStoreContext;
  /** Leaf (worktree-source) task id whose live handle we track. */
  readonly taskId: string;
  /** Structured-task id that owns the feature's hierarchy. */
  readonly parentTaskId: string;
  /** Feature inside the parent's hierarchy that the agent will implement. */
  readonly featureId: string;
  /** Branch the worktree should land on. */
  readonly branch: string;
  /**
   * Subprocess adapter used to dispatch the runner process AND to check
   * for an existing live implementer via its handle manifest. Required —
   * callers construct one per host and thread it through.
   */
  readonly subprocess: SubprocessAdapter;
  readonly provisionFn?: ProvisionWorktreeFn;
  readonly now?: string;
  readonly runnerScript?: string;
  /** Extra env passed through to the runner child. */
  readonly env?: Record<string, string | undefined>;
  /**
   * Shell passed to the default {@link provisionWorktree} when
   * `provisionFn` is omitted. Required in that case — the SDK stays
   * portable by never reaching for a local adapter implicitly.
   */
  readonly shell?: ShellAdapter;
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

function defaultRunnerScript(): string {
  return fileUrlToPath(new URL('implementer-runner.ts', import.meta.url));
}

function makeSessionId(taskId: string): string {
  return `${taskId}-${randomHex(4)}`;
}

//#endregion

//#region Helpers

interface SpawnRunnerArgs {
  readonly subprocess: SubprocessAdapter;
  readonly runnerScript: string;
  readonly cwd: string;
  readonly taskDir: string;
  readonly taskId: string;
  readonly parentTaskId: string;
  readonly featureId: string;
  readonly extraEnv: Record<string, string | undefined> | undefined;
}

interface SpawnRunnerOk {
  readonly kind: 'ok';
  readonly pid: number;
  readonly handle: SubprocessHandle;
}

interface SpawnRunnerError {
  readonly kind: 'error';
  readonly error: ImplementerSpawnError;
}

type SpawnRunnerResult = SpawnRunnerOk | SpawnRunnerError;

function buildRunnerEnv(args: SpawnRunnerArgs): Record<string, string | undefined> {
  return {
    ...(args.extraEnv ?? {}),
    NOETIC_TASK_DIR: args.taskDir,
    NOETIC_PARENT_TASK_ID: args.parentTaskId,
    NOETIC_FEATURE_ID: args.featureId,
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
        taskRole: TaskRole.Implementer,
        taskId: args.taskId,
        parentTaskId: args.parentTaskId,
        featureId: args.featureId,
      },
    });
  } catch (err) {
    return {
      kind: 'error',
      error: new ImplementerSpawnError('implementer runner failed to start', err),
    };
  }

  const pid = handlePid(handle);
  if (pid === null) {
    await args.subprocess.stop(handle.id, 'missing pid metadata').catch(() => {
      /* best-effort cleanup */
    });
    return {
      kind: 'error',
      error: new ImplementerSpawnError(
        'implementer runner failed to start: subprocess adapter did not return pid metadata',
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
      error: new ImplementerSpawnError(
        `implementer runner pid=${pid} did not start (likely missing bun or invalid script)`,
      ),
    };
  }
  return {
    kind: 'ok',
    pid,
    handle,
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
  readonly subprocess: SubprocessAdapter;
  readonly handle: SubprocessHandle;
}

async function abortChild(args: AbortChildArgs): Promise<void> {
  try {
    await args.subprocess.stop(args.handle.id, 'implementer launch failed');
  } catch {
    /* swallow — child may already be gone */
  }
}

function resolvePathFrom(base: string, target: string): string {
  if (target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target)) {
    return target;
  }
  return `${base.replace(/[\\/]+$/, '')}/${target}`;
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
  const shell = args.shell;
  const provisionFn: ProvisionWorktreeFn =
    args.provisionFn ??
    (async (provisionArgs) => {
      if (shell === undefined) {
        throw new ImplementerSpawnError(
          'implementer launch requires either a `shell` (to default provisionWorktree) or a custom `provisionFn`',
        );
      }
      return provisionWorktree({
        projectRoot: provisionArgs.projectRoot,
        branch: provisionArgs.branch,
        shell,
      });
    });
  const now = args.now ?? new Date().toISOString();
  const runnerScript = args.runnerScript ?? defaultRunnerScript();

  const taskDir = taskDirPaths(args.ctx, args.taskId).dir;

  const existing = await findLiveTaskHandle({
    adapter: args.subprocess,
    taskId: args.taskId,
    taskRole: TaskRole.Implementer,
    featureId,
  });
  if (existing !== null) {
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
  const worktreePath = resolvePathFrom(args.ctx.projectRoot, provision.worktreePath);

  // Spawn FIRST so the rest of the writes are conditional on a live
  // pid: no observable half-state where the leaf task points at a
  // worktree but no agent is running.
  const spawned = await spawnRunner({
    subprocess: args.subprocess,
    runnerScript,
    cwd: worktreePath,
    taskDir,
    taskId: args.taskId,
    parentTaskId: args.parentTaskId,
    featureId,
    extraEnv: args.env,
  });
  if (spawned.kind === 'error') {
    throw spawned.error;
  }

  const sessionId = makeSessionId(args.taskId);
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
    await abortChild({
      subprocess: args.subprocess,
      handle: spawned.handle,
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
