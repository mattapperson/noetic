import { describe, expect, it } from 'bun:test';
import { EventKind } from '@noetic-tools/code-agent/tasks/schema';
import { loadTask, tailEvents } from '@noetic-tools/code-agent/tasks/store/fs-node';
import {
  archiveTaskHandler,
  createTaskHandler,
} from '../../../src/tasks/runtime/handlers/lifecycle.js';
import { makeStoreContext } from '../_helpers.js';

describe('archiveTaskHandler', () => {
  it('stamps archivedAt and emits a TaskArchived event', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Archive me',
    });
    const result = await archiveTaskHandler(ctx, {
      taskId: created.task.id,
    });
    expect(result.task.archivedAt).not.toBeNull();
    const reloaded = await loadTask(ctx, created.task.id);
    expect(reloaded.archivedAt).toBe(result.task.archivedAt);

    const events = await tailEvents(ctx);
    expect(events.some((e) => e.kind === EventKind.TaskArchived)).toBe(true);
  });

  it('preserves the existing archivedAt when re-archiving', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Already archived',
    });
    const first = await archiveTaskHandler(ctx, {
      taskId: created.task.id,
    });
    const second = await archiveTaskHandler(ctx, {
      taskId: created.task.id,
    });
    expect(second.task.archivedAt).toBe(first.task.archivedAt);
  });

  it('throws on missing task', async () => {
    const ctx = makeStoreContext();
    await expect(
      archiveTaskHandler(ctx, {
        taskId: 'T-zzzzzzzzzz',
      }),
    ).rejects.toThrow();
  });
});
