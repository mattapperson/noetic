import { describe, expect, it } from 'bun:test';

import { saveTask } from '../../../src/commands/builtins/tasks/fs-store.js';
import { createTaskHandler } from '../../../src/commands/builtins/tasks/handlers/create.js';
import { listTasksHandler } from '../../../src/commands/builtins/tasks/handlers/list.js';
import { KanbanColumn } from '../../../src/commands/builtins/tasks/kanban.js';
import {
  AutopilotState,
  generateTaskId,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '../../../src/commands/builtins/tasks/schemas.js';
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
