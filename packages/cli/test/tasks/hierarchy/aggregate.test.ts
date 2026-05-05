import { describe, expect, it } from 'bun:test';

import { getTaskHierarchy } from '../../../src/commands/builtins/tasks/hierarchy/aggregate.js';
import { hierarchyPaths } from '../../../src/commands/builtins/tasks/hierarchy/paths.js';
import type {
  Assertion,
  Feature,
  Milestone,
  Slice,
} from '../../../src/commands/builtins/tasks/hierarchy/schemas.js';
import {
  AssertionStatus,
  FeatureLoopState,
  FeatureStatus,
  generateAssertionId,
  generateFeatureId,
  generateMilestoneId,
  generateSliceId,
  MilestoneStatus,
  SliceStatus,
  ValidatorRunStatus,
} from '../../../src/commands/builtins/tasks/hierarchy/schemas.js';
import {
  saveAssertion,
  saveFeature,
  saveMilestone,
  saveSlice,
} from '../../../src/commands/builtins/tasks/hierarchy/store.js';
import { recordValidatorRun } from '../../../src/commands/builtins/tasks/hierarchy/validator.js';
import { makeStoreContext } from '../_helpers.js';

const TASK_ID = 'T-abcdefghij';
const NOW = '2026-04-30T00:00:00.000Z';

function makeMilestone(overrides: Partial<Milestone> = {}): Milestone {
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
    ...overrides,
  };
}

function makeSlice(milestoneId: string, overrides: Partial<Slice> = {}): Slice {
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
    ...overrides,
  };
}

function makeFeature(sliceId: string, overrides: Partial<Feature> = {}): Feature {
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
    ...overrides,
  };
}

function makeAssertion(milestoneId: string, overrides: Partial<Assertion> = {}): Assertion {
  return {
    id: generateAssertionId(),
    milestoneId,
    title: 'a',
    assertion: 'all green',
    status: AssertionStatus.Pending,
    orderIndex: 0,
    featureIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('getTaskHierarchy', () => {
  it('returns null when the task has no hierarchy/ subdir', async () => {
    const ctx = makeStoreContext();
    expect(await getTaskHierarchy(ctx, TASK_ID)).toBeNull();
  });

  it('returns an empty hierarchy when the subdir exists but is empty', async () => {
    const ctx = makeStoreContext();
    await ctx.fs.mkdir(hierarchyPaths(ctx, TASK_ID).root);

    const tree = await getTaskHierarchy(ctx, TASK_ID);
    expect(tree).toEqual({
      taskId: TASK_ID,
      milestones: [],
    });
  });

  it('joins milestones / slices / features / assertions / runs in order', async () => {
    const ctx = makeStoreContext();
    const m1 = makeMilestone({
      orderIndex: 0,
      title: 'first',
    });
    const m2 = makeMilestone({
      orderIndex: 1,
      title: 'second',
    });
    await saveMilestone(ctx, TASK_ID, m1);
    await saveMilestone(ctx, TASK_ID, m2);

    const s1a = makeSlice(m1.id, {
      orderIndex: 0,
      title: 's1',
    });
    const s1b = makeSlice(m1.id, {
      orderIndex: 1,
      title: 's2',
    });
    const s2 = makeSlice(m2.id, {
      orderIndex: 0,
      title: 's3',
    });
    await saveSlice(ctx, TASK_ID, s1a);
    await saveSlice(ctx, TASK_ID, s1b);
    await saveSlice(ctx, TASK_ID, s2);

    const f1 = makeFeature(s1a.id, {
      orderIndex: 0,
    });
    const f2 = makeFeature(s1a.id, {
      orderIndex: 1,
    });
    const f3 = makeFeature(s2.id, {
      orderIndex: 0,
    });
    await saveFeature(ctx, TASK_ID, f1);
    await saveFeature(ctx, TASK_ID, f2);
    await saveFeature(ctx, TASK_ID, f3);

    // A validator run on f1 — should attach.
    await recordValidatorRun(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      {
        featureId: f1.id,
        status: ValidatorRunStatus.Pass,
      },
    );

    const a1 = makeAssertion(m1.id, {
      orderIndex: 0,
      featureIds: [
        f1.id,
      ],
    });
    await saveAssertion(ctx, TASK_ID, a1);

    const tree = await getTaskHierarchy(ctx, TASK_ID);
    expect(tree).not.toBeNull();
    if (tree === null) {
      throw new Error('unreachable');
    }

    // Milestones in order
    expect(tree.milestones.map((m) => m.id)).toEqual([
      m1.id,
      m2.id,
    ]);

    // Slices under m1 in order, m2 has its own
    const m1Slices = tree.milestones[0]?.slices ?? [];
    expect(m1Slices.map((s) => s.id)).toEqual([
      s1a.id,
      s1b.id,
    ]);
    const m2Slices = tree.milestones[1]?.slices ?? [];
    expect(m2Slices.map((s) => s.id)).toEqual([
      s2.id,
    ]);

    // Features under s1a in order
    const s1aFeatures = m1Slices[0]?.features ?? [];
    expect(s1aFeatures.map((f) => f.id)).toEqual([
      f1.id,
      f2.id,
    ]);
    expect(s1aFeatures[0]?.validatorRuns.length).toBe(1);
    expect(s1aFeatures[1]?.validatorRuns).toEqual([]);

    // Assertions under m1
    expect(tree.milestones[0]?.assertions.map((a) => a.id)).toEqual([
      a1.id,
    ]);
    expect(tree.milestones[1]?.assertions).toEqual([]);
  });

  it('drops orphan slices/features/assertions whose owner is missing', async () => {
    const ctx = makeStoreContext();
    const m = makeMilestone();
    await saveMilestone(ctx, TASK_ID, m);
    // A slice referring to a milestone we never saved.
    const orphanMilestoneId = generateMilestoneId();
    await saveSlice(ctx, TASK_ID, makeSlice(orphanMilestoneId));

    const tree = await getTaskHierarchy(ctx, TASK_ID);
    expect(tree?.milestones.length).toBe(1);
    expect(tree?.milestones[0]?.slices).toEqual([]);
  });
});
