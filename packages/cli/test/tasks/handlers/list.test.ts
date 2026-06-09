import { describe, expect, it } from 'bun:test';
import {
  AutopilotState,
  generateTaskId,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '@noetic-tools/code-agent/tasks/schema';
import { saveTask } from '@noetic-tools/code-agent/tasks/store/fs-node';
import { listTasksHandler } from '../../../src/tasks/runtime/handlers/inspection.js';
import { createTaskHandler } from '../../../src/tasks/runtime/handlers/lifecycle.js';
import { KanbanColumn } from '../../../src/tasks/runtime/kanban.js';
import { makeStoreContext } from '../_helpers.js';

describe('listTasksHandler', () => {
  it('hides archived tasks by default and includes them when all=true', async () => {
    const ctx = makeStoreContext();
    const live = await createTaskHandler(ctx, {
      title: 'Live one',
    });
    const archived = await createTaskHandler(ctx, {
      title: 'Archived one',
    });
    await saveTask(ctx, {
      ...archived.task,
      archivedAt: '2026-04-30T00:00:00.000Z',
    });
    const onlyLive = await listTasksHandler(ctx, {});
    expect(onlyLive.tasks.map((t) => t.id)).toEqual([
      live.task.id,
    ]);
    const everything = await listTasksHandler(ctx, {
      all: true,
    });
    expect(everything.tasks.length).toBe(2);
  });

  it('hides terminal columns (removed, cleanup_blocked, archived) by default', async () => {
    const ctx = makeStoreContext();
    const triage = await createTaskHandler(ctx, {
      title: 'Triage',
    });
    const done = await createTaskHandler(ctx, {
      title: 'Done',
    });
    await saveTask(ctx, {
      ...done.task,
      lifecycleStatus: TaskLifecycleStatus.Merged,
    });
    const removed = await createTaskHandler(ctx, {
      title: 'Removed',
    });
    await saveTask(ctx, {
      ...removed.task,
      lifecycleStatus: TaskLifecycleStatus.Removed,
    });
    const cleanup = await createTaskHandler(ctx, {
      title: 'Cleanup',
    });
    await saveTask(ctx, {
      ...cleanup.task,
      lifecycleStatus: TaskLifecycleStatus.CleanupBlocked,
    });
    const archived = await createTaskHandler(ctx, {
      title: 'Archived',
    });
    await saveTask(ctx, {
      ...archived.task,
      archivedAt: '2026-04-30T00:00:00.000Z',
    });
    const result = await listTasksHandler(ctx, {});
    const ids = result.tasks.map((t) => t.id).sort();
    // Default view keeps Triage + Done; hides Removed, CleanupBlocked, Archived.
    expect(ids).toEqual(
      [
        triage.task.id,
        done.task.id,
      ].sort(),
    );
  });

  it('--terminal reveals Removed and CleanupBlocked but keeps Archived hidden', async () => {
    const ctx = makeStoreContext();
    const triage = await createTaskHandler(ctx, {
      title: 'Triage',
    });
    const removed = await createTaskHandler(ctx, {
      title: 'Removed',
    });
    await saveTask(ctx, {
      ...removed.task,
      lifecycleStatus: TaskLifecycleStatus.Removed,
    });
    const archived = await createTaskHandler(ctx, {
      title: 'Archived',
    });
    await saveTask(ctx, {
      ...archived.task,
      archivedAt: '2026-04-30T00:00:00.000Z',
    });
    const result = await listTasksHandler(ctx, {
      terminal: true,
    });
    const ids = result.tasks.map((t) => t.id).sort();
    expect(ids).toEqual(
      [
        triage.task.id,
        removed.task.id,
      ].sort(),
    );
    // Archived stays hidden under --terminal alone; --all is required.
    const everything = await listTasksHandler(ctx, {
      all: true,
    });
    expect(everything.tasks.map((t) => t.id).sort()).toEqual(
      [
        triage.task.id,
        removed.task.id,
        archived.task.id,
      ].sort(),
    );
  });

  it('explicit --column Archived reveals an archived task without --all', async () => {
    const ctx = makeStoreContext();
    const archived = await createTaskHandler(ctx, {
      title: 'Archived',
    });
    await saveTask(ctx, {
      ...archived.task,
      archivedAt: '2026-04-30T00:00:00.000Z',
    });
    const result = await listTasksHandler(ctx, {
      column: KanbanColumn.Archived,
    });
    expect(result.tasks.map((t) => t.id)).toEqual([
      archived.task.id,
    ]);
  });

  it('explicit --column on a normally-hidden column overrides the terminal hide', async () => {
    const ctx = makeStoreContext();
    const removed = await createTaskHandler(ctx, {
      title: 'Removed',
    });
    await saveTask(ctx, {
      ...removed.task,
      lifecycleStatus: TaskLifecycleStatus.Removed,
    });
    const result = await listTasksHandler(ctx, {
      column: KanbanColumn.Removed,
    });
    expect(result.tasks.map((t) => t.id)).toEqual([
      removed.task.id,
    ]);
  });

  it('filters by source', async () => {
    const ctx = makeStoreContext();
    await createTaskHandler(ctx, {
      title: 'Manual',
    });
    const now = '2026-04-30T00:00:00.000Z';
    await saveTask(ctx, {
      id: generateTaskId(),
      source: TaskSource.Worktree,
      title: 'Worktree',
      projectRoot: ctx.projectRoot,
      worktreePath: '/tmp/wt',
      branch: 'feature',
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
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    });
    const result = await listTasksHandler(ctx, {
      source: TaskSource.Worktree,
    });
    expect(result.tasks.map((t) => t.title)).toEqual([
      'Worktree',
    ]);
  });

  it('filters by column', async () => {
    const ctx = makeStoreContext();
    const triage = await createTaskHandler(ctx, {
      title: 'Triage one',
    });
    const reviewing = await createTaskHandler(ctx, {
      title: 'Reviewing one',
    });
    await saveTask(ctx, {
      ...reviewing.task,
      reviewStatus: TaskReviewStatus.Reviewing,
    });
    const tri = await listTasksHandler(ctx, {
      column: KanbanColumn.Triage,
    });
    expect(tri.tasks.map((t) => t.id)).toEqual([
      triage.task.id,
    ]);
  });

  it('returns an empty list when no tasks exist', async () => {
    const ctx = makeStoreContext();
    const result = await listTasksHandler(ctx, {});
    expect(result.tasks).toEqual([]);
  });
});
