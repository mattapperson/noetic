import { afterEach, describe, expect, it } from 'bun:test';

import type { Signaller } from '../../../src/commands/builtins/tasks/agent-ci-control.js';
import { offTaskEvent, onTaskEvent } from '../../../src/commands/builtins/tasks/events.js';
import { saveTask } from '../../../src/commands/builtins/tasks/fs-store.js';
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
import type {
  RunValidatorFn,
  ValidatorJobDeps,
} from '../../../src/commands/builtins/tasks/hierarchy/validator-job.js';
import { _testRunValidatorTick } from '../../../src/commands/builtins/tasks/hierarchy/validator-job.js';
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
    },
    signaller: staticSignaller(),
    runValidator,
  };
}

const eventListeners: Array<
  [
    EventKind,
    (e: Event) => void,
  ]
> = [];

function captureEvents(kind: EventKind): Event[] {
  const out: Event[] = [];
  const listener = (event: Event): void => {
    out.push(event);
  };
  onTaskEvent(kind, listener);
  eventListeners.push([
    kind,
    listener,
  ]);
  return out;
}

afterEach(() => {
  for (const [kind, listener] of eventListeners) {
    offTaskEvent(kind, listener);
  }
  eventListeners.length = 0;
});

describe('_testRunValidatorTick (pass result)', () => {
  it('records a passing run and marks the feature done', async () => {
    const seed = await seedStructuredTask('T-pass000000');
    const recorded = captureEvents(EventKind.ValidatorRunRecorded);
    const loopChanges = captureEvents(EventKind.FeatureLoopStateChanged);
    await _testRunValidatorTick(
      makeDeps(seed, async () => ({
        status: 'pass',
        summary: 'all good',
      })),
    );
    const runs = await listValidatorRuns(
      {
        fs: seed.fs,
        projectRoot: seed.projectRoot,
        taskId: seed.taskId,
      },
      seed.featureId,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe(ValidatorRunStatus.Pass);
    const reloaded = await loadFeature(
      {
        fs: seed.fs,
        projectRoot: seed.projectRoot,
      },
      seed.taskId,
      seed.featureId,
    );
    expect(reloaded?.loopState).toBe(FeatureLoopState.Passed);
    expect(reloaded?.status).toBe(FeatureStatus.Done);
    expect(recorded).toHaveLength(1);
    expect(loopChanges).toHaveLength(1);
  });
});

describe('_testRunValidatorTick (fail result)', () => {
  it('generates a fix feature and emits feature:fixGenerated', async () => {
    const seed = await seedStructuredTask('T-fail000000');
    const fixEvents = captureEvents(EventKind.FeatureFixGenerated);
    await _testRunValidatorTick(
      makeDeps(seed, async () => ({
        status: 'fail',
        summary: 'broken',
      })),
    );
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
    };
    const existing = await loadFeature(ctx, seed.taskId, seed.featureId);
    if (existing === null) {
      throw new Error('seed feature missing');
    }
    await saveFeature(ctx, seed.taskId, {
      ...existing,
      implementationAttemptCount: 3,
    });
    const exhausted = captureEvents(EventKind.FeatureBudgetExhausted);
    const loopChanges = captureEvents(EventKind.FeatureLoopStateChanged);
    await _testRunValidatorTick(
      makeDeps(seed, async () => ({
        status: 'fail',
        summary: 'still broken',
      })),
    );
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
    const exhausted = captureEvents(EventKind.FeatureBudgetExhausted);
    await _testRunValidatorTick(
      makeDeps(seed, async () => {
        throw new Error('boom');
      }),
    );
    const runs = await listValidatorRuns(
      {
        fs: seed.fs,
        projectRoot: seed.projectRoot,
        taskId: seed.taskId,
      },
      seed.featureId,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe(ValidatorRunStatus.Error);
    expect(exhausted).toHaveLength(0);
  });
});
