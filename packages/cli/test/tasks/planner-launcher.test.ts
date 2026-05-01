import { describe, expect, it } from 'bun:test';

import type { Signaller } from '../../src/commands/builtins/tasks/agent-ci-control.js';
import { saveTask, tailEvents, tryLoadTask } from '../../src/commands/builtins/tasks/fs-store.js';
import {
  PlannerSpawnError,
  startPlannerRun,
} from '../../src/commands/builtins/tasks/planner-launcher.js';
import { loadPlanner, savePlanner } from '../../src/commands/builtins/tasks/planner-state.js';
import {
  AutopilotState,
  EventKind,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '../../src/commands/builtins/tasks/schemas.js';
import { makeStoreContext } from './_helpers.js';

interface FakeSignallerOpts {
  readonly liveSet?: ReadonlySet<number>;
  readonly startTimes?: ReadonlyMap<number, string>;
}

function makeFakeSignaller(opts: FakeSignallerOpts = {}): Signaller {
  const live =
    opts.liveSet ??
    new Set([
      4242,
    ]);
  const startTimes = opts.startTimes ?? new Map();
  return {
    isAlive: (pid) => live.has(pid),
    startTime: (pid) => startTimes.get(pid) ?? null,
    kill: () => {},
  };
}

interface FakeChildOpts {
  readonly pid?: number;
}

function makeFakeChild(opts: FakeChildOpts = {}) {
  return {
    pid: opts.pid ?? 4242,
    unref: () => {},
    on: () => undefined,
  };
}

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
  it('spawns the runner, writes the sidecar, and flips autopilotState to planning', async () => {
    const ctx = makeStoreContext();
    const taskId = 'T-plan000000';
    await seedManualTask(ctx, taskId);
    const signaller = makeFakeSignaller();

    const result = await startPlannerRun({
      ctx,
      taskId,
      now: '2026-05-01T00:00:00.000Z',
      runnerScript: '/abs/planner-runner.ts',
      spawnFn: () => makeFakeChild(),
      signaller,
    });

    expect(result.pid).toBe(4242);
    expect(result.previousAutopilotState).toBe(AutopilotState.Inactive);
    expect(result.autopilotState).toBe(AutopilotState.Planning);

    const sidecar = await loadPlanner(ctx, taskId);
    expect(sidecar?.pid).toBe(4242);
    expect(sidecar?.sessionId).toBe(result.sessionId);

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

  it('refuses when a live planner is already attached', async () => {
    const ctx = makeStoreContext();
    const taskId = 'T-plan000001';
    await seedManualTask(ctx, taskId);
    await savePlanner(ctx, {
      taskId,
      sessionId: 'S-prior',
      pid: 9999,
      pidStarttime: 'Mon Jan  1 00:00:00 2026',
      startedAt: '2026-05-01T00:00:00.000Z',
      pausedAt: null,
    });
    const signaller = makeFakeSignaller({
      liveSet: new Set([
        9999,
      ]),
      startTimes: new Map([
        [
          9999,
          'Mon Jan  1 00:00:00 2026',
        ],
      ]),
    });
    let spawnCalls = 0;
    await expect(
      startPlannerRun({
        ctx,
        taskId,
        runnerScript: '/abs/planner-runner.ts',
        spawnFn: () => {
          spawnCalls += 1;
          return makeFakeChild();
        },
        signaller,
      }),
    ).rejects.toThrow(PlannerSpawnError);
    expect(spawnCalls).toBe(0);
  });

  it('overwrites a stale sidecar (dead pid)', async () => {
    const ctx = makeStoreContext();
    const taskId = 'T-plan000002';
    await seedManualTask(ctx, taskId);
    await savePlanner(ctx, {
      taskId,
      sessionId: 'S-stale',
      pid: 9999,
      pidStarttime: null,
      startedAt: '2026-05-01T00:00:00.000Z',
      pausedAt: null,
    });
    const signaller = makeFakeSignaller({
      liveSet: new Set([
        4242,
      ]),
    });
    const result = await startPlannerRun({
      ctx,
      taskId,
      runnerScript: '/abs/planner-runner.ts',
      spawnFn: () => makeFakeChild(),
      signaller,
    });
    expect(result.pid).toBe(4242);
    const sidecar = await loadPlanner(ctx, taskId);
    expect(sidecar?.sessionId).not.toBe('S-stale');
  });

  it('overwrites a recycled-pid sidecar (live but mismatched startTime)', async () => {
    const ctx = makeStoreContext();
    const taskId = 'T-plan000003';
    await seedManualTask(ctx, taskId);
    await savePlanner(ctx, {
      taskId,
      sessionId: 'S-recycled',
      pid: 4242,
      pidStarttime: 'Mon Jan  1 00:00:00 2026',
      startedAt: '2026-05-01T00:00:00.000Z',
      pausedAt: null,
    });
    const signaller = makeFakeSignaller({
      liveSet: new Set([
        4242,
      ]),
      startTimes: new Map([
        [
          4242,
          'Mon Feb  1 00:00:00 2026',
        ],
      ]),
    });
    const result = await startPlannerRun({
      ctx,
      taskId,
      runnerScript: '/abs/planner-runner.ts',
      spawnFn: () => makeFakeChild(),
      signaller,
    });
    expect(result.pid).toBe(4242);
    const sidecar = await loadPlanner(ctx, taskId);
    expect(sidecar?.sessionId).not.toBe('S-recycled');
  });

  it('rejects with PlannerSpawnError when spawn returns no pid', async () => {
    const ctx = makeStoreContext();
    const taskId = 'T-plan000004';
    await seedManualTask(ctx, taskId);
    const signaller = makeFakeSignaller();
    await expect(
      startPlannerRun({
        ctx,
        taskId,
        runnerScript: '/abs/planner-runner.ts',
        spawnFn: () => ({
          pid: undefined,
          unref: () => {},
          on: () => undefined,
        }),
        signaller,
      }),
    ).rejects.toThrow(PlannerSpawnError);
    expect(await loadPlanner(ctx, taskId)).toBeNull();
  });
});
