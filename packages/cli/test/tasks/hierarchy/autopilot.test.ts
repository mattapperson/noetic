import { describe, expect, it } from 'bun:test';

import type { Signaller } from '../../../src/commands/builtins/tasks/agent-ci-control.js';
import {
  loadState,
  saveTask,
  tailEvents,
  tryLoadTask,
} from '../../../src/commands/builtins/tasks/fs-store.js';
import type { AutopilotDeps } from '../../../src/commands/builtins/tasks/hierarchy/autopilot.js';
import { runAutopilotTick } from '../../../src/commands/builtins/tasks/hierarchy/autopilot.js';
import { applyFeatureLoopStateUpdate } from '../../../src/commands/builtins/tasks/hierarchy/feature-lifecycle.js';
import { persistTaskHierarchy } from '../../../src/commands/builtins/tasks/hierarchy/persist.js';
import {
  FeatureLoopState,
  FeatureStatus,
  MilestoneStatus,
  SliceStatus,
} from '../../../src/commands/builtins/tasks/hierarchy/schemas.js';
import {
  listMilestones,
  listSlices,
} from '../../../src/commands/builtins/tasks/hierarchy/store.js';
import type { Event, Task } from '../../../src/commands/builtins/tasks/schemas.js';
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
}

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

function makeDeps(seed: SeededTask): AutopilotDeps {
  return {
    ctx: {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
    },
    signaller: staticSignaller(),
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

describe('runAutopilotTick (no active slice)', () => {
  it('activates the first pending slice and triages its features', async () => {
    const seed = await seedTaskWithTwoSlices('T-tickfirst1');
    const report = await runAutopilotTick(makeDeps(seed));
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
    const seed = await seedTaskWithTwoSlices('T-watcher000');
    await runAutopilotTick(makeDeps(seed));
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
    const seed = await seedTaskWithTwoSlices('T-disabled00');
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
    const report = await runAutopilotTick(makeDeps(seed));
    expect(report.tasksScanned).toBe(0);
  });
});

describe('runAutopilotTick (active slice with all features passed)', () => {
  it('completes the slice, activates the next slice, emits status events', async () => {
    const seed = await seedTaskWithTwoSlices('T-advance001');
    // First tick activates the first slice.
    await runAutopilotTick(makeDeps(seed));
    const ctx = {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
    };
    const features = await import('../../../src/commands/builtins/tasks/hierarchy/store.js').then(
      (m) => m.listFeatures(ctx, seed.taskId),
    );
    const firstSliceFeature = features[0];
    if (firstSliceFeature === undefined) {
      throw new Error('no first feature');
    }
    // Mark the active slice's feature as passed so the next tick advances.
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
    const report = await runAutopilotTick(makeDeps(seed));
    expect(report.slicesCompleted).toBe(1);
    expect(report.slicesActivated).toBe(1);
    const slices = await listSlices(ctx, seed.taskId);
    const completedCount = slices.filter((s) => s.status === SliceStatus.Complete).length;
    expect(completedCount).toBe(1);
    const activeCount = slices.filter((s) => s.status === SliceStatus.Active).length;
    expect(activeCount).toBe(1);
  });
});

describe('runAutopilotTick (no slices left)', () => {
  it('marks the task complete and emits mission:statusChanged', async () => {
    const ctx = makeStoreContext();
    const taskId = 'T-empty00000';
    await saveTask(ctx, makeTask({}, ctx.projectRoot, taskId));
    // Hierarchy with no slices anywhere.
    await persistTaskHierarchy(ctx, taskId, {
      milestones: [
        {
          title: 'M1',
          verification: 'v',
          slices: [],
          assertions: [],
        },
      ],
    });
    const drainEvents = await captureEventsSince(ctx, EventKind.HierarchyStatusChanged);
    const seed: SeededTask = {
      fs: ctx.fs,
      projectRoot: ctx.projectRoot,
      taskId,
    };
    const report = await runAutopilotTick(makeDeps(seed));
    expect(report.tasksCompleted).toBe(1);
    const reloaded = await tryLoadTask(ctx, taskId);
    expect(reloaded?.hierarchyStatus).toBe(HierarchyStatus.Complete);
    expect(reloaded?.lifecycleStatus).toBe(TaskLifecycleStatus.Merged);
    expect(reloaded?.autopilotState).toBe(AutopilotState.Inactive);
    const events = await drainEvents();
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('runAutopilotTick (slice fully blocked)', () => {
  it('emits HierarchyStatusChanged=blocked and increments tasksBlocked', async () => {
    const seed = await seedTaskWithTwoSlices('T-blocked001');
    // Activate the first slice, then mark the feature as blocked so classify→any_blocked.
    await runAutopilotTick(makeDeps(seed));
    const ctx = {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
    };
    const features = await import('../../../src/commands/builtins/tasks/hierarchy/store.js').then(
      (m) => m.listFeatures(ctx, seed.taskId),
    );
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
    const drainEvents = await captureEventsSince(ctx, EventKind.HierarchyStatusChanged);
    const report = await runAutopilotTick(makeDeps(seed));
    expect(report.tasksBlocked).toBe(1);
    const events = await drainEvents();
    expect(events.length).toBeGreaterThan(0);
    const reloaded = await tryLoadTask(ctx, seed.taskId);
    expect(reloaded?.hierarchyStatus).toBe(HierarchyStatus.Blocked);
  });
});

describe('runAutopilotTick (milestone completion)', () => {
  it('marks milestones complete when all their slices are complete', async () => {
    const seed = await seedTaskWithTwoSlices('T-mlcomplt00');
    const ctx = {
      fs: seed.fs,
      projectRoot: seed.projectRoot,
    };
    // Tick 1: activates S1.
    await runAutopilotTick(makeDeps(seed));
    const feats = await import('../../../src/commands/builtins/tasks/hierarchy/store.js').then(
      (m) => m.listFeatures(ctx, seed.taskId),
    );
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
    // Tick 2: completes S1, activates S2 (and triages F2).
    await runAutopilotTick(makeDeps(seed));
    const feats2 = await import('../../../src/commands/builtins/tasks/hierarchy/store.js').then(
      (m) => m.listFeatures(ctx, seed.taskId),
    );
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
    // Tick 3: completes S2 → milestone has no more slices to advance.
    await runAutopilotTick(makeDeps(seed));
    const milestones = await listMilestones(ctx, seed.taskId);
    expect(milestones[0]?.status).toBe(MilestoneStatus.Complete);
  });
});
