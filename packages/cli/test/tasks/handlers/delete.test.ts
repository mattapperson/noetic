import { describe, expect, it } from 'bun:test';

import {
  listTasks,
  tailEvents,
  tryLoadTask,
} from '../../../src/commands/builtins/tasks/fs-store.js';
import { createTaskHandler } from '../../../src/commands/builtins/tasks/handlers/create.js';
import { deleteTaskHandler } from '../../../src/commands/builtins/tasks/handlers/delete.js';
import { EventKind } from '../../../src/commands/builtins/tasks/schemas.js';
import { makeStoreContext } from '../_helpers.js';

describe('deleteTaskHandler', () => {
  it('emits TaskDeleted (not TaskArchived) and removes the task directory', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Delete me',
    });
    const result = await deleteTaskHandler(ctx, {
      taskId: created.task.id,
    });
    expect(result.taskId).toBe(created.task.id);
    expect(await tryLoadTask(ctx, created.task.id)).toBeNull();
    expect(await listTasks(ctx)).toEqual([]);

    const events = await tailEvents(ctx);
    const deleted = events.filter((e) => e.kind === EventKind.TaskDeleted);
    expect(deleted.length).toBe(1);
    expect(deleted[0]?.payload?.reason).toBe('deleted');
    // Hard-delete must NOT masquerade as archive — listeners watching
    // `task:archived` need to be able to distinguish.
    const archived = events.filter((e) => e.kind === EventKind.TaskArchived);
    expect(archived.length).toBe(0);
  });

  it('throws on missing task', async () => {
    const ctx = makeStoreContext();
    await expect(
      deleteTaskHandler(ctx, {
        taskId: 'T-zzzzzzzzzz',
      }),
    ).rejects.toThrow();
  });
});
