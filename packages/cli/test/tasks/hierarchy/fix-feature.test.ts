import { describe, expect, it } from 'bun:test';

import {
  BudgetExhaustedError,
  createGeneratedFixFeature,
  readFixLineage,
} from '../../../src/tasks/runtime/hierarchy/fix-feature.js';
import type { Feature } from '../../../src/tasks/runtime/hierarchy/schemas.js';
import {
  AssertionStatus,
  DEFAULT_IMPLEMENTATION_RETRY_BUDGET,
  FeatureLoopState,
  FeatureStatus,
  generateAssertionId,
  generateFeatureId,
  generateSliceId,
  generateValidatorRunId,
  ValidatorRunStatus,
} from '../../../src/tasks/runtime/hierarchy/schemas.js';
import { loadFeature, saveFeature } from '../../../src/tasks/runtime/hierarchy/store.js';
import { recordValidatorRun } from '../../../src/tasks/runtime/hierarchy/validator.js';
import { makeStoreContext } from '../_helpers.js';

const TASK_ID = 'T-abcdefghij';
const NOW = '2026-04-30T00:00:00.000Z';

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: generateFeatureId(),
    sliceId: generateSliceId(),
    title: 'feature A',
    description: 'desc',
    acceptanceCriteria: 'works',
    status: FeatureStatus.Defined,
    loopState: FeatureLoopState.Validating,
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

describe('createGeneratedFixFeature', () => {
  it('generates a fix feature, bumps source attempt count, and appends lineage', async () => {
    const ctx = makeStoreContext();
    const source = makeFeature();
    await saveFeature(ctx, TASK_ID, source);
    const run = await recordValidatorRun(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      {
        featureId: source.id,
        status: ValidatorRunStatus.Fail,
      },
    );

    const change = await createGeneratedFixFeature(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      {
        sourceFeatureId: source.id,
        validatorRunId: run.id,
      },
    );

    expect(change.fixFeature.title).toBe(`Fix: ${source.title}`);
    expect(change.fixFeature.generatedFromFeatureId).toBe(source.id);
    expect(change.fixFeature.generatedFromRunId).toBe(run.id);
    expect(change.fixFeature.acceptanceCriteria).toBe(source.acceptanceCriteria);
    expect(change.fixFeature.sliceId).toBe(source.sliceId);
    expect(change.fixFeature.implementationAttemptCount).toBe(0);
    expect(change.fixFeature.orderIndex).toBe(source.orderIndex + 1);
    expect(change.budgetRemaining).toBe(DEFAULT_IMPLEMENTATION_RETRY_BUDGET - 1);
    expect(change.sourcePreviousLoopState).toBe(FeatureLoopState.Validating);

    const reloadedSource = await loadFeature(ctx, TASK_ID, source.id);
    expect(reloadedSource?.loopState).toBe(FeatureLoopState.NeedsFix);
    expect(reloadedSource?.implementationAttemptCount).toBe(1);

    const lineage = await readFixLineage(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      source.id,
    );
    expect(lineage.length).toBe(1);
    expect(lineage[0]?.sourceFeatureId).toBe(source.id);
    expect(lineage[0]?.fixFeatureId).toBe(change.fixFeature.id);
    expect(lineage[0]?.validatorRunId).toBe(run.id);
  });

  it('plumbs failedAssertionIds from the validator run into the lineage and the change', async () => {
    const ctx = makeStoreContext();
    const source = makeFeature();
    await saveFeature(ctx, TASK_ID, source);
    const failedA = generateAssertionId();
    const failedB = generateAssertionId();
    const passedC = generateAssertionId();
    const run = await recordValidatorRun(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      {
        featureId: source.id,
        status: ValidatorRunStatus.Fail,
        assertionOutcomes: [
          {
            assertionId: failedA,
            status: AssertionStatus.Failed,
            message: 'broken on null input',
          },
          {
            assertionId: passedC,
            status: AssertionStatus.Passed,
          },
          {
            assertionId: failedB,
            status: AssertionStatus.Failed,
          },
        ],
      },
    );

    const change = await createGeneratedFixFeature(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      {
        sourceFeatureId: source.id,
        validatorRunId: run.id,
      },
    );

    expect(change.failedAssertionIds).toEqual([
      failedA,
      failedB,
    ]);

    const lineage = await readFixLineage(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      source.id,
    );
    expect(lineage.length).toBe(1);
    expect(lineage[0]?.failedAssertionIds).toEqual([
      failedA,
      failedB,
    ]);
  });

  it('throws BudgetExhaustedError once the source has hit its budget', async () => {
    const ctx = makeStoreContext();
    const source = makeFeature({
      implementationAttemptCount: DEFAULT_IMPLEMENTATION_RETRY_BUDGET,
    });
    await saveFeature(ctx, TASK_ID, source);
    const run = await recordValidatorRun(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      {
        featureId: source.id,
        status: ValidatorRunStatus.Fail,
      },
    );

    let caught: unknown;
    try {
      await createGeneratedFixFeature(
        {
          ...ctx,
          taskId: TASK_ID,
        },
        {
          sourceFeatureId: source.id,
          validatorRunId: run.id,
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BudgetExhaustedError);
    if (caught instanceof BudgetExhaustedError) {
      expect(caught.featureId).toBe(source.id);
      expect(caught.attemptCount).toBe(DEFAULT_IMPLEMENTATION_RETRY_BUDGET);
      expect(caught.budget).toBe(DEFAULT_IMPLEMENTATION_RETRY_BUDGET);
    }
  });

  it('reports budgetRemaining=0 on the final allowed attempt', async () => {
    const ctx = makeStoreContext();
    const source = makeFeature({
      implementationAttemptCount: DEFAULT_IMPLEMENTATION_RETRY_BUDGET - 1,
    });
    await saveFeature(ctx, TASK_ID, source);
    const run = await recordValidatorRun(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      {
        featureId: source.id,
        status: ValidatorRunStatus.Fail,
      },
    );

    const change = await createGeneratedFixFeature(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      {
        sourceFeatureId: source.id,
        validatorRunId: run.id,
      },
    );
    expect(change.budgetRemaining).toBe(0);
  });

  it('respects a custom budget override', async () => {
    const ctx = makeStoreContext();
    const source = makeFeature({
      implementationAttemptCount: 1,
    });
    await saveFeature(ctx, TASK_ID, source);
    const run = await recordValidatorRun(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      {
        featureId: source.id,
        status: ValidatorRunStatus.Fail,
      },
    );

    let caught: unknown;
    try {
      await createGeneratedFixFeature(
        {
          ...ctx,
          taskId: TASK_ID,
        },
        {
          sourceFeatureId: source.id,
          validatorRunId: run.id,
          budget: 1,
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BudgetExhaustedError);
  });

  it('throws when the source feature does not exist', async () => {
    const ctx = makeStoreContext();
    await expect(
      createGeneratedFixFeature(
        {
          ...ctx,
          taskId: TASK_ID,
        },
        {
          sourceFeatureId: generateFeatureId(),
          validatorRunId: generateValidatorRunId(),
        },
      ),
    ).rejects.toThrow(/Source feature .* not found/);
  });

  it('throws when the validator run does not exist', async () => {
    const ctx = makeStoreContext();
    const source = makeFeature();
    await saveFeature(ctx, TASK_ID, source);

    await expect(
      createGeneratedFixFeature(
        {
          ...ctx,
          taskId: TASK_ID,
        },
        {
          sourceFeatureId: source.id,
          validatorRunId: generateValidatorRunId(),
        },
      ),
    ).rejects.toThrow(/Validator run .* not found/);
  });

  it('appends multiple lineage rows across repeated fix generations', async () => {
    const ctx = makeStoreContext();
    const source = makeFeature();
    await saveFeature(ctx, TASK_ID, source);
    const run1 = await recordValidatorRun(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      {
        featureId: source.id,
        status: ValidatorRunStatus.Fail,
      },
    );
    await createGeneratedFixFeature(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      {
        sourceFeatureId: source.id,
        validatorRunId: run1.id,
      },
    );

    const run2 = await recordValidatorRun(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      {
        featureId: source.id,
        status: ValidatorRunStatus.Fail,
      },
    );
    await createGeneratedFixFeature(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      {
        sourceFeatureId: source.id,
        validatorRunId: run2.id,
      },
    );

    const lineage = await readFixLineage(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      source.id,
    );
    expect(lineage.length).toBe(2);
    expect(lineage.map((l) => l.validatorRunId)).toEqual([
      run1.id,
      run2.id,
    ]);
  });
});

describe('readFixLineage', () => {
  it('returns [] when no lineage file exists', async () => {
    const ctx = makeStoreContext();
    const lineage = await readFixLineage(
      {
        ...ctx,
        taskId: TASK_ID,
      },
      generateFeatureId(),
    );
    expect(lineage).toEqual([]);
  });
});
