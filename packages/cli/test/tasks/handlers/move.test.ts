import { describe, expect, it } from 'bun:test';
import { EventKind, TaskReviewStatus } from '@noetic-tools/code-agent/tasks/schema';
import { tailEvents } from '@noetic-tools/code-agent/tasks/store/fs-node';
import { createTaskHandler } from '../../../src/tasks/runtime/handlers/lifecycle.js';
import { moveTaskHandler } from '../../../src/tasks/runtime/handlers/state.js';
import { KanbanColumn } from '../../../src/tasks/runtime/kanban.js';
import { makeStoreContext } from '../_helpers.js';

describe('moveTaskHandler', () => {
  it('moves a triage task into in-progress and emits a moved event', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Move me',
    });
    const result = await moveTaskHandler(ctx, {
      taskId: created.task.id,
      column: KanbanColumn.InProgress,
    });
    expect(result.column).toBe(KanbanColumn.InProgress);
    expect(result.previousColumn).toBe(KanbanColumn.Triage);
    expect(result.task.reviewStatus).toBe(TaskReviewStatus.Reviewing);

    const events = await tailEvents(ctx);
    const moveEvents = events.filter((e) => e.kind === EventKind.TaskMoved);
    expect(moveEvents.length).toBe(1);
    expect(moveEvents[0]?.payload?.column).toBe(KanbanColumn.InProgress);
  });

  it('throws on missing task', async () => {
    const ctx = makeStoreContext();
    await expect(
      moveTaskHandler(ctx, {
        taskId: 'T-zzzzzzzzzz',
        column: KanbanColumn.InProgress,
      }),
    ).rejects.toThrow();
  });

  it('refuses to move into reconciler-owned columns without --force', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Sanity',
    });
    await expect(
      moveTaskHandler(ctx, {
        taskId: created.task.id,
        column: KanbanColumn.Removed,
      }),
    ).rejects.toThrow(/reconciler-owned/);
    await expect(
      moveTaskHandler(ctx, {
        taskId: created.task.id,
        column: KanbanColumn.CleanupBlocked,
      }),
    ).rejects.toThrow(/reconciler-owned/);
  });

  it('allows force move into a reconciler-owned column', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Forced',
    });
    const result = await moveTaskHandler(ctx, {
      taskId: created.task.id,
      column: KanbanColumn.Removed,
      force: true,
    });
    expect(result.column).toBe(KanbanColumn.Removed);
  });

  it('allows moving OUT of a reconciler-owned column without --force', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Recover',
    });
    await moveTaskHandler(ctx, {
      taskId: created.task.id,
      column: KanbanColumn.Removed,
      force: true,
    });
    const result = await moveTaskHandler(ctx, {
      taskId: created.task.id,
      column: KanbanColumn.InProgress,
    });
    expect(result.column).toBe(KanbanColumn.InProgress);
  });
});
