import { describe, expect, test } from 'bun:test';
import { saveImplementer } from '../../src/commands/builtins/tasks/implementer-state.js';
import type {
  StartPlannerRunArgs,
  StartPlannerRunResult,
} from '../../src/commands/builtins/tasks/planner-launcher.js';
import {
  PlannerSpawnError,
  PlannerSpawnErrorCode,
} from '../../src/commands/builtins/tasks/planner-launcher.js';
import { savePlanner } from '../../src/commands/builtins/tasks/planner-state.js';
import {
  ensureChatTarget,
  resolveChatTarget,
  waitForChatTarget,
} from '../../src/commands/builtins/tasks/resolve-chat-target.js';
import { makeStoreContext } from './_helpers.js';

const TASK_ID = 'T-aaaaaaaaaa';

// These tests use fake `/sock/*.sock` paths that don't exist on disk,
// so the default reachability probe (real `fs.access`) would reject
// every target. Stubbing "always reachable" keeps the tests focused
// on the sidecar-resolution logic; the socket-reachability contract
// itself is covered in `resolve-chat-target-staleness.test.ts`.
const alwaysReachable = async (): Promise<boolean> => true;

interface FakePlannerSpawn {
  readonly fn: (args: StartPlannerRunArgs) => Promise<StartPlannerRunResult>;
  readonly calls: Array<{
    taskId: string;
  }>;
}

/**
 * Build a fake `startPlannerRun` that records each call and (on success)
 * writes the planner sidecar so a subsequent `resolveChatTarget` poll
 * resolves. Lets `ensureChatTarget` exercise its full flow without
 * actually spawning a child process.
 */
function fakePlannerSpawn(opts: {
  readonly behavior: 'success' | 'already-attached' | 'spawn-failed';
  readonly socketPath?: string;
}): FakePlannerSpawn {
  const calls: Array<{
    taskId: string;
  }> = [];
  const fn = async (args: StartPlannerRunArgs): Promise<StartPlannerRunResult> => {
    calls.push({
      taskId: args.taskId,
    });
    if (opts.behavior === 'already-attached') {
      throw new PlannerSpawnError(PlannerSpawnErrorCode.AlreadyAttached, 'already attached');
    }
    if (opts.behavior === 'spawn-failed') {
      throw new PlannerSpawnError(PlannerSpawnErrorCode.SpawnFailed, 'spawn died');
    }
    await savePlanner(args.ctx, {
      taskId: args.taskId,
      sessionId: 's1',
      pid: 1,
      pidStarttime: null,
      startedAt: '2026-05-02T00:00:00Z',
      pausedAt: null,
      socketPath: opts.socketPath ?? '/sock/p.sock',
    });
    return {
      sessionId: 's1',
      pid: 1,
      taskId: args.taskId,
      previousAutopilotState: 'inactive',
      autopilotState: 'planning',
    };
  };
  return {
    fn,
    calls,
  };
}

describe('ensureChatTarget', () => {
  test('returns immediately and skips onSpawning when target is already live', async () => {
    const ctx = makeStoreContext();
    await savePlanner(ctx, {
      taskId: TASK_ID,
      sessionId: 's1',
      pid: 1,
      pidStarttime: null,
      startedAt: '2026-05-02T00:00:00Z',
      pausedAt: null,
      socketPath: '/sock/already.sock',
    });
    const spawn = fakePlannerSpawn({
      behavior: 'success',
    });
    let spawningFired = 0;
    const got = await ensureChatTarget(ctx, TASK_ID, {
      onSpawning: () => {
        spawningFired += 1;
      },
      startPlannerRunFn: spawn.fn,
      isSocketReachable: alwaysReachable,
    });
    expect(got?.socketPath).toBe('/sock/already.sock');
    expect(spawningFired).toBe(0);
    expect(spawn.calls.length).toBe(0);
  });

  test('spawns planner, fires onSpawning, and returns the bound target', async () => {
    const ctx = makeStoreContext();
    const spawn = fakePlannerSpawn({
      behavior: 'success',
      socketPath: '/sock/fresh.sock',
    });
    let spawningFired = 0;
    const got = await ensureChatTarget(ctx, TASK_ID, {
      onSpawning: () => {
        spawningFired += 1;
      },
      startPlannerRunFn: spawn.fn,
      timeoutMs: 200,
      pollIntervalMs: 10,
      isSocketReachable: alwaysReachable,
    });
    expect(got?.socketPath).toBe('/sock/fresh.sock');
    expect(got?.role).toBe('planner');
    expect(spawningFired).toBe(1);
    expect(spawn.calls).toEqual([
      {
        taskId: TASK_ID,
      },
    ]);
  });

  test('AlreadyAttached falls through to polling and returns when sidecar binds', async () => {
    const ctx = makeStoreContext();
    const spawn = fakePlannerSpawn({
      behavior: 'already-attached',
    });
    setTimeout(() => {
      void savePlanner(ctx, {
        taskId: TASK_ID,
        sessionId: 's1',
        pid: 1,
        pidStarttime: null,
        startedAt: '2026-05-02T00:00:00Z',
        pausedAt: null,
        socketPath: '/sock/inflight.sock',
      });
    }, 30);
    const got = await ensureChatTarget(ctx, TASK_ID, {
      startPlannerRunFn: spawn.fn,
      timeoutMs: 500,
      pollIntervalMs: 10,
      isSocketReachable: alwaysReachable,
    });
    expect(got?.socketPath).toBe('/sock/inflight.sock');
  });

  test('returns null when spawn fails with a non-AlreadyAttached error', async () => {
    const ctx = makeStoreContext();
    const spawn = fakePlannerSpawn({
      behavior: 'spawn-failed',
    });
    const got = await ensureChatTarget(ctx, TASK_ID, {
      startPlannerRunFn: spawn.fn,
      timeoutMs: 50,
      pollIntervalMs: 10,
    });
    expect(got).toBeNull();
  });

  test('returns null when spawn succeeds but socket never binds within timeout', async () => {
    const ctx = makeStoreContext();
    const spawn: FakePlannerSpawn = {
      calls: [],
      fn: async (args) => {
        spawn.calls.push({
          taskId: args.taskId,
        });
        return {
          sessionId: 's1',
          pid: 1,
          taskId: args.taskId,
          previousAutopilotState: 'inactive',
          autopilotState: 'planning',
        };
      },
    };
    const got = await ensureChatTarget(ctx, TASK_ID, {
      startPlannerRunFn: spawn.fn,
      timeoutMs: 30,
      pollIntervalMs: 10,
    });
    expect(got).toBeNull();
    expect(spawn.calls.length).toBe(1);
  });
});

describe('resolveChatTarget', () => {
  test('returns null when no sidecar exists', async () => {
    const ctx = makeStoreContext();
    const got = await resolveChatTarget(ctx, TASK_ID, {
      isSocketReachable: alwaysReachable,
    });
    expect(got).toBeNull();
  });

  test('returns null when planner sidecar has no socketPath yet', async () => {
    const ctx = makeStoreContext();
    await savePlanner(ctx, {
      taskId: TASK_ID,
      sessionId: 's1',
      pid: 1,
      pidStarttime: null,
      startedAt: '2026-05-02T00:00:00Z',
      pausedAt: null,
    });
    const got = await resolveChatTarget(ctx, TASK_ID, {
      isSocketReachable: alwaysReachable,
    });
    expect(got).toBeNull();
  });

  test('returns planner target when planner sidecar has socketPath', async () => {
    const ctx = makeStoreContext();
    await savePlanner(ctx, {
      taskId: TASK_ID,
      sessionId: 's1',
      pid: 1,
      pidStarttime: null,
      startedAt: '2026-05-02T00:00:00Z',
      pausedAt: null,
      socketPath: '/sock/p.sock',
    });
    const got = await resolveChatTarget(ctx, TASK_ID, {
      isSocketReachable: alwaysReachable,
    });
    expect(got).toEqual({
      socketPath: '/sock/p.sock',
      role: 'planner',
      roleLabel: 'planner',
    });
  });

  test('returns implementer target when only implementer sidecar has socketPath', async () => {
    const ctx = makeStoreContext();
    await saveImplementer(ctx, {
      taskId: TASK_ID,
      parentTaskId: 'T-bbbbbbbbbb',
      featureId: 'F-feat-001',
      sessionId: 's1',
      pid: 2,
      pidStarttime: null,
      worktreePath: '/wt',
      branch: 'b',
      startedAt: '2026-05-02T00:00:00Z',
      pausedAt: null,
      socketPath: '/sock/i.sock',
    });
    const got = await resolveChatTarget(ctx, TASK_ID, {
      isSocketReachable: alwaysReachable,
    });
    expect(got).toEqual({
      socketPath: '/sock/i.sock',
      role: 'implementer',
      roleLabel: 'implementer · F-feat-001',
    });
  });

  test('prefers planner over implementer when both have socketPath', async () => {
    const ctx = makeStoreContext();
    await savePlanner(ctx, {
      taskId: TASK_ID,
      sessionId: 's1',
      pid: 1,
      pidStarttime: null,
      startedAt: '2026-05-02T00:00:00Z',
      pausedAt: null,
      socketPath: '/sock/p.sock',
    });
    await saveImplementer(ctx, {
      taskId: TASK_ID,
      parentTaskId: 'T-bbbbbbbbbb',
      featureId: 'F-feat-001',
      sessionId: 's2',
      pid: 2,
      pidStarttime: null,
      worktreePath: '/wt',
      branch: 'b',
      startedAt: '2026-05-02T00:00:00Z',
      pausedAt: null,
      socketPath: '/sock/i.sock',
    });
    const got = await resolveChatTarget(ctx, TASK_ID, {
      isSocketReachable: alwaysReachable,
    });
    expect(got?.role).toBe('planner');
  });
});

describe('waitForChatTarget', () => {
  test('returns the target on the first poll when already available', async () => {
    const ctx = makeStoreContext();
    await savePlanner(ctx, {
      taskId: TASK_ID,
      sessionId: 's1',
      pid: 1,
      pidStarttime: null,
      startedAt: '2026-05-02T00:00:00Z',
      pausedAt: null,
      socketPath: '/sock/p.sock',
    });
    const got = await waitForChatTarget(ctx, TASK_ID, {
      timeoutMs: 100,
      pollIntervalMs: 10,
      isSocketReachable: alwaysReachable,
    });
    expect(got?.socketPath).toBe('/sock/p.sock');
  });

  test('returns null when target never appears within the timeout', async () => {
    const ctx = makeStoreContext();
    const got = await waitForChatTarget(ctx, TASK_ID, {
      timeoutMs: 30,
      pollIntervalMs: 10,
    });
    expect(got).toBeNull();
  });

  test('polls multiple times and returns once the sidecar binds', async () => {
    const ctx = makeStoreContext();
    setTimeout(() => {
      void savePlanner(ctx, {
        taskId: TASK_ID,
        sessionId: 's1',
        pid: 1,
        pidStarttime: null,
        startedAt: '2026-05-02T00:00:00Z',
        pausedAt: null,
        socketPath: '/sock/late.sock',
      });
    }, 30);
    const got = await waitForChatTarget(ctx, TASK_ID, {
      timeoutMs: 500,
      pollIntervalMs: 10,
      isSocketReachable: alwaysReachable,
    });
    expect(got?.socketPath).toBe('/sock/late.sock');
  });
});
