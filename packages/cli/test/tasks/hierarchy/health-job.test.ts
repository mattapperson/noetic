import { describe, expect, it } from 'bun:test';

import type { Signaller } from '../../../src/commands/builtins/tasks/agent-ci-control.js';
import { saveTask } from '@noetic/code-agent/tasks/store/fs-node';
import { activateSlice } from '../../../src/commands/builtins/tasks/hierarchy/activation.js';
import { applyFeatureLoopStateUpdate } from '../../../src/commands/builtins/tasks/hierarchy/feature-lifecycle.js';
import type { HealthJobDeps } from '../../../src/commands/builtins/tasks/hierarchy/health-job.js';
import { _testRunHealthTick } from '../../../src/commands/builtins/tasks/hierarchy/health-job.js';
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
} from '@noetic/code-agent/tasks/schema';
import type { MemFs } from '../_helpers.js';
import { makeStoreContext } from '../_helpers.js';

const NOW = '2026-04-30T00:00:00.000Z';

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

function makeDeps(seed: SeededTask, signaller: Signaller): HealthJobDeps {
  return {
    ctx: {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
      tasksRoot: seed.tasksRoot,
    },
    signaller,
  };
}

describe('reapStaleValidatorRuns', () => {
  it('marks running runs whose pid is dead as error', async () => {
    const seed = await seedStructuredTask('T-reap000000');
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
    await _testRunHealthTick(makeDeps(seed, staticSignaller()));
    const runs = await listValidatorRuns(ctx, seed.featureId);
    expect(runs[0]?.status).toBe(ValidatorRunStatus.Error);
  });

  it('leaves running runs alone when the pid identity matches', async () => {
    const seed = await seedStructuredTask('T-keepalive0');
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
    await _testRunHealthTick(
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
    const runs = await listValidatorRuns(ctx, seed.featureId);
    expect(runs[0]?.status).toBe(ValidatorRunStatus.Running);
  });

  it('reaps a running run whose start time has changed (pid recycled)', async () => {
    const seed = await seedStructuredTask('T-recyc00000');
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
    await _testRunHealthTick(
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
    const runs = await listValidatorRuns(ctx, seed.featureId);
    expect(runs[0]?.status).toBe(ValidatorRunStatus.Error);
  });
});

describe('reconcileFeatureLinkageDrift', () => {
  it('blocks features whose linked leaf task has been deleted', async () => {
    const seed = await seedStructuredTask('T-drift00000');
    const ctx = {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
      tasksRoot: seed.tasksRoot,
    };
    // Move the feature into validating so the reconciler considers it.
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
    // Delete the leaf task by hand to simulate drift.
    seed.fs.files.forEach((_, key) => {
      if (key.includes(`/${seed.leafTaskId}/task.json`)) {
        seed.fs.files.delete(key);
      }
    });
    await _testRunHealthTick(makeDeps(seed, staticSignaller()));
    const reloaded = await loadFeature(ctx, seed.taskId, seed.featureId);
    expect(reloaded?.loopState).toBe(FeatureLoopState.Blocked);
    expect(reloaded?.blockedReason).toContain(seed.leafTaskId);
  });

  it('leaves features alone when their linked task still exists', async () => {
    const seed = await seedStructuredTask('T-stable0000');
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
    await _testRunHealthTick(makeDeps(seed, staticSignaller()));
    const reloaded = await loadFeature(ctx, seed.taskId, seed.featureId);
    expect(reloaded?.loopState).toBe(FeatureLoopState.Implementing);
  });
});
