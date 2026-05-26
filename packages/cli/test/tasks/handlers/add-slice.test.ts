import { describe, expect, it } from 'bun:test';
import {
  addMilestoneHandler,
  addSliceHandler,
} from '../../../src/tasks/runtime/handlers/hierarchy.js';
import { createTaskHandler } from '../../../src/tasks/runtime/handlers/lifecycle.js';
import { listSlices } from '../../../src/tasks/runtime/hierarchy/store.js';
import { makeStoreContext } from '../_helpers.js';

describe('addSliceHandler', () => {
  it('persists a slice under an existing milestone', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Plan',
    });
    const milestone = await addMilestoneHandler(ctx, {
      taskId: created.task.id,
      title: 'M',
      verification: 'v',
    });
    const slice = await addSliceHandler(ctx, {
      taskId: created.task.id,
      milestoneId: milestone.milestone.id,
      title: 'S1',
      verification: 'v',
    });
    expect(slice.slice.milestoneId).toBe(milestone.milestone.id);

    const all = await listSlices(ctx, created.task.id);
    expect(all.length).toBe(1);
  });

  it('throws when the milestone is missing', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'X',
    });
    await expect(
      addSliceHandler(ctx, {
        taskId: created.task.id,
        milestoneId: 'ML-zzzzzzzzzz',
        title: 'S',
        verification: 'v',
      }),
    ).rejects.toThrow(/Milestone/);
  });
});
