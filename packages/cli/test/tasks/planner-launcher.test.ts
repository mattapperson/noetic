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
import {
  PlannerSpawnError,
  startPlannerRun,
} from '../../src/commands/builtins/tasks/planner-launcher.js';
import { makeTrackingAdapter, preloadLiveHandle } from './_adapter-helpers.js';
import { makeStoreContext } from './_helpers.js';

async function seedManualTask(
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
    hierarchyStatus: null,
    autopilotEnabled: true,
    autopilotState: AutopilotState.Inactive,
    lastAutopilotActivityAt: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  });
}

describe('startPlannerRun', () => {
  it('spawns the runner and flips autopilotState to planning', async () => {
    const ctx = makeStoreContext();
    const taskId = 'T-plan000000';
    await seedManualTask(ctx, taskId);
    const { adapter } = makeTrackingAdapter();

    const result = await startPlannerRun({
      ctx,
      taskId,
      subprocess: adapter,
      now: '2026-05-01T00:00:00.000Z',
      runnerScript: '/abs/planner-runner.ts',
    });

    expect(result.pid).toBe(4242);
    expect(result.previousAutopilotState).toBe(AutopilotState.Inactive);
    expect(result.autopilotState).toBe(AutopilotState.Planning);

    const task = await tryLoadTask(ctx, taskId);
    expect(task?.autopilotState).toBe(AutopilotState.Planning);
    expect(task?.paused).toBe(false);

    const events = await tailEvents(ctx);
    const updated = events.filter((e) => e.kind === EventKind.TaskUpdated && e.taskId === taskId);
    expect(updated.length).toBeGreaterThan(0);
    const spawnEvent = updated.find((e) => e.payload?.phase === 'spawn');
    expect(spawnEvent).toBeDefined();
    expect(spawnEvent?.payload?.autopilotState).toBe(AutopilotState.Planning);
  });

  it('refuses when a live planner handle is already attached', async () => {
    const ctx = makeStoreContext();
    const taskId = 'T-plan000001';
    await seedManualTask(ctx, taskId);
    const adapter = await preloadLiveHandle({
      taskId,
      role: 'planner',
      pid: 9999,
    });

    await expect(
      startPlannerRun({
        ctx,
        taskId,
        subprocess: adapter,
        runnerScript: '/abs/planner-runner.ts',
      }),
    ).rejects.toThrow(PlannerSpawnError);
  });

  it('rejects with PlannerSpawnError when spawn returns no pid', async () => {
    const ctx = makeStoreContext();
    const taskId = 'T-plan000004';
    await seedManualTask(ctx, taskId);
    const noPidAdapter = createInMemorySubprocessAdapter({
      run: async (_request, handle) => {
        // Deliberately clear pid metadata so the launcher's pid check
        // rejects the spawn.
        handle.metadata = {
          ...(handle.metadata ?? {}),
        };
      },
    });
    await expect(
      startPlannerRun({
        ctx,
        taskId,
        subprocess: noPidAdapter,
        runnerScript: '/abs/planner-runner.ts',
      }),
    ).rejects.toThrow(PlannerSpawnError);
  });
});
