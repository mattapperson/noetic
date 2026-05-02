import { describe, expect, it } from 'bun:test';

import { readLog, saveTask, tailEvents } from '../../src/commands/builtins/tasks/fs-store.js';
import { persistTaskHierarchy } from '../../src/commands/builtins/tasks/hierarchy/persist.js';
import { loadFeature } from '../../src/commands/builtins/tasks/hierarchy/store.js';
import { commitExitWrites } from '../../src/commands/builtins/tasks/implementer-runner.js';
import {
  loadImplementer,
  saveImplementer,
} from '../../src/commands/builtins/tasks/implementer-state.js';
import {
  AutopilotState,
  EventKind,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '../../src/commands/builtins/tasks/schemas.js';
import { makeStoreContext } from './_helpers.js';

const PARENT_ID = 'T-parent0000';
const LEAF_ID = 'T-leaf000000';

async function seedHierarchy(ctx: ReturnType<typeof makeStoreContext>): Promise<{
  featureId: string;
}> {
  const now = '2026-05-01T00:00:00.000Z';
  await saveTask(ctx, {
    id: PARENT_ID,
    source: TaskSource.Manual,
    title: 'parent',
    projectRoot: ctx.projectRoot,
    worktreePath: null,
    branch: null,
    headSha: null,
    reviewStatus: TaskReviewStatus.NotStarted,
    lifecycleStatus: TaskLifecycleStatus.Active,
    paused: false,
    pauseReason: null,
    archivedAt: null,
    hierarchyStatus: null,
    autopilotEnabled: true,
    autopilotState: AutopilotState.Watching,
    lastAutopilotActivityAt: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  });
  await saveTask(ctx, {
    id: LEAF_ID,
    source: TaskSource.Worktree,
    title: 'leaf',
    projectRoot: ctx.projectRoot,
    worktreePath: '/repo/.worktrees/feat-x',
    branch: 'feat/x',
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
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  });
  const persisted = await persistTaskHierarchy(ctx, PARENT_ID, {
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
                acceptanceCriteria: 'user can do X',
              },
            ],
          },
        ],
        assertions: [
          {
            title: 'A1',
            assertion: 'X is true',
            featureIndices: [
              0,
            ],
          },
        ],
      },
    ],
  });
  const featureId = persisted.features[0]?.id;
  if (featureId === undefined) {
    throw new Error('failed to seed feature');
  }
  const feature = await loadFeature(ctx, PARENT_ID, featureId);
  if (feature === null) {
    throw new Error('seeded feature missing on reload');
  }
  return {
    featureId,
  };
}

describe('commitExitWrites', () => {
  it('flips the parent feature to validating on completed outcome', async () => {
    const ctx = makeStoreContext();
    const { featureId } = await seedHierarchy(ctx);
    await saveImplementer(ctx, {
      taskId: LEAF_ID,
      parentTaskId: PARENT_ID,
      featureId,
      sessionId: 'S-test',
      pid: 4242,
      pidStarttime: null,
      worktreePath: '/repo/.worktrees/feat-x',
      branch: 'feat/x',
      startedAt: '2026-05-01T00:00:00.000Z',
      pausedAt: null,
    });

    const result = await commitExitWrites({
      ctx,
      leafTaskId: LEAF_ID,
      parentTaskId: PARENT_ID,
      featureId,
      outcome: {
        status: 'completed',
        summary: 'wrote scripts/qa-hello.ts',
      },
    });

    expect(result.loopState).toBe('validating');

    const feature = await loadFeature(ctx, PARENT_ID, featureId);
    expect(feature?.loopState).toBe('validating');

    const events = await tailEvents(ctx);
    const featureEvents = events.filter(
      (e) => e.kind === EventKind.FeatureLoopStateChanged && e.taskId === PARENT_ID,
    );
    const exitEvent = featureEvents.find((e) => e.payload?.phase === 'exit');
    expect(exitEvent).toBeDefined();
    expect(exitEvent?.payload?.loopState).toBe('validating');
    expect(exitEvent?.payload?.featureId).toBe(featureId);
    expect(exitEvent?.payload?.summary).toBe('wrote scripts/qa-hello.ts');

    expect(await loadImplementer(ctx, LEAF_ID)).toBeNull();
  });

  it('marks the feature blocked on blocked outcome with reason', async () => {
    const ctx = makeStoreContext();
    const { featureId } = await seedHierarchy(ctx);
    const result = await commitExitWrites({
      ctx,
      leafTaskId: LEAF_ID,
      parentTaskId: PARENT_ID,
      featureId,
      outcome: {
        status: 'blocked',
        summary: 'agent ran out of steps',
        blockedReason: 'max-steps',
      },
    });
    expect(result.loopState).toBe('blocked');
    const feature = await loadFeature(ctx, PARENT_ID, featureId);
    expect(feature?.loopState).toBe('blocked');
    expect(feature?.blockedReason).toBe('max-steps');
  });

  it('appends a system log entry on the leaf task', async () => {
    const ctx = makeStoreContext();
    const { featureId } = await seedHierarchy(ctx);
    await commitExitWrites({
      ctx,
      leafTaskId: LEAF_ID,
      parentTaskId: PARENT_ID,
      featureId,
      outcome: {
        status: 'completed',
        summary: 'wrote files',
      },
    });
    const log = await readLog(ctx, LEAF_ID);
    const systemEntries = log.filter((e) => e.kind === 'system');
    expect(systemEntries.length).toBeGreaterThan(0);
    const completedEntry = systemEntries.find((e) => e.message.includes('completed'));
    expect(completedEntry).toBeDefined();
    expect(completedEntry?.message).toContain('wrote files');
  });
});
