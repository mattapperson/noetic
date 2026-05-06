import { describe, expect, it } from 'bun:test';

import { addMilestoneHandler } from '../../../src/tasks/runtime/handlers/hierarchy.js';
import { createTaskHandler } from '../../../src/tasks/runtime/handlers/lifecycle.js';
import { listMilestones } from '../../../src/tasks/runtime/hierarchy/store.js';
import { makeStoreContext } from '../_helpers.js';

describe('addMilestoneHandler', () => {
  it('persists a milestone and assigns sequential orderIndex', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Plan target',
    });
    const first = await addMilestoneHandler(ctx, {
      taskId: created.task.id,
      title: 'Milestone 1',
      verification: 'tests pass',
    });
    const second = await addMilestoneHandler(ctx, {
      taskId: created.task.id,
      title: 'Milestone 2',
      verification: 'tests pass',
    });
    expect(first.milestone.orderIndex).toBe(0);
    expect(second.milestone.orderIndex).toBe(1);

    const ms = await listMilestones(ctx, created.task.id);
    expect(ms.length).toBe(2);
  });

  it('rejects empty title', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'X',
    });
    await expect(
      addMilestoneHandler(ctx, {
        taskId: created.task.id,
        title: '   ',
        verification: 'v',
      }),
    ).rejects.toThrow(/empty/);
  });

  it('throws on missing task', async () => {
    const ctx = makeStoreContext();
    await expect(
      addMilestoneHandler(ctx, {
        taskId: 'T-zzzzzzzzzz',
        title: 'M',
        verification: 'v',
      }),
    ).rejects.toThrow();
  });
});
