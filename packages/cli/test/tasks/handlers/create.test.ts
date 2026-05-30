import { describe, expect, it } from 'bun:test';
import { TaskSource } from '@noetic-tools/code-agent/tasks/schema';
import { listTasks, loadTask, taskDirPaths } from '@noetic-tools/code-agent/tasks/store/fs-node';
import { createTaskHandler } from '../../../src/tasks/runtime/handlers/lifecycle.js';
import { makeStoreContext } from '../_helpers.js';

describe('createTaskHandler', () => {
  it('persists a manual task and seeds description.md when supplied', async () => {
    const ctx = makeStoreContext();
    const result = await createTaskHandler(ctx, {
      title: 'Build kanban column move action',
      description: 'Move tasks between columns with a single keypress.',
    });
    expect(result.task.source).toBe(TaskSource.Manual);
    expect(result.task.title).toBe('Build kanban column move action');
    expect(result.task.archivedAt).toBeNull();

    const reloaded = await loadTask(ctx, result.task.id);
    expect(reloaded.id).toBe(result.task.id);

    const paths = taskDirPaths(ctx, result.task.id);
    const desc = await ctx.fs.readFileText(paths.description);
    expect(desc).toContain('Move tasks between columns');
  });

  it('skips description.md when no description is provided', async () => {
    const ctx = makeStoreContext();
    const result = await createTaskHandler(ctx, {
      title: 'No description task',
    });
    const paths = taskDirPaths(ctx, result.task.id);
    await expect(ctx.fs.readFileText(paths.description)).rejects.toThrow();
  });

  it('appears in listTasks after creation', async () => {
    const ctx = makeStoreContext();
    await createTaskHandler(ctx, {
      title: 'Listed task',
    });
    const tasks = await listTasks(ctx);
    expect(tasks.length).toBe(1);
  });

  it('rejects empty titles', async () => {
    const ctx = makeStoreContext();
    await expect(
      createTaskHandler(ctx, {
        title: '   ',
      }),
    ).rejects.toThrow(/title/);
  });
});
