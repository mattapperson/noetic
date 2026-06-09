import { describe, expect, it } from 'bun:test';

import { listTasks, saveTask } from '@noetic-tools/code-agent/tasks/store/fs-node';
import {
  activateSliceHandler,
  addFeatureHandler,
  addMilestoneHandler,
  addSliceHandler,
} from '../../../src/tasks/runtime/handlers/hierarchy.js';
import { createTaskHandler } from '../../../src/tasks/runtime/handlers/lifecycle.js';
import { FeatureLoopState, SliceStatus } from '../../../src/tasks/runtime/hierarchy/schemas.js';
import { listFeatures, loadSlice } from '../../../src/tasks/runtime/hierarchy/store.js';
import { makeStoreContext } from '../_helpers.js';

async function seedHierarchy(
  ctx: ReturnType<typeof makeStoreContext>,
  taskId: string,
): Promise<{
  milestoneId: string;
  sliceId: string;
}> {
  const m = await addMilestoneHandler(ctx, {
    taskId,
    title: 'M',
    verification: 'v',
  });
  const s = await addSliceHandler(ctx, {
    taskId,
    milestoneId: m.milestone.id,
    title: 'S',
    verification: 'v',
  });
  await addFeatureHandler(ctx, {
    taskId,
    sliceId: s.slice.id,
    title: 'F',
    acceptanceCriteria: 'ac',
  });
  return {
    milestoneId: m.milestone.id,
    sliceId: s.slice.id,
  };
}

describe('activateSliceHandler', () => {
  it('flips slice to active without triage when autopilot is off', async () => {
    const ctx = makeStoreContext();
    const task = await createTaskHandler(ctx, {
      title: 'No autopilot',
    });
    await saveTask(ctx, {
      ...task.task,
      autopilotEnabled: false,
    });
    const { sliceId } = await seedHierarchy(ctx, task.task.id);
    const result = await activateSliceHandler(ctx, {
      taskId: task.task.id,
      sliceId,
    });
    expect(result.outcome.didTriage).toBe(false);
    expect(result.outcome.slice.status).toBe(SliceStatus.Active);

    const reloaded = await loadSlice(ctx, task.task.id, sliceId);
    expect(reloaded?.status).toBe(SliceStatus.Active);

    // No new placeholder leaf tasks were spawned.
    const all = await listTasks(ctx);
    expect(all.length).toBe(1);
  });

  it('triages every un-linked feature when autopilot is enabled', async () => {
    const ctx = makeStoreContext();
    const task = await createTaskHandler(ctx, {
      title: 'Autopilot',
    });
    const { sliceId } = await seedHierarchy(ctx, task.task.id);
    const result = await activateSliceHandler(ctx, {
      taskId: task.task.id,
      sliceId,
    });
    expect(result.outcome.didTriage).toBe(true);
    expect(result.outcome.triaged.created.length).toBe(1);

    const features = await listFeatures(ctx, task.task.id);
    expect(features[0]?.loopState).toBe(FeatureLoopState.Implementing);

    const all = await listTasks(ctx);
    expect(all.length).toBe(2);
  });

  it('throws when the slice does not exist', async () => {
    const ctx = makeStoreContext();
    const task = await createTaskHandler(ctx, {
      title: 'X',
    });
    await expect(
      activateSliceHandler(ctx, {
        taskId: task.task.id,
        sliceId: 'SL-zzzzzzzzzz',
      }),
    ).rejects.toThrow();
  });
});
