import { describe, expect, it } from 'bun:test';
import {
  AutopilotState,
  EventKind,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '@noetic/code-agent/tasks/schema';
import { saveTask, tailEvents, tryLoadTask } from '@noetic/code-agent/tasks/store/fs-node';
import { createInMemorySubprocessAdapter } from '@noetic/core';
import { persistTaskHierarchy } from '../../src/tasks/runtime/hierarchy/persist.js';
import {
  ImplementerSpawnError,
  startImplementerRun,
} from '../../src/tasks/runtime/implementer-launcher.js';
import { fakeProvision, makeTrackingAdapter, preloadLiveHandle } from './_adapter-helpers.js';
import { makeStoreContext } from './_helpers.js';

async function seedLeafTask(
  ctx: {
    fs: import('@noetic/core').FsAdapter;
    projectRoot: string;
  },
  id: string,
): Promise<void> {
  const now = new Date().toISOString();
  await saveTask(ctx, {
    id,
    source: TaskSource.Manual,
    title: `leaf-${id}`,
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
    autopilotEnabled: false,
    autopilotState: AutopilotState.Inactive,
    lastAutopilotActivityAt: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  });
}

async function seedStructuredTaskWithFeature(
  ctx: {
    fs: import('@noetic/core').FsAdapter;
    projectRoot: string;
  },
  structuredTaskId: string,
  featureId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await saveTask(ctx, {
    id: structuredTaskId,
    source: TaskSource.Manual,
    title: `parent-${structuredTaskId}`,
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
    autopilotState: AutopilotState.Inactive,
    lastAutopilotActivityAt: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  });
  await persistTaskHierarchy(ctx, structuredTaskId, {
    milestones: [
      {
        title: 'M1',
        description: null,
        verification: 'v',
        slices: [
          {
            title: 'S1',
            description: null,
            verification: 'v',
            features: [
              {
                title: 'F1',
                description: null,
                acceptanceCriteria: 'ac',
              },
            ],
          },
        ],
        assertions: [],
      },
    ],
  });
  // Force the feature id so tests can reference it deterministically.
  void featureId;
}

describe('startImplementerRun', () => {
  it('provisions a worktree and emits feature:loopStateChanged{spawn}', async () => {
    const ctx = makeStoreContext();
    const leafId = 'T-leaf000000';
    const parentId = 'T-parent0000';
    const featureId = 'F-abc1234567';
    await seedLeafTask(ctx, leafId);
    await seedStructuredTaskWithFeature(ctx, parentId, featureId);
    const tracker = makeTrackingAdapter({
      pid: 5151,
      pidStarttime: null,
    });

    const result = await startImplementerRun({
      ctx,
      taskId: leafId,
      parentTaskId: parentId,
      featureId,
      branch: 'feat/x',
      subprocess: tracker.adapter,
      provisionFn: fakeProvision(),
      now: '2026-05-01T00:00:00.000Z',
      runnerScript: '/abs/implementer-runner.ts',
    });

    expect(result.pid).toBe(5151);
    expect(result.branch).toBe('feat/x');
    expect(result.worktreePath.endsWith('feat-x')).toBe(true);

    const leaf = await tryLoadTask(ctx, leafId);
    expect(leaf?.branch).toBe('feat/x');
    expect(leaf?.worktreePath).not.toBeNull();

    const events = await tailEvents(ctx);
    const loopStateChanged = events.filter(
      (e) => e.kind === EventKind.FeatureLoopStateChanged && e.taskId === parentId,
    );
    expect(loopStateChanged.length).toBeGreaterThan(0);
  });

  it('refuses when a live implementer handle is already attached', async () => {
    const ctx = makeStoreContext();
    const leafId = 'T-leaf000001';
    const parentId = 'T-parent0001';
    const featureId = 'F-abc1234568';
    await seedLeafTask(ctx, leafId);
    await seedStructuredTaskWithFeature(ctx, parentId, featureId);
    const adapter = await preloadLiveHandle({
      taskId: leafId,
      featureId,
      role: 'implementer',
      pid: 9999,
    });

    await expect(
      startImplementerRun({
        ctx,
        taskId: leafId,
        parentTaskId: parentId,
        featureId,
        branch: 'feat/x',
        subprocess: adapter,
        provisionFn: fakeProvision(),
        runnerScript: '/abs/implementer-runner.ts',
      }),
    ).rejects.toThrow(ImplementerSpawnError);
  });

  it('rejects with ImplementerSpawnError when spawn returns no pid', async () => {
    const ctx = makeStoreContext();
    const leafId = 'T-leaf000002';
    const parentId = 'T-parent0002';
    const featureId = 'F-abc1234569';
    await seedLeafTask(ctx, leafId);
    await seedStructuredTaskWithFeature(ctx, parentId, featureId);
    const noPidAdapter = createInMemorySubprocessAdapter({
      run: async (_request, handle) => {
        handle.metadata = {
          ...(handle.metadata ?? {}),
        };
      },
    });
    await expect(
      startImplementerRun({
        ctx,
        taskId: leafId,
        parentTaskId: parentId,
        featureId,
        branch: 'feat/x',
        subprocess: noPidAdapter,
        provisionFn: fakeProvision(),
        runnerScript: '/abs/implementer-runner.ts',
      }),
    ).rejects.toThrow(ImplementerSpawnError);
  });

  it('rejects with ImplementerSpawnError when worktree provisioning fails', async () => {
    const ctx = makeStoreContext();
    const leafId = 'T-leaf000003';
    const parentId = 'T-parent0003';
    const featureId = 'F-abc123456a';
    await seedLeafTask(ctx, leafId);
    await seedStructuredTaskWithFeature(ctx, parentId, featureId);
    const tracker = makeTrackingAdapter();
    await expect(
      startImplementerRun({
        ctx,
        taskId: leafId,
        parentTaskId: parentId,
        featureId,
        branch: 'feat/x',
        subprocess: tracker.adapter,
        provisionFn: async () => {
          throw new Error('provision failed');
        },
        runnerScript: '/abs/implementer-runner.ts',
      }),
    ).rejects.toThrow(ImplementerSpawnError);
    expect(tracker.spawnCount()).toBe(0);
  });

  it('rejects empty branch and empty featureId', async () => {
    const ctx = makeStoreContext();
    const leafId = 'T-leaf000004';
    const parentId = 'T-parent0004';
    const featureId = 'F-abc123456b';
    await seedLeafTask(ctx, leafId);
    await seedStructuredTaskWithFeature(ctx, parentId, featureId);
    const tracker = makeTrackingAdapter();
    await expect(
      startImplementerRun({
        ctx,
        taskId: leafId,
        parentTaskId: parentId,
        featureId,
        branch: '   ',
        subprocess: tracker.adapter,
        provisionFn: fakeProvision(),
        runnerScript: '/abs/implementer-runner.ts',
      }),
    ).rejects.toThrow(ImplementerSpawnError);
    await expect(
      startImplementerRun({
        ctx,
        taskId: leafId,
        parentTaskId: parentId,
        featureId: '',
        branch: 'feat/x',
        subprocess: tracker.adapter,
        provisionFn: fakeProvision(),
        runnerScript: '/abs/implementer-runner.ts',
      }),
    ).rejects.toThrow(ImplementerSpawnError);
  });
});
