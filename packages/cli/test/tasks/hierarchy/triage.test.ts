import { describe, expect, it } from 'bun:test';

import { listTasks, loadTask } from '@noetic/code-agent/tasks/store/fs-node';
import type {
  Feature,
  Milestone,
  Slice,
} from '../../../src/commands/builtins/tasks/hierarchy/schemas.js';
import {
  FeatureLoopState,
  FeatureStatus,
  generateFeatureId,
  generateMilestoneId,
  generateSliceId,
  MilestoneStatus,
  SliceStatus,
} from '../../../src/commands/builtins/tasks/hierarchy/schemas.js';
import {
  loadFeature,
  saveFeature,
  saveMilestone,
  saveSlice,
} from '../../../src/commands/builtins/tasks/hierarchy/store.js';
import {
  triageFeature,
  triageSlice,
} from '../../../src/commands/builtins/tasks/hierarchy/triage.js';
import { TaskLifecycleStatus, TaskSource } from '@noetic/code-agent/tasks/schema';
import { makeStoreContext } from '../_helpers.js';

const PARENT_TASK_ID = 'T-abcdefghij';
const NOW = '2026-04-30T00:00:00.000Z';

function makeMilestone(): Milestone {
  return {
    id: generateMilestoneId(),
    taskId: PARENT_TASK_ID,
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

describe('triageSlice', () => {
  it('creates a leaf task for every un-linked feature in the slice', async () => {
    const ctx = makeStoreContext();
    const m = makeMilestone();
    const s = makeSlice(m.id);
    const f1 = makeFeature(s.id, {
      orderIndex: 0,
    });
    const f2 = makeFeature(s.id, {
      orderIndex: 1,
    });
    await saveMilestone(ctx, PARENT_TASK_ID, m);
    await saveSlice(ctx, PARENT_TASK_ID, s);
    await saveFeature(ctx, PARENT_TASK_ID, f1);
    await saveFeature(ctx, PARENT_TASK_ID, f2);

    const result = await triageSlice(
      {
        ...ctx,
        parentTaskId: PARENT_TASK_ID,
      },
      s.id,
    );

    expect(result.created.length).toBe(2);
    for (const task of result.created) {
      expect(task.source).toBe(TaskSource.Worktree);
      expect(task.lifecycleStatus).toBe(TaskLifecycleStatus.Active);
      expect(task.worktreePath).toBeNull();
    }

    // Each feature now has taskId pointing at its leaf task; loopState=Implementing.
    const r1 = await loadFeature(ctx, PARENT_TASK_ID, f1.id);
    const r2 = await loadFeature(ctx, PARENT_TASK_ID, f2.id);
    expect(r1?.taskId).toBe(result.summaries[0]?.task.id ?? null);
    expect(r2?.taskId).toBe(result.summaries[1]?.task.id ?? null);
    expect(r1?.loopState).toBe(FeatureLoopState.Implementing);
    expect(r2?.loopState).toBe(FeatureLoopState.Implementing);
    expect(r1?.status).toBe(FeatureStatus.Triaged);
    // Idle → Implementing transitions bump implementationAttemptCount.
    expect(r1?.implementationAttemptCount).toBe(1);
  });

  it('skips features already linked to a leaf task', async () => {
    const ctx = makeStoreContext();
    const m = makeMilestone();
    const s = makeSlice(m.id);
    const linked = makeFeature(s.id, {
      taskId: 'T-existing00',
    });
    const unlinked = makeFeature(s.id, {
      orderIndex: 1,
    });
    await saveMilestone(ctx, PARENT_TASK_ID, m);
    await saveSlice(ctx, PARENT_TASK_ID, s);
    await saveFeature(ctx, PARENT_TASK_ID, linked);
    await saveFeature(ctx, PARENT_TASK_ID, unlinked);

    const result = await triageSlice(
      {
        ...ctx,
        parentTaskId: PARENT_TASK_ID,
      },
      s.id,
    );

    expect(result.created.length).toBe(1);
    expect(result.summaries[0]?.featureId).toBe(unlinked.id);
  });

  it('does not bump implementationAttemptCount when re-triaging from non-idle state', async () => {
    const ctx = makeStoreContext();
    const m = makeMilestone();
    const s = makeSlice(m.id);
    const f = makeFeature(s.id, {
      loopState: FeatureLoopState.NeedsFix,
      implementationAttemptCount: 2,
    });
    await saveMilestone(ctx, PARENT_TASK_ID, m);
    await saveSlice(ctx, PARENT_TASK_ID, s);
    await saveFeature(ctx, PARENT_TASK_ID, f);

    await triageSlice(
      {
        ...ctx,
        parentTaskId: PARENT_TASK_ID,
      },
      s.id,
    );

    const reloaded = await loadFeature(ctx, PARENT_TASK_ID, f.id);
    // Stayed at 2 because previous loopState wasn't idle.
    expect(reloaded?.implementationAttemptCount).toBe(2);
  });

  it('throws when the slice does not exist', async () => {
    const ctx = makeStoreContext();
    await expect(
      triageSlice(
        {
          ...ctx,
          parentTaskId: PARENT_TASK_ID,
        },
        generateSliceId(),
      ),
    ).rejects.toThrow(/not found/);
  });

  it('persists every leaf task into the FS store', async () => {
    const ctx = makeStoreContext();
    const m = makeMilestone();
    const s = makeSlice(m.id);
    await saveMilestone(ctx, PARENT_TASK_ID, m);
    await saveSlice(ctx, PARENT_TASK_ID, s);
    await saveFeature(ctx, PARENT_TASK_ID, makeFeature(s.id));

    const result = await triageSlice(
      {
        ...ctx,
        parentTaskId: PARENT_TASK_ID,
      },
      s.id,
    );
    const leafId = result.created[0]?.id;
    if (leafId === undefined) {
      throw new Error('no leaf created');
    }
    const reloadedTask = await loadTask(ctx, leafId);
    expect(reloadedTask.id).toBe(leafId);

    const all = await listTasks(ctx);
    expect(all.length).toBe(1);
  });
});

describe('triageFeature', () => {
  it('creates a single leaf task for the feature', async () => {
    const ctx = makeStoreContext();
    const m = makeMilestone();
    const s = makeSlice(m.id);
    const f = makeFeature(s.id);
    await saveMilestone(ctx, PARENT_TASK_ID, m);
    await saveSlice(ctx, PARENT_TASK_ID, s);
    await saveFeature(ctx, PARENT_TASK_ID, f);

    const summary = await triageFeature(
      {
        ...ctx,
        parentTaskId: PARENT_TASK_ID,
      },
      f.id,
    );
    expect(summary.task.title).toBe(f.title);
    expect(summary.previousLoopState).toBe(FeatureLoopState.Idle);
  });

  it('rejects re-triage of a feature already linked to a task', async () => {
    const ctx = makeStoreContext();
    const m = makeMilestone();
    const s = makeSlice(m.id);
    const f = makeFeature(s.id, {
      taskId: 'T-existing00',
    });
    await saveMilestone(ctx, PARENT_TASK_ID, m);
    await saveSlice(ctx, PARENT_TASK_ID, s);
    await saveFeature(ctx, PARENT_TASK_ID, f);

    await expect(
      triageFeature(
        {
          ...ctx,
          parentTaskId: PARENT_TASK_ID,
        },
        f.id,
      ),
    ).rejects.toThrow(/already linked/);
  });
});
