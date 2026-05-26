import { describe, expect, it } from 'bun:test';
import type { Feature } from '../../../src/tasks/runtime/hierarchy/schemas.js';
import {
  FeatureLoopState,
  FeatureStatus,
  generateFeatureId,
  generateSliceId,
  generateValidatorRunId,
  ValidatorRunStatus,
} from '../../../src/tasks/runtime/hierarchy/schemas.js';
import { loadFeature, saveFeature } from '../../../src/tasks/runtime/hierarchy/store.js';
import {
  listValidatorRuns,
  loadValidatorRun,
  recordValidatorRun,
  updateValidatorRun,
} from '../../../src/tasks/runtime/hierarchy/validator.js';
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

describe('recordValidatorRun', () => {
  it('persists a pending run and bumps validatorAttemptCount', async () => {
    const ctx = makeStoreContext();
    const f = makeFeature();
    await saveFeature(ctx, TASK_ID, f);

    const run = await recordValidatorRun(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      {
        featureId: f.id,
        status: ValidatorRunStatus.Pending,
      },
    );

    expect(run.status).toBe(ValidatorRunStatus.Pending);
    expect(run.completedAt).toBeNull();
    const reloaded = await loadFeature(ctx, TASK_ID, f.id);
    expect(reloaded?.validatorAttemptCount).toBe(1);
  });

  it('sets completedAt when started terminal', async () => {
    const ctx = makeStoreContext();
    const f = makeFeature();
    await saveFeature(ctx, TASK_ID, f);

    const run = await recordValidatorRun(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      {
        featureId: f.id,
        status: ValidatorRunStatus.Pass,
        result: {
          tests: 5,
        },
      },
    );

    expect(run.completedAt).not.toBeNull();
    expect(run.result).toEqual({
      tests: 5,
    });
  });

  it('throws when feature does not exist', async () => {
    const ctx = makeStoreContext();
    await expect(
      recordValidatorRun(
        {
          ...ctx,
          taskId: TASK_ID,
        },
        {
          featureId: generateFeatureId(),
          status: ValidatorRunStatus.Pending,
        },
      ),
    ).rejects.toThrow(/not found/);
  });
});

describe('updateValidatorRun', () => {
  it('transitions pending → running → pass and stamps completedAt on terminal', async () => {
    const ctx = makeStoreContext();
    const f = makeFeature();
    await saveFeature(ctx, TASK_ID, f);
    const created = await recordValidatorRun(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      {
        featureId: f.id,
        status: ValidatorRunStatus.Pending,
      },
    );

    await updateValidatorRun(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      {
        featureId: f.id,
        runId: created.id,
        patch: {
          status: ValidatorRunStatus.Running,
          pid: 4242,
        },
      },
    );

    const final = await updateValidatorRun(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      {
        featureId: f.id,
        runId: created.id,
        patch: {
          status: ValidatorRunStatus.Pass,
          result: {
            ok: true,
          },
        },
      },
    );

    expect(final.status).toBe(ValidatorRunStatus.Pass);
    expect(final.completedAt).not.toBeNull();
    expect(final.pid).toBe(4242);
    expect(final.result).toEqual({
      ok: true,
    });
    // ID and lineage preserved
    expect(final.id).toBe(created.id);
    expect(final.featureId).toBe(f.id);
    expect(final.startedAt).toBe(created.startedAt);
  });

  it('throws when run does not exist', async () => {
    const ctx = makeStoreContext();
    const f = makeFeature();
    await saveFeature(ctx, TASK_ID, f);

    await expect(
      updateValidatorRun(
        {
          ...ctx,
          taskId: TASK_ID,
        },
        {
          featureId: f.id,
          runId: generateValidatorRunId(),
          patch: {
            status: ValidatorRunStatus.Pass,
          },
        },
      ),
    ).rejects.toThrow(/not found/);
  });
});

describe('listValidatorRuns', () => {
  it('returns runs sorted by startedAt asc', async () => {
    const ctx = makeStoreContext();
    const f = makeFeature();
    await saveFeature(ctx, TASK_ID, f);

    await recordValidatorRun(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      {
        featureId: f.id,
        status: ValidatorRunStatus.Fail,
        startedAt: '2026-04-30T00:00:01.000Z',
      },
    );
    await recordValidatorRun(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      {
        featureId: f.id,
        status: ValidatorRunStatus.Pass,
        startedAt: '2026-04-30T00:00:00.000Z',
      },
    );

    const runs = await listValidatorRuns(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      f.id,
    );
    expect(runs.length).toBe(2);
    expect(runs[0]?.startedAt).toBe('2026-04-30T00:00:00.000Z');
    expect(runs[1]?.startedAt).toBe('2026-04-30T00:00:01.000Z');
    // Both runs bumped the counter:
    const reloaded = await loadFeature(ctx, TASK_ID, f.id);
    expect(reloaded?.validatorAttemptCount).toBe(2);
  });

  it('returns [] when validator-runs/ does not exist', async () => {
    const ctx = makeStoreContext();
    const f = makeFeature();
    await saveFeature(ctx, TASK_ID, f);
    expect(
      await listValidatorRuns(
        {
          ...ctx,
          taskId: TASK_ID,
        },
        f.id,
      ),
    ).toEqual([]);
  });
});

describe('loadValidatorRun', () => {
  it('returns null for malformed run ids', async () => {
    const ctx = makeStoreContext();
    const f = makeFeature();
    await saveFeature(ctx, TASK_ID, f);
    expect(
      await loadValidatorRun(
        {
          ...ctx,
          taskId: TASK_ID,
        },
        f.id,
        'not-an-id',
      ),
    ).toBeNull();
  });
});
