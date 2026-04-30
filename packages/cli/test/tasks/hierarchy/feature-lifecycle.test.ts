import { describe, expect, it } from 'bun:test';

import {
  applyFeatureLoopStateUpdate,
  markFeatureBlocked,
  markFeaturePassed,
} from '../../../src/commands/builtins/tasks/hierarchy/feature-lifecycle.js';
import type { Feature } from '../../../src/commands/builtins/tasks/hierarchy/schemas.js';
import {
  FeatureLoopState,
  FeatureStatus,
  generateFeatureId,
  generateSliceId,
} from '../../../src/commands/builtins/tasks/hierarchy/schemas.js';
import { loadFeature, saveFeature } from '../../../src/commands/builtins/tasks/hierarchy/store.js';
import { makeStoreContext } from '../_helpers.js';

const TASK_ID = 'T-abcdefghij';
const NOW = '2026-04-30T00:00:00.000Z';

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: generateFeatureId(),
    sliceId: generateSliceId(),
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

describe('applyFeatureLoopStateUpdate', () => {
  it('changes loop state and emits a `changed` payload', async () => {
    const ctx = makeStoreContext();
    const f = makeFeature();
    await saveFeature(ctx, TASK_ID, f);

    const result = await applyFeatureLoopStateUpdate(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      {
        featureId: f.id,
        newLoopState: FeatureLoopState.Implementing,
      },
    );

    expect(result.changed?.previousLoopState).toBe(FeatureLoopState.Idle);
    expect(result.changed?.loopState).toBe(FeatureLoopState.Implementing);
    const reloaded = await loadFeature(ctx, TASK_ID, f.id);
    expect(reloaded?.loopState).toBe(FeatureLoopState.Implementing);
  });

  it('returns null `changed` when state did not actually change', async () => {
    const ctx = makeStoreContext();
    const f = makeFeature({
      loopState: FeatureLoopState.Validating,
    });
    await saveFeature(ctx, TASK_ID, f);

    const result = await applyFeatureLoopStateUpdate(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      {
        featureId: f.id,
        newLoopState: FeatureLoopState.Validating,
      },
    );
    expect(result.changed).toBeNull();
  });

  it('throws when the feature does not exist', async () => {
    const ctx = makeStoreContext();
    await expect(
      applyFeatureLoopStateUpdate(
        {
          ...ctx,
          taskId: TASK_ID,
        },
        {
          featureId: generateFeatureId(),
          newLoopState: FeatureLoopState.Implementing,
        },
      ),
    ).rejects.toThrow(/not found/);
  });
});

describe('markFeaturePassed', () => {
  it('sets loopState=passed AND status=done', async () => {
    const ctx = makeStoreContext();
    const f = makeFeature({
      loopState: FeatureLoopState.Validating,
      status: FeatureStatus.Triaged,
    });
    await saveFeature(ctx, TASK_ID, f);

    const change = await markFeaturePassed(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      f.id,
    );

    expect(change?.loopState).toBe(FeatureLoopState.Passed);
    const reloaded = await loadFeature(ctx, TASK_ID, f.id);
    expect(reloaded?.loopState).toBe(FeatureLoopState.Passed);
    expect(reloaded?.status).toBe(FeatureStatus.Done);
  });
});

describe('markFeatureBlocked', () => {
  it('sets loopState=blocked, status=blocked, and persists the reason', async () => {
    const ctx = makeStoreContext();
    const f = makeFeature();
    await saveFeature(ctx, TASK_ID, f);

    const change = await markFeatureBlocked(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      f.id,
      'budget exhausted',
    );

    expect(change?.loopState).toBe(FeatureLoopState.Blocked);
    const reloaded = await loadFeature(ctx, TASK_ID, f.id);
    expect(reloaded?.loopState).toBe(FeatureLoopState.Blocked);
    expect(reloaded?.status).toBe(FeatureStatus.Blocked);
    expect(reloaded?.blockedReason).toBe('budget exhausted');
  });

  it('clears the previous blockedReason when called without one', async () => {
    const ctx = makeStoreContext();
    const f = makeFeature({
      blockedReason: 'older',
    });
    await saveFeature(ctx, TASK_ID, f);

    await markFeatureBlocked(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      f.id,
    );
    const reloaded = await loadFeature(ctx, TASK_ID, f.id);
    expect(reloaded?.blockedReason).toBeNull();
  });
});
