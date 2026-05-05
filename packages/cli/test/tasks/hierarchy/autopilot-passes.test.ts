import { describe, expect, it } from 'bun:test';
import {
  AutopilotState,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '@noetic/code-agent/tasks/schema';

import { saveTask } from '@noetic/code-agent/tasks/store/fs-node';
import { createInMemorySubprocessAdapter } from '@noetic/core';
import type { AutopilotDeps } from '../../../src/commands/builtins/tasks/hierarchy/autopilot.js';
import { runAutopilotTick } from '../../../src/commands/builtins/tasks/hierarchy/autopilot.js';
import { persistTaskHierarchy } from '../../../src/commands/builtins/tasks/hierarchy/persist.js';
import { makeStoreContext } from '../_helpers.js';

interface FakeSignaller {
  isAlive(): boolean;
  startTime(): null;
  kill(): void;
}

const fakeSignaller: FakeSignaller = {
  isAlive: () => true,
  startTime: () => null,
  kill: () => {},
};

const NOW = '2026-05-01T00:00:00.000Z';

interface SeedManualTaskOverrides {
  readonly autopilotEnabled?: boolean;
  readonly hierarchyStatus?: 'planning' | 'active' | null;
  readonly autopilotState?: AutopilotState;
}

async function seedManualTask(
  ctx: ReturnType<typeof makeStoreContext>,
  id: string,
  overrides: SeedManualTaskOverrides = {},
): Promise<void> {
  await saveTask(ctx, {
    id,
    source: TaskSource.Manual,
    title: `manual-${id}`,
    projectRoot: ctx.projectRoot,
    worktreePath: null,
    branch: null,
    headSha: null,
    reviewStatus: TaskReviewStatus.NotStarted,
    lifecycleStatus: TaskLifecycleStatus.Active,
    paused: false,
    pauseReason: null,
    archivedAt: null,
    hierarchyStatus: overrides.hierarchyStatus ?? null,
    autopilotEnabled: overrides.autopilotEnabled ?? true,
    autopilotState: overrides.autopilotState ?? AutopilotState.Inactive,
    lastAutopilotActivityAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
  });
}

async function seedLeafTask(
  ctx: ReturnType<typeof makeStoreContext>,
  id: string,
  worktreePath: string | null,
): Promise<void> {
  await saveTask(ctx, {
    id,
    source: TaskSource.Worktree,
    title: 'leaf',
    projectRoot: ctx.projectRoot,
    worktreePath,
    branch: null,
    headSha: null,
    reviewStatus: TaskReviewStatus.NotStarted,
    lifecycleStatus: TaskLifecycleStatus.Active,
    paused: false,
    pauseReason: null,
    archivedAt: null,
    hierarchyStatus: null,
    autopilotEnabled: false,
    autopilotState: AutopilotState.Inactive,
    lastAutopilotActivityAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
  });
}

describe('runAutopilotTick — plan-pass', () => {
  it('calls startPlannerRun for autopilot-enabled manual tasks with no hierarchy', async () => {
    const ctx = makeStoreContext();
    await seedManualTask(ctx, 'T-plan000001');
    const calls: string[] = [];
    const deps: AutopilotDeps = {
      ctx,
      signaller: fakeSignaller,
      subprocess: createInMemorySubprocessAdapter(),
      startPlannerRun: async (args) => {
        calls.push(args.taskId);
        return {
          sessionId: 'S-fake',
          pid: 4242,
          taskId: args.taskId,
          previousAutopilotState: AutopilotState.Inactive,
          autopilotState: AutopilotState.Planning,
        };
      },
    };
    const report = await runAutopilotTick(deps);
    expect(calls).toEqual([
      'T-plan000001',
    ]);
    expect(report.plannersStarted).toBe(1);
  });

  it('skips tasks with autopilot disabled', async () => {
    const ctx = makeStoreContext();
    await seedManualTask(ctx, 'T-plan000002', {
      autopilotEnabled: false,
    });
    const calls: string[] = [];
    const deps: AutopilotDeps = {
      ctx,
      signaller: fakeSignaller,
      subprocess: createInMemorySubprocessAdapter(),
      startPlannerRun: async (args) => {
        calls.push(args.taskId);
        return {
          sessionId: '',
          pid: 0,
          taskId: args.taskId,
          previousAutopilotState: AutopilotState.Inactive,
          autopilotState: AutopilotState.Planning,
        };
      },
    };
    const report = await runAutopilotTick(deps);
    expect(calls).toEqual([]);
    expect(report.plannersStarted).toBe(0);
  });

  it('skips tasks already in planning autopilotState', async () => {
    const ctx = makeStoreContext();
    await seedManualTask(ctx, 'T-plan000003', {
      autopilotState: 'planning',
    });
    const calls: string[] = [];
    const deps: AutopilotDeps = {
      ctx,
      signaller: fakeSignaller,
      subprocess: createInMemorySubprocessAdapter(),
      startPlannerRun: async (args) => {
        calls.push(args.taskId);
        return {
          sessionId: '',
          pid: 0,
          taskId: args.taskId,
          previousAutopilotState: AutopilotState.Planning,
          autopilotState: AutopilotState.Planning,
        };
      },
    };
    await runAutopilotTick(deps);
    expect(calls).toEqual([]);
  });

  it('skips tasks whose reviewStatus is not NotStarted', async () => {
    // The plan-pass only processes manual tasks fresh-out-of-Triage.
    // A task already in `reviewing` (i.e. user manually moved it to
    // In Progress) shouldn't be surprise-planned by the daemon.
    const ctx = makeStoreContext();
    const taskId = 'T-plan000099';
    await saveTask(ctx, {
      id: taskId,
      source: TaskSource.Manual,
      title: `manual-${taskId}`,
      projectRoot: ctx.projectRoot,
      worktreePath: null,
      branch: null,
      headSha: null,
      reviewStatus: TaskReviewStatus.Reviewing,
      lifecycleStatus: TaskLifecycleStatus.Active,
      paused: false,
      pauseReason: null,
      archivedAt: null,
      hierarchyStatus: null,
      autopilotEnabled: true,
      autopilotState: AutopilotState.Inactive,
      lastAutopilotActivityAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      lastSeenAt: NOW,
    });
    const calls: string[] = [];
    const deps: AutopilotDeps = {
      ctx,
      signaller: fakeSignaller,
      subprocess: createInMemorySubprocessAdapter(),
      startPlannerRun: async (args) => {
        calls.push(args.taskId);
        return {
          sessionId: '',
          pid: 0,
          taskId: args.taskId,
          previousAutopilotState: AutopilotState.Inactive,
          autopilotState: AutopilotState.Planning,
        };
      },
    };
    await runAutopilotTick(deps);
    expect(calls).toEqual([]);
  });

  it('skips tasks that already have a hierarchy', async () => {
    const ctx = makeStoreContext();
    await seedManualTask(ctx, 'T-plan000004', {
      hierarchyStatus: 'active',
    });
    // The disk-level hasHierarchy() check is the source of truth — bug #4
    // fix routed plan-pass off `task.hierarchyStatus` (a stale field for
    // manual hierarchies) onto `<taskDir>/hierarchy/`. Seed a one-milestone
    // hierarchy so the gate trips for this test.
    await persistTaskHierarchy(ctx, 'T-plan000004', {
      milestones: [
        {
          title: 'M',
          verification: 'verified',
          slices: [],
          assertions: [],
        },
      ],
    });
    const calls: string[] = [];
    const deps: AutopilotDeps = {
      ctx,
      signaller: fakeSignaller,
      subprocess: createInMemorySubprocessAdapter(),
      startPlannerRun: async (args) => {
        calls.push(args.taskId);
        return {
          sessionId: '',
          pid: 0,
          taskId: args.taskId,
          previousAutopilotState: AutopilotState.Inactive,
          autopilotState: AutopilotState.Planning,
        };
      },
    };
    await runAutopilotTick(deps);
    expect(calls).toEqual([]);
  });

  it('swallows launcher errors and continues with other tasks', async () => {
    const ctx = makeStoreContext();
    await seedManualTask(ctx, 'T-plan000005');
    await seedManualTask(ctx, 'T-plan000006');
    const calls: string[] = [];
    const deps: AutopilotDeps = {
      ctx,
      signaller: fakeSignaller,
      subprocess: createInMemorySubprocessAdapter(),
      startPlannerRun: async (args) => {
        calls.push(args.taskId);
        if (args.taskId === 'T-plan000005') {
          throw new Error('planner already attached');
        }
        return {
          sessionId: 'S',
          pid: 1,
          taskId: args.taskId,
          previousAutopilotState: AutopilotState.Inactive,
          autopilotState: AutopilotState.Planning,
        };
      },
    };
    const report = await runAutopilotTick(deps);
    expect(calls).toEqual([
      'T-plan000005',
      'T-plan000006',
    ]);
    expect(report.plannersStarted).toBe(1);
  });

  it('is a no-op when startPlannerRun is not provided', async () => {
    const ctx = makeStoreContext();
    await seedManualTask(ctx, 'T-plan000007');
    const deps: AutopilotDeps = {
      ctx,
      signaller: fakeSignaller,
      subprocess: createInMemorySubprocessAdapter(),
    };
    const report = await runAutopilotTick(deps);
    expect(report.plannersStarted).toBe(0);
  });
});

describe('runAutopilotTick — implement-pass', () => {
  it('calls startImplementerRun for implementing features whose leaf has no worktree', async () => {
    const ctx = makeStoreContext();
    const PARENT = 'T-parent0000';
    const LEAF = 'T-leaf000000';
    await seedManualTask(ctx, PARENT, {
      hierarchyStatus: 'active',
    });
    await seedLeafTask(ctx, LEAF, null);
    const persisted = await persistTaskHierarchy(ctx, PARENT, {
      milestones: [
        {
          title: 'M1',
          verification: 'tests pass',
          slices: [
            {
              title: 'S1',
              verification: 'visible',
              features: [
                {
                  title: 'F1',
                  acceptanceCriteria: 'do X',
                },
              ],
            },
          ],
          assertions: [],
        },
      ],
    });
    // Link the leaf task and bump loopState to implementing.
    const featureId = persisted.features[0]?.id;
    expect(featureId).toBeDefined();
    if (featureId === undefined) {
      throw new Error('seed failed');
    }
    const { saveFeature } = await import('../../../src/commands/builtins/tasks/hierarchy/store.js');
    await saveFeature(ctx, PARENT, {
      ...persisted.features[0]!,
      taskId: LEAF,
      loopState: 'implementing',
      status: 'triaged',
    });

    const calls: Array<{
      taskId: string;
      featureId: string;
      branch: string;
    }> = [];
    const deps: AutopilotDeps = {
      ctx,
      signaller: fakeSignaller,
      subprocess: createInMemorySubprocessAdapter(),
      startImplementerRun: async (args) => {
        calls.push({
          taskId: args.taskId,
          featureId: args.featureId,
          branch: args.branch,
        });
        return {
          sessionId: 'S',
          pid: 4242,
          taskId: args.taskId,
          parentTaskId: args.parentTaskId,
          featureId: args.featureId,
          branch: args.branch,
          worktreePath: '/repo/.worktrees/x',
          provisionTool: 'git',
        };
      },
    };
    const report = await runAutopilotTick(deps);
    expect(calls.length).toBe(1);
    expect(calls[0]?.taskId).toBe(LEAF);
    expect(calls[0]?.featureId).toBe(featureId);
    expect(calls[0]?.branch).toBe(`noetic/${LEAF}`);
    expect(report.implementersStarted).toBe(1);
  });

  it('skips features whose leaf task already has a worktree', async () => {
    const ctx = makeStoreContext();
    const PARENT = 'T-parent0001';
    const LEAF = 'T-leaf000001';
    await seedManualTask(ctx, PARENT, {
      hierarchyStatus: 'active',
    });
    await seedLeafTask(ctx, LEAF, '/repo/.worktrees/already-here');
    const persisted = await persistTaskHierarchy(ctx, PARENT, {
      milestones: [
        {
          title: 'M1',
          verification: 'tests pass',
          slices: [
            {
              title: 'S1',
              verification: 'visible',
              features: [
                {
                  title: 'F1',
                  acceptanceCriteria: 'do X',
                },
              ],
            },
          ],
          assertions: [],
        },
      ],
    });
    const featureId = persisted.features[0]?.id;
    if (featureId === undefined) {
      throw new Error('seed failed');
    }
    const { saveFeature } = await import('../../../src/commands/builtins/tasks/hierarchy/store.js');
    await saveFeature(ctx, PARENT, {
      ...persisted.features[0]!,
      taskId: LEAF,
      loopState: 'implementing',
      status: 'triaged',
    });
    const calls: string[] = [];
    const deps: AutopilotDeps = {
      ctx,
      signaller: fakeSignaller,
      subprocess: createInMemorySubprocessAdapter(),
      startImplementerRun: async (args) => {
        calls.push(args.taskId);
        return {
          sessionId: 'S',
          pid: 0,
          taskId: args.taskId,
          parentTaskId: args.parentTaskId,
          featureId: args.featureId,
          branch: args.branch,
          worktreePath: '',
          provisionTool: 'reused',
        };
      },
    };
    const report = await runAutopilotTick(deps);
    expect(calls).toEqual([]);
    expect(report.implementersStarted).toBe(0);
  });

  it('is a no-op when startImplementerRun is not provided', async () => {
    const ctx = makeStoreContext();
    const PARENT = 'T-parent0002';
    await seedManualTask(ctx, PARENT, {
      hierarchyStatus: 'active',
    });
    const deps: AutopilotDeps = {
      ctx,
      signaller: fakeSignaller,
      subprocess: createInMemorySubprocessAdapter(),
    };
    const report = await runAutopilotTick(deps);
    expect(report.implementersStarted).toBe(0);
  });
});
