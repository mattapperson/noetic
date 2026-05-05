import { describe, expect, it } from 'bun:test';

import type {
  ProcessSignaller,
  SubprocessAdapter,
  SubprocessHandle,
  SubprocessRequest,
} from '@noetic/core';
import { saveTask, tailEvents, tryLoadTask } from '../../src/commands/builtins/tasks/fs-store.js';
import {
  ImplementerSpawnError,
  startImplementerRun,
} from '../../src/commands/builtins/tasks/implementer-launcher.js';
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
import type {
  ProvisionWorktreeArgs,
  ProvisionWorktreeResult,
} from '../../src/commands/builtins/tasks/worktree-provision.js';
import { ProvisionTool } from '../../src/commands/builtins/tasks/worktree-provision.js';
import { makeStoreContext } from './_helpers.js';

interface FakeSignallerOpts {
  readonly liveSet?: ReadonlySet<number>;
  readonly startTimes?: ReadonlyMap<number, string>;
  readonly killed?: Array<{
    target: number;
    signal: string;
  }>;
}

function makeFakeSignaller(opts: FakeSignallerOpts = {}): {
  signaller: ProcessSignaller;
  killed: Array<{
    target: number;
    signal: string;
  }>;
} {
  const killed = opts.killed ?? [];
  const live =
    opts.liveSet ??
    new Set([
      4242,
    ]);
  const startTimes = opts.startTimes ?? new Map();
  return {
    signaller: {
      isAlive: (pid) => live.has(pid),
      startTime: (pid) => startTimes.get(pid) ?? null,
      kill: (target, signal) => {
        killed.push({
          target,
          signal,
        });
      },
    },
    killed,
  };
}

interface FakeSubprocessOpts {
  readonly pid?: number;
  readonly pidStarttime?: string | null;
  readonly alive?: boolean;
  readonly spawnError?: Error;
}

function makeFakeSubprocess(opts: FakeSubprocessOpts = {}): {
  subprocess: SubprocessAdapter;
  requests: SubprocessRequest[];
  stopped: Array<{
    handleId: string;
    reason?: string;
  }>;
} {
  const requests: SubprocessRequest[] = [];
  const stopped: Array<{
    handleId: string;
    reason?: string;
  }> = [];
  const handle: SubprocessHandle = {
    id: 'subprocess-test',
    status: 'running',
    startedAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    metadata: {
      ...(opts.pid === undefined
        ? {}
        : {
            pid: opts.pid,
          }),
      pidStarttime: opts.pidStarttime ?? null,
    },
  };
  return {
    requests,
    stopped,
    subprocess: {
      async spawn(request) {
        requests.push(request);
        if (opts.spawnError) {
          throw opts.spawnError;
        }
        return handle;
      },
      async get(handleId) {
        return handleId === handle.id ? handle : null;
      },
      async stop(handleId, reason) {
        stopped.push({
          handleId,
          reason,
        });
        return {
          kind: 'stopped',
          handleId,
          handle: {
            ...handle,
            status: 'stopped',
          },
        };
      },
      async pause(handleId) {
        return {
          kind: 'not_found',
          handleId,
        };
      },
      async resume(handleId) {
        return {
          kind: 'not_found',
          handleId,
        };
      },
      async isAlive() {
        return opts.alive ?? true;
      },
    },
  };
}

function fakeProvision(result: Partial<ProvisionWorktreeResult> = {}) {
  return async (args: ProvisionWorktreeArgs): Promise<ProvisionWorktreeResult> => ({
    worktreePath: result.worktreePath ?? `/repo/.worktrees/${args.branch}`,
    branch: result.branch ?? args.branch,
    tool: result.tool ?? ProvisionTool.Git,
  });
}

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
    source: TaskSource.Worktree,
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

describe('startImplementerRun', () => {
  it('provisions a worktree, writes the sidecar, and emits feature:loopStateChanged{spawn}', async () => {
    const ctx = makeStoreContext();
    const leafId = 'T-leaf000000';
    await seedLeafTask(ctx, leafId);
    const { signaller } = makeFakeSignaller();
    const { subprocess, requests } = makeFakeSubprocess({
      pid: 4242,
    });

    const result = await startImplementerRun({
      ctx,
      taskId: leafId,
      parentTaskId: 'T-parent0000',
      featureId: 'F-abc1234567',
      branch: 'feat/x',
      now: '2026-05-01T00:00:00.000Z',
      runnerScript: '/abs/runner.ts',
      provisionFn: fakeProvision(),
      subprocess,
      signaller,
      env: {
        FOO: 'bar',
      },
    });

    expect(result.pid).toBe(4242);
    expect(result.worktreePath).toBe('/repo/.worktrees/feat/x');
    expect(result.branch).toBe('feat/x');
    expect(result.provisionTool).toBe(ProvisionTool.Git);
    expect(result.featureId).toBe('F-abc1234567');
    expect(result.taskId).toBe(leafId);
    expect(requests[0]?.command).toBe('bun');
    expect(requests[0]?.args).toEqual([
      'run',
      '/abs/runner.ts',
    ]);
    expect(requests[0]?.cwd).toBe('/repo/.worktrees/feat/x');
    expect(requests[0]?.detached).toBe(true);
    expect(requests[0]?.env?.FOO).toBe('bar');
    expect(requests[0]?.env?.NOETIC_FEATURE_ID).toBe('F-abc1234567');

    const sidecar = await loadImplementer(ctx, leafId);
    expect(sidecar?.pid).toBe(4242);
    expect(sidecar?.worktreePath).toBe('/repo/.worktrees/feat/x');
    expect(sidecar?.branch).toBe('feat/x');
    expect(sidecar?.featureId).toBe('F-abc1234567');
    expect(sidecar?.parentTaskId).toBe('T-parent0000');

    const leaf = await tryLoadTask(ctx, leafId);
    expect(leaf?.worktreePath).toBe('/repo/.worktrees/feat/x');
    expect(leaf?.branch).toBe('feat/x');

    const events = await tailEvents(ctx);
    const updated = events.filter((e) => e.kind === EventKind.TaskUpdated && e.taskId === leafId);
    expect(updated.length).toBeGreaterThan(0);
    expect(updated[0]?.payload?.worktreePath).toBe('/repo/.worktrees/feat/x');

    const featureEvents = events.filter(
      (e) => e.kind === EventKind.FeatureLoopStateChanged && e.taskId === 'T-parent0000',
    );
    expect(featureEvents.length).toBe(1);
    expect(featureEvents[0]?.payload?.phase).toBe('spawn');
    expect(featureEvents[0]?.payload?.featureId).toBe('F-abc1234567');
    expect(featureEvents[0]?.payload?.loopState).toBe('implementing');
  });

  it('refuses when a live implementer is already attached', async () => {
    const ctx = makeStoreContext();
    const leafId = 'T-leaf000001';
    await seedLeafTask(ctx, leafId);
    await saveImplementer(ctx, {
      taskId: leafId,
      parentTaskId: 'T-parent0000',
      featureId: 'F-abc1234567',
      sessionId: 'S-prior',
      pid: 9999,
      pidStarttime: 'Mon Jan  1 00:00:00 2026',
      worktreePath: '/repo/.worktrees/feat/x',
      branch: 'feat/x',
      startedAt: '2026-05-01T00:00:00.000Z',
      pausedAt: null,
    });
    const { signaller } = makeFakeSignaller({
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
    const { subprocess, requests } = makeFakeSubprocess();

    let provisionCalls = 0;
    await expect(
      startImplementerRun({
        ctx,
        taskId: leafId,
        parentTaskId: 'T-parent0000',
        featureId: 'F-abc1234567',
        branch: 'feat/x',
        runnerScript: '/abs/runner.ts',
        provisionFn: async (args) => {
          provisionCalls += 1;
          return {
            worktreePath: `/repo/.worktrees/${args.branch}`,
            branch: args.branch,
            tool: ProvisionTool.Git,
          };
        },
        subprocess,
        signaller,
      }),
    ).rejects.toThrow(ImplementerSpawnError);
    // Provision should not be reached when a live sidecar is already attached.
    expect(provisionCalls).toBe(0);
    expect(requests).toEqual([]);
  });

  it('overwrites a stale sidecar (dead pid)', async () => {
    const ctx = makeStoreContext();
    const leafId = 'T-leaf000002';
    await seedLeafTask(ctx, leafId);
    await saveImplementer(ctx, {
      taskId: leafId,
      parentTaskId: 'T-parent0000',
      featureId: 'F-abc1234567',
      sessionId: 'S-stale',
      pid: 9999,
      pidStarttime: null,
      worktreePath: '/repo/.worktrees/feat/x',
      branch: 'feat/x',
      startedAt: '2026-05-01T00:00:00.000Z',
      pausedAt: null,
    });
    const { signaller } = makeFakeSignaller({
      liveSet: new Set([
        4242,
      ]),
    });
    const { subprocess } = makeFakeSubprocess({
      pid: 4242,
    });
    const result = await startImplementerRun({
      ctx,
      taskId: leafId,
      parentTaskId: 'T-parent0000',
      featureId: 'F-abc1234567',
      branch: 'feat/x',
      runnerScript: '/abs/runner.ts',
      provisionFn: fakeProvision(),
      subprocess,
      signaller,
    });
    expect(result.pid).toBe(4242);
    const sidecar = await loadImplementer(ctx, leafId);
    expect(sidecar?.sessionId).not.toBe('S-stale');
  });

  it('overwrites a sidecar whose pid was recycled (live, but mismatched startTime)', async () => {
    const ctx = makeStoreContext();
    const leafId = 'T-leaf000006';
    await seedLeafTask(ctx, leafId);
    await saveImplementer(ctx, {
      taskId: leafId,
      parentTaskId: 'T-parent0000',
      featureId: 'F-abc1234567',
      sessionId: 'S-recycled',
      pid: 4242,
      pidStarttime: 'Mon Jan  1 00:00:00 2026',
      worktreePath: '/repo/.worktrees/feat/x',
      branch: 'feat/x',
      startedAt: '2026-05-01T00:00:00.000Z',
      pausedAt: null,
    });
    // pid 4242 IS alive, but its current startTime is *different* from
    // the recorded one — that means the kernel recycled the pid.
    const { signaller } = makeFakeSignaller({
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
    const { subprocess } = makeFakeSubprocess({
      pid: 4242,
    });
    const result = await startImplementerRun({
      ctx,
      taskId: leafId,
      parentTaskId: 'T-parent0000',
      featureId: 'F-abc1234567',
      branch: 'feat/x',
      runnerScript: '/abs/runner.ts',
      provisionFn: fakeProvision(),
      subprocess,
      signaller,
    });
    expect(result.pid).toBe(4242);
    const sidecar = await loadImplementer(ctx, leafId);
    expect(sidecar?.sessionId).not.toBe('S-recycled');
  });

  it('rejects with ImplementerSpawnError when spawn returns no pid', async () => {
    const ctx = makeStoreContext();
    const leafId = 'T-leaf000003';
    await seedLeafTask(ctx, leafId);
    const { signaller, killed } = makeFakeSignaller();
    const { subprocess, stopped } = makeFakeSubprocess();
    await expect(
      startImplementerRun({
        ctx,
        taskId: leafId,
        parentTaskId: 'T-parent0000',
        featureId: 'F-abc1234567',
        branch: 'feat/x',
        runnerScript: '/abs/runner.ts',
        provisionFn: fakeProvision(),
        subprocess,
        signaller,
      }),
    ).rejects.toThrow(ImplementerSpawnError);
    // No sidecar should exist when spawn fails this early.
    expect(await loadImplementer(ctx, leafId)).toBeNull();
    expect(killed).toEqual([]);
    expect(stopped[0]?.reason).toBe('missing pid metadata');
  });

  it('rejects with ImplementerSpawnError when worktree provisioning fails', async () => {
    const ctx = makeStoreContext();
    const leafId = 'T-leaf000004';
    await seedLeafTask(ctx, leafId);
    const { signaller } = makeFakeSignaller();
    const { subprocess } = makeFakeSubprocess();
    await expect(
      startImplementerRun({
        ctx,
        taskId: leafId,
        parentTaskId: 'T-parent0000',
        featureId: 'F-abc1234567',
        branch: 'feat/x',
        runnerScript: '/abs/runner.ts',
        provisionFn: async () => {
          throw new Error('disk full');
        },
        subprocess,
        signaller,
      }),
    ).rejects.toThrow(ImplementerSpawnError);
    expect(await loadImplementer(ctx, leafId)).toBeNull();
  });

  it('rejects empty branch and empty featureId', async () => {
    const ctx = makeStoreContext();
    const leafId = 'T-leaf000005';
    await seedLeafTask(ctx, leafId);
    const { signaller } = makeFakeSignaller();
    const { subprocess } = makeFakeSubprocess();
    await expect(
      startImplementerRun({
        ctx,
        taskId: leafId,
        parentTaskId: 'T-parent0000',
        featureId: 'F-abc1234567',
        branch: '   ',
        provisionFn: fakeProvision(),
        subprocess,
        signaller,
      }),
    ).rejects.toThrow(/branch is required/);
    await expect(
      startImplementerRun({
        ctx,
        taskId: leafId,
        parentTaskId: 'T-parent0000',
        featureId: '',
        branch: 'feat/x',
        provisionFn: fakeProvision(),
        subprocess,
        signaller,
      }),
    ).rejects.toThrow(/featureId is required/);
  });
});
