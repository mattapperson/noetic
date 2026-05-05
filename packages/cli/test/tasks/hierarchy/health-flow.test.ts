import { describe, expect, it } from 'bun:test';

import { AgentHarness } from '@noetic/core';

import type { Signaller } from '../../../src/commands/builtins/tasks/agent-ci-control.js';
import { saveTask } from '../../../src/commands/builtins/tasks/fs-store.js';
import { activateSlice } from '../../../src/commands/builtins/tasks/hierarchy/activation.js';
import { applyFeatureLoopStateUpdate } from '../../../src/commands/builtins/tasks/hierarchy/feature-lifecycle.js';
import type { HealthFlowDeps } from '../../../src/commands/builtins/tasks/hierarchy/health-flow.js';
import {
  buildHealthEvery,
  buildHealthTickStep,
} from '../../../src/commands/builtins/tasks/hierarchy/health-flow.js';
import { persistTaskHierarchy } from '../../../src/commands/builtins/tasks/hierarchy/persist.js';
import {
  FeatureLoopState,
  FeatureStatus,
  ValidatorRunStatus,
} from '../../../src/commands/builtins/tasks/hierarchy/schemas.js';
import { loadFeature } from '../../../src/commands/builtins/tasks/hierarchy/store.js';
import {
  listValidatorRuns,
  recordValidatorRun,
  updateValidatorRun,
} from '../../../src/commands/builtins/tasks/hierarchy/validator.js';
import {
  AutopilotState,
  HierarchyStatus,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '../../../src/commands/builtins/tasks/schemas.js';
import type { MemFs } from '../_helpers.js';
import { makeStoreContext } from '../_helpers.js';

const NOW = '2026-04-30T00:00:00.000Z';

//#region Helpers

interface SeededTask {
  readonly fs: MemFs;
  readonly projectRoot: string;
  readonly tasksRoot: string;
  readonly taskId: string;
  readonly featureId: string;
  readonly leafTaskId: string;
}

function staticSignaller(opts?: {
  alivePids?: ReadonlySet<number>;
  startTimes?: ReadonlyMap<number, string | null>;
}): Signaller {
  const alive = opts?.alivePids ?? new Set<number>();
  const startTimes = opts?.startTimes ?? new Map<number, string | null>();
  return {
    kill: () => {
      // unused
    },
    isAlive: (pid) => alive.has(pid),
    startTime: (pid) => startTimes.get(pid) ?? null,
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
  return {
    fs: ctx.fs,
    projectRoot: ctx.projectRoot,
    tasksRoot: ctx.tasksRoot,
    taskId: parentTaskId,
    featureId: feature.id,
    leafTaskId,
  };
}

function makeDeps(seed: SeededTask, signaller: Signaller): HealthFlowDeps {
  return {
    ctx: {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
      tasksRoot: seed.tasksRoot,
    },
    signaller,
  };
}

function makeHarness(fs: MemFs): AgentHarness {
  return new AgentHarness({
    name: 'health-flow-test',
    params: {},
    fs,
  });
}

//#endregion

//#region Tests

describe('healthTickStep — reap stale validator runs', () => {
  it('marks running runs whose pid is dead as error', async () => {
    const seed = await seedStructuredTask('T-flowreap00');
    const ctx = {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
      tasksRoot: seed.tasksRoot,
      taskId: seed.taskId,
    };
    const run = await recordValidatorRun(ctx, {
      featureId: seed.featureId,
      status: ValidatorRunStatus.Running,
    });
    await updateValidatorRun(ctx, {
      featureId: seed.featureId,
      runId: run.id,
      patch: {
        pid: 1234,
        pidStarttime: 'A',
      },
    });
    const harness = makeHarness(seed.fs);
    const childCtx = harness.createContext();
    const tickStep = buildHealthTickStep(makeDeps(seed, staticSignaller()));
    await harness.run(tickStep, undefined, childCtx);
    const runs = await listValidatorRuns(ctx, seed.featureId);
    expect(runs[0]?.status).toBe(ValidatorRunStatus.Error);
  });

  it('leaves running runs alone when the pid identity matches', async () => {
    const seed = await seedStructuredTask('T-flowkeep00');
    const ctx = {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
      tasksRoot: seed.tasksRoot,
      taskId: seed.taskId,
    };
    const run = await recordValidatorRun(ctx, {
      featureId: seed.featureId,
      status: ValidatorRunStatus.Running,
    });
    await updateValidatorRun(ctx, {
      featureId: seed.featureId,
      runId: run.id,
      patch: {
        pid: 4242,
        pidStarttime: 'A',
      },
    });
    const harness = makeHarness(seed.fs);
    const childCtx = harness.createContext();
    const tickStep = buildHealthTickStep(
      makeDeps(
        seed,
        staticSignaller({
          alivePids: new Set([
            4242,
          ]),
          startTimes: new Map([
            [
              4242,
              'A',
            ],
          ]),
        }),
      ),
    );
    await harness.run(tickStep, undefined, childCtx);
    const runs = await listValidatorRuns(ctx, seed.featureId);
    expect(runs[0]?.status).toBe(ValidatorRunStatus.Running);
  });

  it('reaps a running run whose start time has changed (pid recycled)', async () => {
    const seed = await seedStructuredTask('T-flowrecyc0');
    const ctx = {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
      tasksRoot: seed.tasksRoot,
      taskId: seed.taskId,
    };
    const run = await recordValidatorRun(ctx, {
      featureId: seed.featureId,
      status: ValidatorRunStatus.Running,
    });
    await updateValidatorRun(ctx, {
      featureId: seed.featureId,
      runId: run.id,
      patch: {
        pid: 7777,
        pidStarttime: 'A',
      },
    });
    const harness = makeHarness(seed.fs);
    const childCtx = harness.createContext();
    const tickStep = buildHealthTickStep(
      makeDeps(
        seed,
        staticSignaller({
          alivePids: new Set([
            7777,
          ]),
          startTimes: new Map([
            [
              7777,
              'B',
            ],
          ]),
        }),
      ),
    );
    await harness.run(tickStep, undefined, childCtx);
    const runs = await listValidatorRuns(ctx, seed.featureId);
    expect(runs[0]?.status).toBe(ValidatorRunStatus.Error);
  });
});

describe('healthTickStep — reconcile feature linkage drift', () => {
  it('blocks features whose linked leaf task has been deleted', async () => {
    const seed = await seedStructuredTask('T-flowdrft00');
    const ctx = {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
      tasksRoot: seed.tasksRoot,
    };
    await applyFeatureLoopStateUpdate(
      {
        ...ctx,
        taskId: seed.taskId,
      },
      {
        featureId: seed.featureId,
        newLoopState: FeatureLoopState.Validating,
        statusOverride: FeatureStatus.Triaged,
      },
    );
    seed.fs.files.forEach((_, key) => {
      if (key.includes(`/${seed.leafTaskId}/task.json`)) {
        seed.fs.files.delete(key);
      }
    });
    const harness = makeHarness(seed.fs);
    const childCtx = harness.createContext();
    const tickStep = buildHealthTickStep(makeDeps(seed, staticSignaller()));
    await harness.run(tickStep, undefined, childCtx);
    const reloaded = await loadFeature(ctx, seed.taskId, seed.featureId);
    expect(reloaded?.loopState).toBe(FeatureLoopState.Blocked);
    expect(reloaded?.blockedReason).toContain(seed.leafTaskId);
  });

  it('leaves features alone when their linked task still exists', async () => {
    const seed = await seedStructuredTask('T-flowstabl0');
    const ctx = {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
      tasksRoot: seed.tasksRoot,
    };
    await applyFeatureLoopStateUpdate(
      {
        ...ctx,
        taskId: seed.taskId,
      },
      {
        featureId: seed.featureId,
        newLoopState: FeatureLoopState.Implementing,
      },
    );
    const harness = makeHarness(seed.fs);
    const childCtx = harness.createContext();
    const tickStep = buildHealthTickStep(makeDeps(seed, staticSignaller()));
    await harness.run(tickStep, undefined, childCtx);
    const reloaded = await loadFeature(ctx, seed.taskId, seed.featureId);
    expect(reloaded?.loopState).toBe(FeatureLoopState.Implementing);
  });
});

describe('buildHealthEvery', () => {
  it('returns a StepEvery wrapping the tick step', () => {
    const ctx = makeStoreContext();
    const everyStep = buildHealthEvery({
      ctx,
      signaller: staticSignaller(),
    });
    expect(everyStep.kind).toBe('every');
    expect(everyStep.id).toBe('health.every');
    expect(everyStep.ms).toBe(300_000);
    expect(everyStep.onError).toBe('continue');
    expect(everyStep.step.id).toBe('health.tick');
  });
});

//#endregion
