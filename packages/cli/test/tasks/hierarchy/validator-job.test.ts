import { describe, expect, it } from 'bun:test';
import type { Event } from '@noetic-tools/code-agent/tasks/schema';
import {
  AutopilotState,
  EventKind,
  HierarchyStatus,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '@noetic-tools/code-agent/tasks/schema';
import { loadState, saveTask, tailEvents } from '@noetic-tools/code-agent/tasks/store/fs-node';
import type { Signaller } from '../../../src/tasks/runtime/agent-ci-control.js';
import { activateSlice } from '../../../src/tasks/runtime/hierarchy/activation.js';
import { applyFeatureLoopStateUpdate } from '../../../src/tasks/runtime/hierarchy/feature-lifecycle.js';
import { persistTaskHierarchy } from '../../../src/tasks/runtime/hierarchy/persist.js';
import {
  FeatureLoopState,
  FeatureStatus,
  ValidatorRunStatus,
} from '../../../src/tasks/runtime/hierarchy/schemas.js';
import { loadFeature, saveFeature } from '../../../src/tasks/runtime/hierarchy/store.js';
import { listValidatorRuns } from '../../../src/tasks/runtime/hierarchy/validator.js';
import type {
  RunValidatorFn,
  ValidatorJobDeps,
} from '../../../src/tasks/runtime/hierarchy/validator-job.js';
import { _testRunValidatorTick } from '../../../src/tasks/runtime/hierarchy/validator-job.js';
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

function staticSignaller(opts?: { alivePids?: ReadonlySet<number> }): Signaller {
  const alive = opts?.alivePids ?? new Set<number>();
  return {
    kill: () => {
      // unused
    },
    isAlive: (pid) => alive.has(pid),
    startTime: () => null,
  };
}

async function seedStructuredTask(parentTaskId: string): Promise<SeededTask> {
  const ctx = makeStoreContext();
  const parent = {
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
  };
  await saveTask(ctx, parent);
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
  // Activate the slice and triage the feature so a leaf task is created.
  const activation = await activateSlice(ctx, {
    parentTaskId,
    sliceId: slice.id,
    triage: true,
  });
  const leafTaskId = activation.triaged.created[0]?.id;
  if (leafTaskId === undefined) {
    throw new Error('triage produced no leaf task');
  }
  // Move the feature into validating so the daemon will pick it up.
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
    tasksRoot: ctx.tasksRoot,
    taskId: parentTaskId,
    featureId: feature.id,
    leafTaskId,
  };
}

function makeDeps(seed: SeededTask, runValidator: RunValidatorFn): ValidatorJobDeps {
  return {
    ctx: {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
      tasksRoot: seed.tasksRoot,
    },
    signaller: staticSignaller(),
    runValidator,
  };
}

/**
 * Snapshot the current event-log watermark so callers can ask
 * "which events of `kind` were appended since the snapshot?". The
 * return value is a thunk that re-tails the durable `_events.jsonl`
 * via `tailEvents` and filters by `kind`.
 */
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

describe('_testRunValidatorTick (pass result)', () => {
  it('records a passing run and marks the feature done', async () => {
    const seed = await seedStructuredTask('T-pass000000');
    const ctx = {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
      tasksRoot: seed.tasksRoot,
    };
    const drainRecorded = await captureEventsSince(ctx, EventKind.ValidatorRunRecorded);
    const drainLoopChanges = await captureEventsSince(ctx, EventKind.FeatureLoopStateChanged);
    await _testRunValidatorTick(
      makeDeps(seed, async () => ({
        status: 'pass',
        summary: 'all good',
      })),
    );
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
  });
});

describe('_testRunValidatorTick (fail result)', () => {
  it('generates a fix feature and emits feature:fixGenerated', async () => {
    const seed = await seedStructuredTask('T-fail000000');
    const ctx = {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
      tasksRoot: seed.tasksRoot,
    };
    const drainFixEvents = await captureEventsSince(ctx, EventKind.FeatureFixGenerated);
    await _testRunValidatorTick(
      makeDeps(seed, async () => ({
        status: 'fail',
        summary: 'broken',
      })),
    );
    const fixEvents = await drainFixEvents();
    expect(fixEvents).toHaveLength(1);
    expect(fixEvents[0]?.payload?.['sourceFeatureId']).toBe(seed.featureId);
  });

  it('falls back to feature:budgetExhausted when retry budget is hit', async () => {
    const seed = await seedStructuredTask('T-budgt00000');
    // Pre-bump the source feature's implementationAttemptCount to the budget so the
    // next fail saturates and createGeneratedFixFeature throws BudgetExhaustedError.
    const ctx = {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
      tasksRoot: seed.tasksRoot,
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
    await _testRunValidatorTick(
      makeDeps(seed, async () => ({
        status: 'fail',
        summary: 'still broken',
      })),
    );
    const exhausted = await drainExhausted();
    const loopChanges = await drainLoopChanges();
    expect(exhausted).toHaveLength(1);
    expect(loopChanges).toHaveLength(1);
    expect(loopChanges[0]?.payload?.['loopState']).toBe(FeatureLoopState.Blocked);
    const reloaded = await loadFeature(ctx, seed.taskId, seed.featureId);
    expect(reloaded?.loopState).toBe(FeatureLoopState.Blocked);
  });
});

describe('_testRunValidatorTick (validator throws)', () => {
  it('marks the run as error without dispatching a result handler', async () => {
    const seed = await seedStructuredTask('T-error00000');
    const ctx = {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
      tasksRoot: seed.tasksRoot,
    };
    const drainExhausted = await captureEventsSince(ctx, EventKind.FeatureBudgetExhausted);
    await _testRunValidatorTick(
      makeDeps(seed, async () => {
        throw new Error('boom');
      }),
    );
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
