import { describe, expect, it } from 'bun:test';

import { addFeatureHandler } from '../../../src/commands/builtins/tasks/handlers/add-feature.js';
import { addMilestoneHandler } from '../../../src/commands/builtins/tasks/handlers/add-milestone.js';
import { addSliceHandler } from '../../../src/commands/builtins/tasks/handlers/add-slice.js';
import { createTaskHandler } from '../../../src/commands/builtins/tasks/handlers/create.js';
import {
  FeatureLoopState,
  FeatureStatus,
} from '../../../src/commands/builtins/tasks/hierarchy/schemas.js';
import { listFeatures } from '../../../src/commands/builtins/tasks/hierarchy/store.js';
import { makeStoreContext } from '../_helpers.js';

describe('addFeatureHandler', () => {
  it('persists a feature in defined/idle state', async () => {
    const ctx = makeStoreContext();
    const task = await createTaskHandler(ctx, {
      title: 'Plan',
    });
    const m = await addMilestoneHandler(ctx, {
      taskId: task.task.id,
      title: 'M',
      verification: 'v',
    });
    const s = await addSliceHandler(ctx, {
      taskId: task.task.id,
      milestoneId: m.milestone.id,
      title: 'S',
      verification: 'v',
    });
    const f = await addFeatureHandler(ctx, {
      taskId: task.task.id,
      sliceId: s.slice.id,
      title: 'F',
      acceptanceCriteria: 'when foo, then bar',
    });
    expect(f.feature.status).toBe(FeatureStatus.Defined);
    expect(f.feature.loopState).toBe(FeatureLoopState.Idle);

    const all = await listFeatures(ctx, task.task.id);
    expect(all.length).toBe(1);
  });

  it('throws when the slice is missing', async () => {
    const ctx = makeStoreContext();
    const task = await createTaskHandler(ctx, {
      title: 'X',
    });
    await expect(
      addFeatureHandler(ctx, {
        taskId: task.task.id,
        sliceId: 'SL-zzzzzzzzzz',
        title: 'F',
        acceptanceCriteria: 'a',
      }),
    ).rejects.toThrow(/Slice/);
  });
});
