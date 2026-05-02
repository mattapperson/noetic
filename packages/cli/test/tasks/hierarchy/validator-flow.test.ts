import { describe, expect, it } from 'bun:test';

import { AgentHarness } from '@noetic/core';

import type { Signaller } from '../../../src/commands/builtins/tasks/agent-ci-control.js';
import {
  featureLoopStateChan,
  validatorRequestChan,
} from '../../../src/commands/builtins/tasks/channels.js';
import { loadState, saveTask, tailEvents } from '../../../src/commands/builtins/tasks/fs-store.js';
import { activateSlice } from '../../../src/commands/builtins/tasks/hierarchy/activation.js';
import { applyFeatureLoopStateUpdate } from '../../../src/commands/builtins/tasks/hierarchy/feature-lifecycle.js';
import { persistTaskHierarchy } from '../../../src/commands/builtins/tasks/hierarchy/persist.js';
import {
  FeatureLoopState,
  FeatureStatus,
  ValidatorRunStatus,
} from '../../../src/commands/builtins/tasks/hierarchy/schemas.js';
import { loadFeature, saveFeature } from '../../../src/commands/builtins/tasks/hierarchy/store.js';
import { listValidatorRuns } from '../../../src/commands/builtins/tasks/hierarchy/validator.js';
import type { ValidatorFlowDeps } from '../../../src/commands/builtins/tasks/hierarchy/validator-flow.js';
import {
  buildValidatorEvery,
  buildValidatorIterationStep,
} from '../../../src/commands/builtins/tasks/hierarchy/validator-flow.js';
import type { RunValidatorFn } from '../../../src/commands/builtins/tasks/hierarchy/validator-job.js';
import type { Event } from '../../../src/commands/builtins/tasks/schemas.js';
import {
  AutopilotState,
  EventKind,
  HierarchyStatus,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '../../../src/commands/builtins/tasks/schemas.js';
import type { MemFs } from '../_helpers.js';
import { makeStoreContext } from '../_helpers.js';

const NOW = '2026-04-30T00:00:00.000Z';

interface SeededTask {
  readonly fs: MemFs;
  readonly projectRoot: string;
  readonly taskId: string;
  readonly featureId: string;
  readonly leafTaskId: string;
}

//#region Helpers

function staticSignaller(): Signaller {
  return {
    kill: () => {
      // unused
    },
    isAlive: () => false,
    startTime: () => null,
  };
}

async function seedStructuredTask(parentTaskId: string): Promise<SeededTask> {
  const ctx = makeStoreContext();
  await saveTask(ctx, {
    id: parentTaskId,
    source: TaskSource.Manual,
    title: 'Parent',
    projectRoot: ctx.projectRoot,
    worktreePath: null,
    branch: null,
    headSha: null,
    reviewStatus: TaskReviewStatus.NotStarted,
    lifecycleStatus: TaskLifecycleStatus.Active,
    paused: false,
    pauseReason: null,
    archivedAt: null,
    hierarchyStatus: HierarchyStatus.Active,
    autopilotEnabled: false,
    autopilotState: AutopilotState.Inactive,
    lastAutopilotActivityAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
  });
  const persisted = await persistTaskHierarchy(ctx, parentTaskId, {
    milestones: [
      {
        title: 'M',
        verification: 'v',
        slices: [
          {
            title: 'S',
            verification: 's',
            features: [
              {
                title: 'F',
                acceptanceCriteria: 'a',
              },
            ],
          },
        ],
        assertions: [],
      },
    ],
  });
  const slice = persisted.slices[0];
  const feature = persisted.features[0];
  if (slice === undefined || feature === undefined) {
    throw new Error('persistTaskHierarchy produced no slice/feature');
  }
  const activation = await activateSlice(ctx, {
    parentTaskId,
    sliceId: slice.id,
    triage: true,
  });
  const leafTaskId = activation.triaged.created[0]?.id;
  if (leafTaskId === undefined) {
    throw new Error('triage produced no leaf task');
  }
  await applyFeatureLoopStateUpdate(
    {
      ...ctx,
      taskId: parentTaskId,
    },
    {
      featureId: feature.id,
      newLoopState: FeatureLoopState.Validating,
      statusOverride: FeatureStatus.Triaged,
    },
  );
  return {
    fs: ctx.fs,
    projectRoot: ctx.projectRoot,
    taskId: parentTaskId,
    featureId: feature.id,
    leafTaskId,
  };
}

function makeDeps(seed: SeededTask, runValidator: RunValidatorFn): ValidatorFlowDeps {
  return {
    ctx: {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
    },
    signaller: staticSignaller(),
    runValidator,
  };
}

function makeHarness(fs: MemFs): AgentHarness {
  return new AgentHarness({
    name: 'validator-flow-test',
    params: {},
    fs,
  });
}

async function captureEventsSince(
  ctx: {
    fs: MemFs;
    projectRoot: string;
  },
  kind: EventKind,
): Promise<() => Promise<Event[]>> {
  const start = await loadState(ctx);
  return async () => {
    const tail = await tailEvents(ctx, start.lastEventId);
    return tail.filter((e) => e.kind === kind);
  };
}

//#endregion

//#region Tests — pass / fail / blocked / budget-exhausted

describe('validatorIterationStep — pass result', () => {
  it('records a passing run, marks the feature done, and publishes the loop-state change on featureLoopStateChan', async () => {
    const seed = await seedStructuredTask('T-flowpass00');
    const ctx = {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
    };
    const drainRecorded = await captureEventsSince(ctx, EventKind.ValidatorRunRecorded);
    const drainLoopChanges = await captureEventsSince(ctx, EventKind.FeatureLoopStateChanged);

    const harness = makeHarness(seed.fs);
    const childCtx = harness.createContext();
    const deps = makeDeps(seed, async () => ({
      status: 'pass',
      summary: 'all good',
    }));
    const iterStep = buildValidatorIterationStep(deps);

    // Subscribe BEFORE the publish so the topic dispatch finds us.
    const recvPromise = childCtx.recv(featureLoopStateChan, {
      timeout: 5_000,
    });
    childCtx.send(validatorRequestChan, {
      taskId: seed.taskId,
      featureId: seed.featureId,
    });
    await harness.run(iterStep, undefined, childCtx);

    const runs = await listValidatorRuns(
      {
        ...ctx,
        taskId: seed.taskId,
      },
      seed.featureId,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe(ValidatorRunStatus.Pass);
    const reloaded = await loadFeature(ctx, seed.taskId, seed.featureId);
    expect(reloaded?.loopState).toBe(FeatureLoopState.Passed);
    expect(reloaded?.status).toBe(FeatureStatus.Done);
    expect(await drainRecorded()).toHaveLength(1);
    expect(await drainLoopChanges()).toHaveLength(1);

    const published = await recvPromise;
    expect(published.taskId).toBe(seed.taskId);
    expect(published.featureId).toBe(seed.featureId);
    expect(published.previousLoopState).toBe(FeatureLoopState.Validating);
    expect(published.loopState).toBe(FeatureLoopState.Passed);
  });
});

describe('validatorIterationStep — fail result', () => {
  it('generates a fix feature and emits feature:fixGenerated', async () => {
    const seed = await seedStructuredTask('T-flowfail00');
    const ctx = {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
    };
    const drainFixEvents = await captureEventsSince(ctx, EventKind.FeatureFixGenerated);

    const harness = makeHarness(seed.fs);
    const childCtx = harness.createContext();
    const iterStep = buildValidatorIterationStep(
      makeDeps(seed, async () => ({
        status: 'fail',
        summary: 'broken',
      })),
    );

    childCtx.send(validatorRequestChan, {
      taskId: seed.taskId,
      featureId: seed.featureId,
    });
    await harness.run(iterStep, undefined, childCtx);

    const fixEvents = await drainFixEvents();
    expect(fixEvents).toHaveLength(1);
    expect(fixEvents[0]?.payload?.['sourceFeatureId']).toBe(seed.featureId);
  });

  it('falls back to feature:budgetExhausted when retry budget is hit', async () => {
    const seed = await seedStructuredTask('T-flowbudg00');
    const ctx = {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
    };
    const existing = await loadFeature(ctx, seed.taskId, seed.featureId);
    if (existing === null) {
      throw new Error('seed feature missing');
    }
    await saveFeature(ctx, seed.taskId, {
      ...existing,
      implementationAttemptCount: 3,
    });
    const drainExhausted = await captureEventsSince(ctx, EventKind.FeatureBudgetExhausted);
    const drainLoopChanges = await captureEventsSince(ctx, EventKind.FeatureLoopStateChanged);

    const harness = makeHarness(seed.fs);
    const childCtx = harness.createContext();
    const iterStep = buildValidatorIterationStep(
      makeDeps(seed, async () => ({
        status: 'fail',
        summary: 'still broken',
      })),
    );

    childCtx.send(validatorRequestChan, {
      taskId: seed.taskId,
      featureId: seed.featureId,
    });
    await harness.run(iterStep, undefined, childCtx);

    const exhausted = await drainExhausted();
    const loopChanges = await drainLoopChanges();
    expect(exhausted).toHaveLength(1);
    expect(loopChanges).toHaveLength(1);
    expect(loopChanges[0]?.payload?.['loopState']).toBe(FeatureLoopState.Blocked);
    const reloaded = await loadFeature(ctx, seed.taskId, seed.featureId);
    expect(reloaded?.loopState).toBe(FeatureLoopState.Blocked);
  });
});

describe('validatorIterationStep — blocked result', () => {
  it('marks the feature blocked when the validator reports blocked and publishes the loop-state change', async () => {
    const seed = await seedStructuredTask('T-flowblck00');
    const ctx = {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
    };
    const drainLoopChanges = await captureEventsSince(ctx, EventKind.FeatureLoopStateChanged);

    const harness = makeHarness(seed.fs);
    const childCtx = harness.createContext();
    const iterStep = buildValidatorIterationStep(
      makeDeps(seed, async () => ({
        status: 'blocked',
        summary: 'env unhealthy',
        blockedReason: 'docker not running',
      })),
    );

    const recvPromise = childCtx.recv(featureLoopStateChan, {
      timeout: 5_000,
    });
    childCtx.send(validatorRequestChan, {
      taskId: seed.taskId,
      featureId: seed.featureId,
    });
    await harness.run(iterStep, undefined, childCtx);

    const loopChanges = await drainLoopChanges();
    expect(loopChanges).toHaveLength(1);
    expect(loopChanges[0]?.payload?.['loopState']).toBe(FeatureLoopState.Blocked);
    const reloaded = await loadFeature(ctx, seed.taskId, seed.featureId);
    expect(reloaded?.loopState).toBe(FeatureLoopState.Blocked);
    const published = await recvPromise;
    expect(published.loopState).toBe(FeatureLoopState.Blocked);
    expect(published.previousLoopState).toBe(FeatureLoopState.Validating);
  });
});

describe('validatorIterationStep — validator throws', () => {
  it('marks the run as error without dispatching a result handler', async () => {
    const seed = await seedStructuredTask('T-flowthrw00');
    const ctx = {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
    };
    const drainExhausted = await captureEventsSince(ctx, EventKind.FeatureBudgetExhausted);

    const harness = makeHarness(seed.fs);
    const childCtx = harness.createContext();
    const iterStep = buildValidatorIterationStep(
      makeDeps(seed, async () => {
        throw new Error('boom');
      }),
    );

    childCtx.send(validatorRequestChan, {
      taskId: seed.taskId,
      featureId: seed.featureId,
    });
    await harness.run(iterStep, undefined, childCtx);

    const runs = await listValidatorRuns(
      {
        ...ctx,
        taskId: seed.taskId,
      },
      seed.featureId,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe(ValidatorRunStatus.Error);
    expect(await drainExhausted()).toHaveLength(0);
  });
});

describe('validatorIterationStep — empty channel', () => {
  it('is a no-op when no requests are pending', async () => {
    const seed = await seedStructuredTask('T-flowempt00');
    const harness = makeHarness(seed.fs);
    const childCtx = harness.createContext();
    const iterStep = buildValidatorIterationStep(
      makeDeps(seed, async () => ({
        status: 'pass',
        summary: 'unused',
      })),
    );
    await harness.run(iterStep, undefined, childCtx);
    const runs = await listValidatorRuns(
      {
        fs: seed.fs,
        projectRoot: seed.projectRoot,
        taskId: seed.taskId,
      },
      seed.featureId,
    );
    expect(runs).toHaveLength(0);
  });
});

describe('buildValidatorEvery', () => {
  it('returns a StepEvery wrapping the iteration with validatorRequestChan wakeOn', async () => {
    const seed = await seedStructuredTask('T-flowevry00');
    const everyStep = buildValidatorEvery(
      makeDeps(seed, async () => ({
        status: 'pass',
        summary: 'unused',
      })),
    );
    expect(everyStep.kind).toBe('every');
    expect(everyStep.id).toBe('validator.every');
    expect(everyStep.ms).toBe(30_000);
    expect(everyStep.onError).toBe('continue');
    expect(everyStep.wakeOn?.name).toBe('tasks.validator-request');
    expect(everyStep.step.id).toBe('validator.iteration');
  });
});

//#endregion
