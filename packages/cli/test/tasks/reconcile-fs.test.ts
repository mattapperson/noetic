import { describe, expect, it } from 'bun:test';

import { loadTask, saveTask } from '@noetic/code-agent/tasks/store/fs-node';
import type { ProjectWorktree } from '@noetic/code-agent/tasks/worktree-node';
import { reconcileTasksFs } from '@noetic/code-agent/tasks';
import type { Task } from '@noetic/code-agent/tasks/schema';
import {
  AutopilotState,
  generateTaskId,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '@noetic/code-agent/tasks/schema';
import { makeStoreContext } from './_helpers.js';

//#region Fixtures

const NOW = '2026-04-30T00:00:00.000Z';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? generateTaskId(),
    source: TaskSource.Worktree,
    title: 't',
    projectRoot: '/repo',
    worktreePath: '/repo/.worktrees/foo',
    branch: 'feat/foo',
    headSha: null,
    reviewStatus: TaskReviewStatus.NotStarted,
    lifecycleStatus: TaskLifecycleStatus.Active,
    paused: false,
    pauseReason: null,
    archivedAt: null,
    hierarchyStatus: null,
    autopilotEnabled: false,
    autopilotState: AutopilotState.Inactive,
    lastAutopilotActivityAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  };
}

function makeWorktree(overrides: Partial<ProjectWorktree> = {}): ProjectWorktree {
  return {
    projectRoot: '/repo',
    path: '/repo/.worktrees/foo',
    branch: 'feat/foo',
    headSha: null,
    current: false,
    ...overrides,
  };
}

//#endregion

//#region Removal of vanished worktree-source tasks

describe('reconcileTasksFs', () => {
  it('marks worktree-source tasks whose path is missing as removed', async () => {
    const ctx = makeStoreContext();
    const stale = makeTask({
      worktreePath: '/repo/.worktrees/gone',
    });
    const live = makeTask({
      worktreePath: '/repo/.worktrees/here',
    });
    await saveTask(ctx, stale);
    await saveTask(ctx, live);

    const result = await reconcileTasksFs(ctx, [
      makeWorktree({
        path: '/repo/.worktrees/here',
      }),
    ]);

    expect(result.markedRemoved).toHaveLength(1);
    expect(result.markedRemoved[0]?.id).toBe(stale.id);
    expect(result.markedRemoved[0]?.lifecycleStatus).toBe(TaskLifecycleStatus.Removed);

    // Persisted to disk.
    const reloadedStale = await loadTask(ctx, stale.id);
    expect(reloadedStale.lifecycleStatus).toBe(TaskLifecycleStatus.Removed);

    // Live task untouched.
    const reloadedLive = await loadTask(ctx, live.id);
    expect(reloadedLive.lifecycleStatus).toBe(TaskLifecycleStatus.Active);
  });

  it('is idempotent on re-run (no double-stamp)', async () => {
    const ctx = makeStoreContext();
    const stale = makeTask({
      worktreePath: '/repo/.worktrees/gone',
    });
    await saveTask(ctx, stale);

    // First pass: removes the stale task.
    const first = await reconcileTasksFs(ctx, []);
    expect(first.markedRemoved).toHaveLength(1);

    // Second pass: already removed → terminal → not stamped again.
    const second = await reconcileTasksFs(ctx, []);
    expect(second.markedRemoved).toHaveLength(0);
  });

  it('leaves tasks already in lifecycleStatus=removed untouched', async () => {
    const ctx = makeStoreContext();
    const removed = makeTask({
      worktreePath: '/repo/.worktrees/gone',
      lifecycleStatus: TaskLifecycleStatus.Removed,
      updatedAt: '2020-01-01T00:00:00.000Z',
    });
    await saveTask(ctx, removed);

    const result = await reconcileTasksFs(ctx, []);

    expect(result.markedRemoved).toHaveLength(0);
    const reloaded = await loadTask(ctx, removed.id);
    expect(reloaded.updatedAt).toBe('2020-01-01T00:00:00.000Z');
  });

  it('leaves merged tasks alone even when worktree disappears', async () => {
    const ctx = makeStoreContext();
    const merged = makeTask({
      worktreePath: '/repo/.worktrees/old',
      lifecycleStatus: TaskLifecycleStatus.Merged,
    });
    await saveTask(ctx, merged);

    const result = await reconcileTasksFs(ctx, []);

    expect(result.markedRemoved).toHaveLength(0);
    const reloaded = await loadTask(ctx, merged.id);
    expect(reloaded.lifecycleStatus).toBe(TaskLifecycleStatus.Merged);
  });

  it('leaves cleanup-blocked tasks alone (sticky terminal state)', async () => {
    const ctx = makeStoreContext();
    const blocked = makeTask({
      worktreePath: '/repo/.worktrees/dirty',
      lifecycleStatus: TaskLifecycleStatus.CleanupBlocked,
    });
    await saveTask(ctx, blocked);

    const result = await reconcileTasksFs(ctx, []);

    expect(result.markedRemoved).toHaveLength(0);
    const reloaded = await loadTask(ctx, blocked.id);
    expect(reloaded.lifecycleStatus).toBe(TaskLifecycleStatus.CleanupBlocked);
  });

  it('never touches manual-source tasks', async () => {
    const ctx = makeStoreContext();
    const manual = makeTask({
      source: TaskSource.Manual,
      worktreePath: null,
    });
    const manualWithGhostPath = makeTask({
      source: TaskSource.Manual,
      worktreePath: '/repo/.worktrees/ghost',
    });
    await saveTask(ctx, manual);
    await saveTask(ctx, manualWithGhostPath);

    const result = await reconcileTasksFs(ctx, []);

    expect(result.markedRemoved).toHaveLength(0);
    const m1 = await loadTask(ctx, manual.id);
    const m2 = await loadTask(ctx, manualWithGhostPath.id);
    expect(m1.lifecycleStatus).toBe(TaskLifecycleStatus.Active);
    expect(m2.lifecycleStatus).toBe(TaskLifecycleStatus.Active);
  });

  it('keeps a worktree-source task whose path is still in the list', async () => {
    const ctx = makeStoreContext();
    const live = makeTask({
      worktreePath: '/repo/.worktrees/here',
    });
    await saveTask(ctx, live);

    const result = await reconcileTasksFs(ctx, [
      makeWorktree({
        path: '/repo/.worktrees/here',
      }),
    ]);

    expect(result.markedRemoved).toHaveLength(0);
    const reloaded = await loadTask(ctx, live.id);
    expect(reloaded.lifecycleStatus).toBe(TaskLifecycleStatus.Active);
  });

  it('skips worktree-source tasks with a null worktreePath', async () => {
    const ctx = makeStoreContext();
    // Defensive: a worktree-source row that's missing its path. We can't
    // identify it against `git worktree list`, so leave it alone.
    const orphan = makeTask({
      source: TaskSource.Worktree,
      worktreePath: null,
    });
    await saveTask(ctx, orphan);

    const result = await reconcileTasksFs(ctx, []);

    expect(result.markedRemoved).toHaveLength(0);
    const reloaded = await loadTask(ctx, orphan.id);
    expect(reloaded.lifecycleStatus).toBe(TaskLifecycleStatus.Active);
  });

  it('returns an empty list when there are no tasks at all', async () => {
    const ctx = makeStoreContext();
    const result = await reconcileTasksFs(ctx, []);
    expect(result.markedRemoved).toEqual([]);
  });
});

//#endregion
