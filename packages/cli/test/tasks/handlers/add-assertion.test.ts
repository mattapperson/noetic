import { describe, expect, it } from 'bun:test';
import {
  addAssertionHandler,
  addMilestoneHandler,
} from '../../../src/tasks/runtime/handlers/hierarchy.js';
import { createTaskHandler } from '../../../src/tasks/runtime/handlers/lifecycle.js';
import { AssertionStatus } from '../../../src/tasks/runtime/hierarchy/schemas.js';
import { listAssertions } from '../../../src/tasks/runtime/hierarchy/store.js';
import { makeStoreContext } from '../_helpers.js';

describe('addAssertionHandler', () => {
  it('persists an assertion under an existing milestone', async () => {
    const ctx = makeStoreContext();
    const task = await createTaskHandler(ctx, {
      title: 'Plan',
    });
    const m = await addMilestoneHandler(ctx, {
      taskId: task.task.id,
      title: 'M',
      verification: 'v',
    });
    const a = await addAssertionHandler(ctx, {
      taskId: task.task.id,
      milestoneId: m.milestone.id,
      title: 'A1',
      assertion: 'expected behaviour holds',
    });
    expect(a.assertion.status).toBe(AssertionStatus.Pending);

    const all = await listAssertions(ctx, task.task.id);
    expect(all.length).toBe(1);
  });

  it('throws when the milestone is missing', async () => {
    const ctx = makeStoreContext();
    const task = await createTaskHandler(ctx, {
      title: 'X',
    });
    await expect(
      addAssertionHandler(ctx, {
        taskId: task.task.id,
        milestoneId: 'ML-zzzzzzzzzz',
        title: 'A',
        assertion: 'a',
      }),
    ).rejects.toThrow(/Milestone/);
  });
});
