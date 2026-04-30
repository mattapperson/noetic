import { describe, expect, it } from 'bun:test';

import { tailEvents } from '../../../src/commands/builtins/tasks/fs-store.js';
import { createTaskHandler } from '../../../src/commands/builtins/tasks/handlers/create.js';
import { moveTaskHandler } from '../../../src/commands/builtins/tasks/handlers/move.js';
import { KanbanColumn } from '../../../src/commands/builtins/tasks/kanban.js';
import { EventKind, TaskReviewStatus } from '../../../src/commands/builtins/tasks/schemas.js';
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
});
