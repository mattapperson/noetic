import type { TaskStoreContext } from './fs-store.js';
import { listTasks, saveTask } from './fs-store.js';
import type { ProjectWorktree } from './git.js';
import { resolve } from './path-utils.js';
import type { Task } from './schemas.js';
import { TaskLifecycleStatus, TaskSource } from './schemas.js';

//#region Types

export interface ReconcileTasksFsResult {
  readonly markedRemoved: Task[];
}

//#endregion

//#region Helpers

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Lifecycle states that are already terminal — do not stamp `removed`
 * on top of them. `merged` and `removed` are absolute terminals;
 * `cleanup-blocked` is a sticky state that the user/agent must clear
 * explicitly.
 */
function isTerminalLifecycle(status: Task['lifecycleStatus']): boolean {
  return (
    status === TaskLifecycleStatus.Merged ||
    status === TaskLifecycleStatus.Removed ||
    status === TaskLifecycleStatus.CleanupBlocked
  );
}

function buildActiveWorktreePathSet(worktrees: ProjectWorktree[]): Set<string> {
  const set = new Set<string>();
  for (const wt of worktrees) {
    set.add(resolve(wt.path));
  }
  return set;
}

function shouldMarkRemoved(args: { task: Task; activePaths: Set<string> }): boolean {
  const { task, activePaths } = args;
  if (task.source !== TaskSource.Worktree) {
    return false;
  }
  if (isTerminalLifecycle(task.lifecycleStatus)) {
    return false;
  }
  if (task.worktreePath === null) {
    return false;
  }
  return !activePaths.has(resolve(task.worktreePath));
}

//#endregion

//#region Public API

/**
 * Reconcile on-disk tasks against the project's live `git worktree list`.
 * For each worktree-source task whose `worktreePath` no longer appears in
 * `worktrees`, atomically stamp `lifecycleStatus = 'removed'` (and bump
 * `updatedAt`). Tasks already in a terminal state are left alone, as are
 * manual-source tasks. Idempotent: re-running on a stable list is a
 * no-op.
 */
export async function reconcileTasksFs(
  ctx: TaskStoreContext,
  worktrees: ProjectWorktree[],
): Promise<ReconcileTasksFsResult> {
  const activePaths = buildActiveWorktreePathSet(worktrees);
  const tasks = await listTasks(ctx);
  const markedRemoved: Task[] = [];
  const now = nowIso();
  for (const task of tasks) {
    if (
      !shouldMarkRemoved({
        task,
        activePaths,
      })
    ) {
      continue;
    }
    const next: Task = {
      ...task,
      lifecycleStatus: TaskLifecycleStatus.Removed,
      updatedAt: now,
    };
    await saveTask(ctx, next);
    markedRemoved.push(next);
  }
  return {
    markedRemoved,
  };
}

//#endregion
