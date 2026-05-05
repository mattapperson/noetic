import { describe, expect, it } from 'bun:test';

import { loadTask } from '@noetic/code-agent/tasks/store/fs-node';
import { archiveTaskHandler } from '../../../src/commands/builtins/tasks/handlers/archive.js';
import { createTaskHandler } from '../../../src/commands/builtins/tasks/handlers/create.js';
import { unarchiveTaskHandler } from '../../../src/commands/builtins/tasks/handlers/unarchive.js';
import { makeStoreContext } from '../_helpers.js';

describe('unarchiveTaskHandler', () => {
  it('clears archivedAt', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Unarchive me',
    });
    await archiveTaskHandler(ctx, {
      taskId: created.task.id,
    });
    const result = await unarchiveTaskHandler(ctx, {
      taskId: created.task.id,
    });
    expect(result.task.archivedAt).toBeNull();
    const reloaded = await loadTask(ctx, created.task.id);
    expect(reloaded.archivedAt).toBeNull();
  });

  it('throws on missing task', async () => {
    const ctx = makeStoreContext();
    await expect(
      unarchiveTaskHandler(ctx, {
        taskId: 'T-zzzzzzzzzz',
      }),
    ).rejects.toThrow();
  });
});
