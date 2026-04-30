import { describe, expect, it } from 'bun:test';

import { AgentHarness } from '@noetic/core';

import type { Signaller } from '../../../src/commands/builtins/tasks/agent-ci-control.js';
import { saveTask, tryLoadTask } from '../../../src/commands/builtins/tasks/fs-store.js';
import type { AutopilotFlowDeps } from '../../../src/commands/builtins/tasks/hierarchy/autopilot-flow.js';
import {
  buildAutopilotEvery,
  buildAutopilotTickStep,
  sliceDecisionBranch,
  tickOneTaskStep,
} from '../../../src/commands/builtins/tasks/hierarchy/autopilot-flow.js';
import { applyFeatureLoopStateUpdate } from '../../../src/commands/builtins/tasks/hierarchy/feature-lifecycle.js';
import { persistTaskHierarchy } from '../../../src/commands/builtins/tasks/hierarchy/persist.js';
import {
  FeatureLoopState,
  FeatureStatus,
  MilestoneStatus,
  SliceStatus,
} from '../../../src/commands/builtins/tasks/hierarchy/schemas.js';
import {
  listFeatures,
  listMilestones,
  listSlices,
} from '../../../src/commands/builtins/tasks/hierarchy/store.js';
import type { Task } from '../../../src/commands/builtins/tasks/schemas.js';
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

interface SeededTask {
  readonly fs: MemFs;
  readonly projectRoot: string;
  readonly taskId: string;
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

function makeTask(overrides: Partial<Task>, projectRoot: string, taskId: string): Task {
  return {
    id: taskId,
    source: TaskSource.Manual,
    title: 'Parent',
    projectRoot,
    worktreePath: null,
    branch: null,
    headSha: null,
    reviewStatus: TaskReviewStatus.NotStarted,
    lifecycleStatus: TaskLifecycleStatus.Active,
    paused: false,
    archivedAt: null,
    hierarchyStatus: HierarchyStatus.Active,
    autopilotEnabled: true,
    autopilotState: AutopilotState.Inactive,
    lastAutopilotActivityAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  };
}

async function seedTaskWithTwoSlices(taskId: string): Promise<SeededTask> {
  const ctx = makeStoreContext();
  await saveTask(ctx, makeTask({}, ctx.projectRoot, taskId));
  await persistTaskHierarchy(ctx, taskId, {
    milestones: [
      {
        title: 'M1',
        verification: 'v',
        slices: [
          {
            title: 'S1',
            verification: 's',
            features: [
              {
                title: 'F1',
                acceptanceCriteria: 'a',
              },
            ],
          },
          {
            title: 'S2',
            verification: 's',
            features: [
              {
                title: 'F2',
                acceptanceCriteria: 'a',
              },
            ],
          },
        ],
        assertions: [],
      },
    ],
  });
  return {
    fs: ctx.fs,
    projectRoot: ctx.projectRoot,
    taskId,
  };
}

function makeDeps(seed: SeededTask): AutopilotFlowDeps {
  return {
    ctx: {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
    },
    signaller: staticSignaller(),
  };
}

function makeHarness(fs: MemFs): AgentHarness {
  return new AgentHarness({
    name: 'autopilot-flow-test',
    params: {},
    fs,
  });
}

//#endregion

//#region Tests — autopilotTickStep

describe('autopilotTickStep (driven by harness.run)', () => {
  it('activates the first pending slice and triages its features', async () => {
    const seed = await seedTaskWithTwoSlices('T-flowfirst1');
    const harness = makeHarness(seed.fs);
    const childCtx = harness.createContext();
    const tickStep = buildAutopilotTickStep(makeDeps(seed));
    const report = await harness.run(tickStep, undefined, childCtx);
    expect(report.tasksScanned).toBe(1);
    expect(report.slicesActivated).toBe(1);
    expect(report.featuresTriaged).toBe(1);
    const slices = await listSlices(
      {
        fs: seed.fs,
        projectRoot: seed.projectRoot,
      },
      seed.taskId,
    );
    const active = slices.find((s) => s.status === SliceStatus.Active);
    expect(active).toBeDefined();
  });

  it('promotes an inactive task to watching on first tick', async () => {
    const seed = await seedTaskWithTwoSlices('T-flowwatch0');
    const harness = makeHarness(seed.fs);
    const childCtx = harness.createContext();
    const tickStep = buildAutopilotTickStep(makeDeps(seed));
    await harness.run(tickStep, undefined, childCtx);
    const reloaded = await tryLoadTask(
      {
        fs: seed.fs,
        projectRoot: seed.projectRoot,
      },
      seed.taskId,
    );
    expect(reloaded?.autopilotState).toBe(AutopilotState.Watching);
  });

  it('skips tasks whose autopilot is disabled', async () => {
    const seed = await seedTaskWithTwoSlices('T-flowdisb00');
    const ctx = {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
    };
    const existing = await tryLoadTask(ctx, seed.taskId);
    if (existing === null) {
      throw new Error('seed task missing');
    }
    await saveTask(ctx, {
      ...existing,
      autopilotEnabled: false,
    });
    const harness = makeHarness(seed.fs);
    const childCtx = harness.createContext();
    const tickStep = buildAutopilotTickStep(makeDeps(seed));
    const report = await harness.run(tickStep, undefined, childCtx);
    expect(report.tasksScanned).toBe(0);
  });
});

describe('autopilotTickStep — slice completion advancement (Phase 2.5e bug-fix)', () => {
  it('completes the slice, activates the next slice', async () => {
    const seed = await seedTaskWithTwoSlices('T-flowadvc00');
    const harness = makeHarness(seed.fs);
    const ctx = {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
    };
    // First tick activates the first slice.
    const tickStep = buildAutopilotTickStep(makeDeps(seed));
    await harness.run(tickStep, undefined, harness.createContext());
    const features = await listFeatures(ctx, seed.taskId);
    const firstSliceFeature = features[0];
    if (firstSliceFeature === undefined) {
      throw new Error('no first feature');
    }
    await applyFeatureLoopStateUpdate(
      {
        ...ctx,
        taskId: seed.taskId,
      },
      {
        featureId: firstSliceFeature.id,
        newLoopState: FeatureLoopState.Passed,
        statusOverride: FeatureStatus.Done,
      },
    );
    const report = await harness.run(tickStep, undefined, harness.createContext());
    expect(report.slicesCompleted).toBe(1);
    expect(report.slicesActivated).toBe(1);
    const slices = await listSlices(ctx, seed.taskId);
    const completedCount = slices.filter((s) => s.status === SliceStatus.Complete).length;
    expect(completedCount).toBe(1);
    const activeCount = slices.filter((s) => s.status === SliceStatus.Active).length;
    expect(activeCount).toBe(1);
  });

  it('marks milestones complete when all their slices are complete', async () => {
    const seed = await seedTaskWithTwoSlices('T-flowmlcmp0');
    const harness = makeHarness(seed.fs);
    const ctx = {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
    };
    const tickStep = buildAutopilotTickStep(makeDeps(seed));
    // Tick 1: activates S1.
    await harness.run(tickStep, undefined, harness.createContext());
    const feats = await listFeatures(ctx, seed.taskId);
    const f1 = feats[0];
    if (f1 === undefined) {
      throw new Error('missing first feature');
    }
    await applyFeatureLoopStateUpdate(
      {
        ...ctx,
        taskId: seed.taskId,
      },
      {
        featureId: f1.id,
        newLoopState: FeatureLoopState.Passed,
        statusOverride: FeatureStatus.Done,
      },
    );
    // Tick 2: completes S1, activates S2.
    await harness.run(tickStep, undefined, harness.createContext());
    const feats2 = await listFeatures(ctx, seed.taskId);
    const f2 = feats2.find((f) => f.id !== f1.id);
    if (f2 === undefined) {
      throw new Error('missing second feature');
    }
    await applyFeatureLoopStateUpdate(
      {
        ...ctx,
        taskId: seed.taskId,
      },
      {
        featureId: f2.id,
        newLoopState: FeatureLoopState.Passed,
        statusOverride: FeatureStatus.Done,
      },
    );
    // Tick 3: completes S2 → milestone has no more slices.
    await harness.run(tickStep, undefined, harness.createContext());
    const milestones = await listMilestones(ctx, seed.taskId);
    expect(milestones[0]?.status).toBe(MilestoneStatus.Complete);
  });

  it('blocks tasks whose active slice is fully blocked', async () => {
    const seed = await seedTaskWithTwoSlices('T-flowblock0');
    const harness = makeHarness(seed.fs);
    const ctx = {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
    };
    const tickStep = buildAutopilotTickStep(makeDeps(seed));
    await harness.run(tickStep, undefined, harness.createContext());
    const features = await listFeatures(ctx, seed.taskId);
    const firstFeature = features[0];
    if (firstFeature === undefined) {
      throw new Error('missing feature');
    }
    await applyFeatureLoopStateUpdate(
      {
        ...ctx,
        taskId: seed.taskId,
      },
      {
        featureId: firstFeature.id,
        newLoopState: FeatureLoopState.Blocked,
        statusOverride: FeatureStatus.Blocked,
        blockedReason: 'broken env',
      },
    );
    const report = await harness.run(tickStep, undefined, harness.createContext());
    expect(report.tasksBlocked).toBe(1);
    const reloaded = await tryLoadTask(ctx, seed.taskId);
    expect(reloaded?.hierarchyStatus).toBe(HierarchyStatus.Blocked);
  });
});

//#endregion

//#region Tests — tickOneTaskStep + sliceDecisionBranch composition

describe('tickOneTaskStep + sliceDecisionBranch (composable building blocks)', () => {
  it('tickOneTaskStep classifies the active slice as in_progress when features are mid-flight', async () => {
    const seed = await seedTaskWithTwoSlices('T-flowinpr00');
    const harness = makeHarness(seed.fs);
    // Activate S1 first so there is an active slice to classify.
    await harness.run(buildAutopilotTickStep(makeDeps(seed)), undefined, harness.createContext());
    const result = await harness.run(
      tickOneTaskStep,
      {
        deps: makeDeps(seed),
        taskId: seed.taskId,
      },
      harness.createContext(),
    );
    expect(result.decision.kind).toBe('in_progress');
    expect(result.activeSlice).not.toBeNull();
  });

  it('sliceDecisionBranch selects the matching handler for each decision kind', async () => {
    // The branch is a pure router — drive it through harness.run with a
    // synthesized TickOneTaskOutput so we observe routing without depending
    // on the FS.
    const seed = await seedTaskWithTwoSlices('T-flowbrnch0');
    const harness = makeHarness(seed.fs);
    // Use the in_progress decision so the pass-through handler returns the
    // original input — easiest way to assert a successful routing.
    const synthetic = {
      deps: makeDeps(seed),
      taskId: seed.taskId,
      decision: {
        kind: 'in_progress' as const,
      },
      activeSlice: null,
      milestone: null,
      groups: null,
    };
    const out = await harness.run(sliceDecisionBranch, synthetic, harness.createContext());
    expect(out.decision.kind).toBe('in_progress');
    expect(out.taskId).toBe(seed.taskId);
  });
});

//#endregion

//#region Tests — buildAutopilotEvery shape

describe('buildAutopilotEvery', () => {
  it('returns a StepEvery wrapping the tick step with featureLoopStateChan wakeOn', async () => {
    const seed = await seedTaskWithTwoSlices('T-flowevery0');
    const everyStep = buildAutopilotEvery(makeDeps(seed));
    expect(everyStep.kind).toBe('every');
    expect(everyStep.id).toBe('autopilot.every');
    expect(everyStep.ms).toBe(60_000);
    expect(everyStep.onError).toBe('continue');
    expect(everyStep.wakeOn?.name).toBe('tasks.feature-loop-state');
    expect(everyStep.step.id).toBe('autopilot.scan-and-tick.void');
  });
});

//#endregion
