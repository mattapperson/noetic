import { describe, expect, it } from 'bun:test';

import { getTaskHierarchy } from '../../../src/tasks/runtime/hierarchy/aggregate.js';
import {
  linkFeatureToTask,
  persistTaskHierarchy,
} from '../../../src/tasks/runtime/hierarchy/persist.js';
import type { TaskHierarchyInput } from '../../../src/tasks/runtime/hierarchy/schemas.js';
import {
  AssertionStatus,
  FeatureLoopState,
  FeatureStatus,
  MilestoneStatus,
  SliceStatus,
} from '../../../src/tasks/runtime/hierarchy/schemas.js';
import { loadFeature } from '../../../src/tasks/runtime/hierarchy/store.js';
import { makeStoreContext } from '../_helpers.js';

const TASK_ID = 'T-abcdefghij';

const SAMPLE: TaskHierarchyInput = {
  milestones: [
    {
      title: 'milestone 1',
      description: 'top level',
      verification: 'tests pass',
      slices: [
        {
          title: 'slice 1',
          description: null,
          verification: 'unit tests',
          features: [
            {
              title: 'feature A',
              acceptanceCriteria: 'returns 200',
            },
            {
              title: 'feature B',
              acceptanceCriteria: 'returns json',
            },
          ],
        },
        {
          title: 'slice 2',
          description: null,
          verification: 'integration tests',
          features: [
            {
              title: 'feature C',
              acceptanceCriteria: 'persists',
            },
          ],
        },
      ],
      assertions: [
        {
          title: 'A and C green',
          assertion: 'features 0 and 2 pass',
          // 0 = feature A; 2 = feature C (slice-2 feature 0, milestone-relative idx 2)
          featureIndices: [
            0,
            2,
          ],
        },
      ],
    },
  ],
};

describe('persistTaskHierarchy', () => {
  it('persists milestones, slices, features, and assertions in default state', async () => {
    const ctx = makeStoreContext();
    const result = await persistTaskHierarchy(ctx, TASK_ID, SAMPLE);

    expect(result.milestones.length).toBe(1);
    expect(result.slices.length).toBe(2);
    expect(result.features.length).toBe(3);
    expect(result.assertions.length).toBe(1);

    for (const m of result.milestones) {
      expect(m.status).toBe(MilestoneStatus.Pending);
      expect(m.taskId).toBe(TASK_ID);
    }
    for (const s of result.slices) {
      expect(s.status).toBe(SliceStatus.Pending);
    }
    for (const f of result.features) {
      expect(f.status).toBe(FeatureStatus.Defined);
      expect(f.loopState).toBe(FeatureLoopState.Idle);
      expect(f.implementationAttemptCount).toBe(0);
      expect(f.validatorAttemptCount).toBe(0);
      expect(f.taskId).toBeNull();
    }
    for (const a of result.assertions) {
      expect(a.status).toBe(AssertionStatus.Pending);
    }
  });

  it('preserves slice / feature / milestone order via orderIndex', async () => {
    const ctx = makeStoreContext();
    await persistTaskHierarchy(ctx, TASK_ID, SAMPLE);

    const tree = await getTaskHierarchy(ctx, TASK_ID);
    expect(tree).not.toBeNull();
    const slices = tree?.milestones[0]?.slices ?? [];
    expect(slices.map((s) => s.title)).toEqual([
      'slice 1',
      'slice 2',
    ]);
    const slice0Features = slices[0]?.features ?? [];
    expect(slice0Features.map((f) => f.title)).toEqual([
      'feature A',
      'feature B',
    ]);
  });

  it('resolves assertion featureIndices into feature ids (milestone-relative)', async () => {
    const ctx = makeStoreContext();
    const result = await persistTaskHierarchy(ctx, TASK_ID, SAMPLE);

    // feature index 0 = feature A; index 2 = feature C
    const featureA = result.features.find((f) => f.title === 'feature A');
    const featureC = result.features.find((f) => f.title === 'feature C');
    expect(featureA).toBeDefined();
    expect(featureC).toBeDefined();
    if (featureA === undefined || featureC === undefined) {
      return;
    }

    const assertion = result.assertions[0];
    expect(assertion?.featureIds).toEqual([
      featureA.id,
      featureC.id,
    ]);
  });

  it('drops out-of-range featureIndices silently', async () => {
    const ctx = makeStoreContext();
    const tree: TaskHierarchyInput = {
      milestones: [
        {
          title: 'm',
          verification: 'v',
          slices: [
            {
              title: 's',
              verification: 'v',
              features: [
                {
                  title: 'f',
                  acceptanceCriteria: 'a',
                },
              ],
            },
          ],
          assertions: [
            {
              title: 'bad',
              assertion: 'never resolves',
              featureIndices: [
                42,
              ],
            },
          ],
        },
      ],
    };
    const result = await persistTaskHierarchy(ctx, TASK_ID, tree);
    expect(result.assertions[0]?.featureIds).toEqual([]);
  });
});

describe('linkFeatureToTask', () => {
  it('records the leaf task id on the feature', async () => {
    const ctx = makeStoreContext();
    const result = await persistTaskHierarchy(ctx, TASK_ID, SAMPLE);
    const featureA = result.features[0];
    if (featureA === undefined) {
      throw new Error('feature missing');
    }

    const linked = await linkFeatureToTask(ctx, {
      parentTaskId: TASK_ID,
      featureId: featureA.id,
      leafTaskId: 'T-leaf000001',
    });

    expect(linked.taskId).toBe('T-leaf000001');
    const reloaded = await loadFeature(ctx, TASK_ID, featureA.id);
    expect(reloaded?.taskId).toBe('T-leaf000001');
  });

  it('throws when the feature does not exist', async () => {
    const ctx = makeStoreContext();
    await expect(
      linkFeatureToTask(ctx, {
        parentTaskId: TASK_ID,
        featureId: 'F-doesnotexis',
        leafTaskId: 'T-leaf000001',
      }),
    ).rejects.toThrow(/not found/);
  });
});
