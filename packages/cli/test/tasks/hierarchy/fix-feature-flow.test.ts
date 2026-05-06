import { describe, expect, it } from 'bun:test';

import { AgentHarness, isNoeticError } from '@noetic/core';

import {
  BudgetExhaustedError,
  fixFeatureFlow,
  readFixLineage,
} from '../../../src/tasks/runtime/hierarchy/fix-feature.js';
import type { Feature } from '../../../src/tasks/runtime/hierarchy/schemas.js';
import {
  DEFAULT_IMPLEMENTATION_RETRY_BUDGET,
  FeatureLoopState,
  FeatureStatus,
  generateFeatureId,
  generateSliceId,
  ValidatorRunStatus,
} from '../../../src/tasks/runtime/hierarchy/schemas.js';
import { loadFeature, saveFeature } from '../../../src/tasks/runtime/hierarchy/store.js';
import { recordValidatorRun } from '../../../src/tasks/runtime/hierarchy/validator.js';
import { makeStoreContext } from '../_helpers.js';

const TASK_ID = 'T-abcdefghij';
const NOW = '2026-04-30T00:00:00.000Z';

//#region Helpers

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

/**
 * Build a fresh in-memory harness rooted on the given store fs adapter so
 * the flow can drive `harness.run(fixFeatureFlow, ...)` without leaving
 * MemFs.
 */
function makeHarness(fs: ReturnType<typeof makeStoreContext>['fs']): AgentHarness {
  return new AgentHarness({
    name: 'fix-feature-flow-test',
    params: {},
    fs,
  });
}

/**
 * The harness wraps step throws in `NoeticError` (kind `step_failed`) at
 * every nesting level — so a flow with two nested `harness.run` calls
 * surfaces a doubly-wrapped error. Walk down `noeticError.cause` until we
 * reach a non-Noetic error and return it.
 */
function unwrapNoeticError(err: unknown): unknown {
  let current = err;
  while (isNoeticError(current)) {
    if (current.noeticError.kind !== 'step_failed') {
      return current;
    }
    current = current.noeticError.cause;
  }
  return current;
}

//#endregion

describe('fixFeatureFlow', () => {
  it('non-exhausted path: writes the fix feature, bumps source attempt count, appends lineage', async () => {
    const store = makeStoreContext();
    const ctx = {
      ...store,
      taskId: TASK_ID,
    };
    const source = makeFeature();
    await saveFeature(ctx, TASK_ID, source);
    const run = await recordValidatorRun(ctx, {
      featureId: source.id,
      status: ValidatorRunStatus.Fail,
    });
    const harness = makeHarness(store.fs);
    const childCtx = harness.createContext();

    const change = await harness.run(
      fixFeatureFlow,
      {
        ctx,
        sourceFeatureId: source.id,
        validatorRunId: run.id,
      },
      childCtx,
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

    const lineage = await readFixLineage(ctx, source.id);
    expect(lineage).toHaveLength(1);
    expect(lineage[0]?.sourceFeatureId).toBe(source.id);
    expect(lineage[0]?.fixFeatureId).toBe(change.fixFeature.id);
    expect(lineage[0]?.validatorRunId).toBe(run.id);
  });

  it('exhausted path: throws BudgetExhaustedError without mutating the source feature', async () => {
    const store = makeStoreContext();
    const ctx = {
      ...store,
      taskId: TASK_ID,
    };
    const source = makeFeature({
      implementationAttemptCount: DEFAULT_IMPLEMENTATION_RETRY_BUDGET,
    });
    await saveFeature(ctx, TASK_ID, source);
    const run = await recordValidatorRun(ctx, {
      featureId: source.id,
      status: ValidatorRunStatus.Fail,
    });
    const harness = makeHarness(store.fs);
    const childCtx = harness.createContext();

    let caught: unknown;
    try {
      await harness.run(
        fixFeatureFlow,
        {
          ctx,
          sourceFeatureId: source.id,
          validatorRunId: run.id,
        },
        childCtx,
      );
    } catch (err) {
      caught = err;
    }
    const inner = unwrapNoeticError(caught);
    expect(inner).toBeInstanceOf(BudgetExhaustedError);
    if (inner instanceof BudgetExhaustedError) {
      expect(inner.featureId).toBe(source.id);
      expect(inner.attemptCount).toBe(DEFAULT_IMPLEMENTATION_RETRY_BUDGET);
      expect(inner.budget).toBe(DEFAULT_IMPLEMENTATION_RETRY_BUDGET);
    }

    // The flow step intentionally does NOT mutate the source feature on
    // budget exhaustion — the caller (validator-job's catch handler) owns
    // the markFeatureBlocked side effect so the corresponding
    // feature:loopStateChanged event is emitted alongside the budget
    // verdict. The source feature should be unchanged from its seed.
    const reloaded = await loadFeature(ctx, TASK_ID, source.id);
    expect(reloaded?.loopState).toBe(FeatureLoopState.Validating);
    expect(reloaded?.implementationAttemptCount).toBe(DEFAULT_IMPLEMENTATION_RETRY_BUDGET);
  });

  it('respects a custom budget override at the boundary', async () => {
    const store = makeStoreContext();
    const ctx = {
      ...store,
      taskId: TASK_ID,
    };
    const source = makeFeature({
      implementationAttemptCount: 1,
    });
    await saveFeature(ctx, TASK_ID, source);
    const run = await recordValidatorRun(ctx, {
      featureId: source.id,
      status: ValidatorRunStatus.Fail,
    });
    const harness = makeHarness(store.fs);
    const childCtx = harness.createContext();

    let caught: unknown;
    try {
      await harness.run(
        fixFeatureFlow,
        {
          ctx,
          sourceFeatureId: source.id,
          validatorRunId: run.id,
          budget: 1,
        },
        childCtx,
      );
    } catch (err) {
      caught = err;
    }
    expect(unwrapNoeticError(caught)).toBeInstanceOf(BudgetExhaustedError);
  });

  it('throws when the source feature does not exist', async () => {
    const store = makeStoreContext();
    const ctx = {
      ...store,
      taskId: TASK_ID,
    };
    const harness = makeHarness(store.fs);
    const childCtx = harness.createContext();

    let caught: unknown;
    try {
      await harness.run(
        fixFeatureFlow,
        {
          ctx,
          sourceFeatureId: generateFeatureId(),
          validatorRunId: 'vr-aaaaaaaaaa',
        },
        childCtx,
      );
    } catch (err) {
      caught = err;
    }
    const inner = unwrapNoeticError(caught);
    expect(inner).toBeInstanceOf(Error);
    if (inner instanceof Error) {
      expect(inner.message).toMatch(/Source feature .* not found/);
    }
  });
});
