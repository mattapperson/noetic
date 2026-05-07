import { describe, expect, it } from 'bun:test';

import { activateSlice } from '../../../src/tasks/runtime/hierarchy/activation.js';
import type { Feature, Milestone, Slice } from '../../../src/tasks/runtime/hierarchy/schemas.js';
import {
  FeatureLoopState,
  FeatureStatus,
  generateFeatureId,
  generateMilestoneId,
  generateSliceId,
  MilestoneStatus,
  SliceStatus,
} from '../../../src/tasks/runtime/hierarchy/schemas.js';
import {
  loadFeature,
  loadSlice,
  saveFeature,
  saveMilestone,
  saveSlice,
} from '../../../src/tasks/runtime/hierarchy/store.js';
import { makeStoreContext } from '../_helpers.js';

const TASK_ID = 'T-abcdefghij';
const NOW = '2026-04-30T00:00:00.000Z';

function makeMilestone(): Milestone {
  return {
    id: generateMilestoneId(),
    taskId: TASK_ID,
    title: 'm',
    description: null,
    verification: 'v',
    status: MilestoneStatus.Pending,
    orderIndex: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeSlice(milestoneId: string): Slice {
  return {
    id: generateSliceId(),
    milestoneId,
    title: 's',
    description: null,
    verification: 'v',
    status: SliceStatus.Pending,
    orderIndex: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeFeature(sliceId: string): Feature {
  return {
    id: generateFeatureId(),
    sliceId,
    title: 'f',
    description: null,
    acceptanceCriteria: 'a',
    status: FeatureStatus.Defined,
    loopState: FeatureLoopState.Idle,
    implementationAttemptCount: 0,
    validatorAttemptCount: 0,
    taskId: null,
    generatedFromFeatureId: null,
    generatedFromRunId: null,
    blockedReason: null,
    orderIndex: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('activateSlice', () => {
  it('marks the slice active without triaging by default', async () => {
    const ctx = makeStoreContext();
    const m = makeMilestone();
    const s = makeSlice(m.id);
    const f = makeFeature(s.id);
    await saveMilestone(ctx, TASK_ID, m);
    await saveSlice(ctx, TASK_ID, s);
    await saveFeature(ctx, TASK_ID, f);

    const result = await activateSlice(ctx, {
      parentTaskId: TASK_ID,
      sliceId: s.id,
    });

    expect(result.didTriage).toBe(false);
    expect(result.slice.status).toBe(SliceStatus.Active);
    expect(result.triaged.created).toEqual([]);

    const reloaded = await loadSlice(ctx, TASK_ID, s.id);
    expect(reloaded?.status).toBe(SliceStatus.Active);

    // Feature was not triaged
    const f1 = await loadFeature(ctx, TASK_ID, f.id);
    expect(f1?.taskId).toBeNull();
    expect(f1?.loopState).toBe(FeatureLoopState.Idle);
  });

  it('triages every un-linked feature when triage: true', async () => {
    const ctx = makeStoreContext();
    const m = makeMilestone();
    const s = makeSlice(m.id);
    const f = makeFeature(s.id);
    await saveMilestone(ctx, TASK_ID, m);
    await saveSlice(ctx, TASK_ID, s);
    await saveFeature(ctx, TASK_ID, f);

    const result = await activateSlice(ctx, {
      parentTaskId: TASK_ID,
      sliceId: s.id,
      triage: true,
    });

    expect(result.didTriage).toBe(true);
    expect(result.triaged.created.length).toBe(1);
    expect(result.slice.status).toBe(SliceStatus.Active);

    const f1 = await loadFeature(ctx, TASK_ID, f.id);
    expect(f1?.taskId).toBe(result.triaged.created[0]?.id ?? null);
    expect(f1?.loopState).toBe(FeatureLoopState.Implementing);
  });

  it('throws when the slice does not exist', async () => {
    const ctx = makeStoreContext();
    await expect(
      activateSlice(ctx, {
        parentTaskId: TASK_ID,
        sliceId: generateSliceId(),
      }),
    ).rejects.toThrow(/not found/);
  });
});
