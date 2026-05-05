import { describe, expect, it } from 'bun:test';
import { TaskLifecycleStatus, TaskReviewStatus, TaskSource } from '@noetic/code-agent/tasks/schema';
import { loadTask, taskDirPaths } from '@noetic/code-agent/tasks/store/fs-node';
import {
  createTaskHandler,
  duplicateTaskHandler,
} from '../../../src/commands/builtins/tasks/handlers/lifecycle.js';
import { attachTaskHandler } from '../../../src/commands/builtins/tasks/handlers/state.js';
import { MemFs, makeStoreContext } from '../_helpers.js';

describe('duplicateTaskHandler', () => {
  it('clones description + attachments and resets lifecycle', async () => {
    const ctx = makeStoreContext();
    const original = await createTaskHandler(ctx, {
      title: 'Original',
      description: 'first description',
    });

    const sourceFs = new MemFs([
      '/external',
    ]);
    await sourceFs.writeFile('/external/file.txt', 'attached payload');
    await attachTaskHandler(ctx, {
      taskId: original.task.id,
      sourcePath: '/external/file.txt',
      sourceFs,
    });

    const result = await duplicateTaskHandler(ctx, {
      taskId: original.task.id,
    });

    expect(result.task.id).not.toBe(original.task.id);
    expect(result.task.source).toBe(TaskSource.Manual);
    expect(result.task.title).toBe('Original (copy)');
    expect(result.task.reviewStatus).toBe(TaskReviewStatus.NotStarted);
    expect(result.task.lifecycleStatus).toBe(TaskLifecycleStatus.Active);

    const reloaded = await loadTask(ctx, result.task.id);
    expect(reloaded.id).toBe(result.task.id);

    const newPaths = taskDirPaths(ctx, result.task.id);
    const desc = await ctx.fs.readFileText(newPaths.description);
    expect(desc).toBe('first description');
    const attachments = await ctx.fs.readdir(newPaths.attachments);
    expect(attachments).toEqual([
      'file.txt',
    ]);
  });

  it('honours an explicit title override', async () => {
    const ctx = makeStoreContext();
    const original = await createTaskHandler(ctx, {
      title: 'Has title',
    });
    const result = await duplicateTaskHandler(ctx, {
      taskId: original.task.id,
      title: 'Renamed clone',
    });
    expect(result.task.title).toBe('Renamed clone');
  });

  it('throws on missing task', async () => {
    const ctx = makeStoreContext();
    await expect(
      duplicateTaskHandler(ctx, {
        taskId: 'T-zzzzzzzzzz',
      }),
    ).rejects.toThrow();
  });
});
