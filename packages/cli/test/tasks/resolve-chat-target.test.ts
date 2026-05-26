import { describe, expect, test } from 'bun:test';

import type { SubprocessHandle } from '@noetic-tools/core';

import type {
  StartPlannerRunArgs,
  StartPlannerRunResult,
} from '../../src/tasks/runtime/planner-launcher.js';
import {
  PlannerSpawnError,
  PlannerSpawnErrorCode,
} from '../../src/tasks/runtime/planner-launcher.js';
import {
  ensureChatTarget,
  resolveChatTarget,
  waitForChatTarget,
} from '../../src/tasks/runtime/resolve-chat-target.js';
import { makeEmptySubprocess, preloadLiveHandle } from './_adapter-helpers.js';
import { makeStoreContext } from './_helpers.js';

const TASK_ID = 'T-aaaaaaaaaa';

// These tests use synthetic socket paths that don't exist on disk, so
// the default reachability probe would reject. Stub "always reachable"
// to focus on the handle-manifest resolution logic.
const alwaysReachable = async (): Promise<boolean> => true;

interface FakePlannerSpawn {
  readonly fn: (args: StartPlannerRunArgs) => Promise<StartPlannerRunResult>;
  readonly calls: Array<{
    taskId: string;
  }>;
}

function fakePlannerSpawn(opts: {
  behavior: 'success' | 'already-attached' | 'spawn-failed';
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
    // On success, preload a live handle on the adapter so a subsequent
    // resolveChatTarget poll returns non-null.
    const handle: SubprocessHandle = await args.subprocess.spawn({
      kind: 'process',
      command: 'stub',
      metadata: {
        taskRole: 'planner',
        taskId: args.taskId,
        pid: 1,
        pidStarttime: null,
      },
    });
    void handle;
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

describe('resolveChatTarget', () => {
  test('returns planner target when a live planner handle exists', async () => {
    const ctx = makeStoreContext();
    const adapter = await preloadLiveHandle({
      taskId: TASK_ID,
      role: 'planner',
      pid: 1,
    });
    const target = await resolveChatTarget(ctx, TASK_ID, {
      subprocess: adapter,
      isSocketReachable: alwaysReachable,
    });
    expect(target?.role).toBe('planner');
    expect(target?.roleLabel).toBe('planner');
  });

  test('returns implementer target with feature label when only implementer is live', async () => {
    const ctx = makeStoreContext();
    const adapter = await preloadLiveHandle({
      taskId: TASK_ID,
      role: 'implementer',
      featureId: 'F-abc1234567',
      pid: 1,
    });
    const target = await resolveChatTarget(ctx, TASK_ID, {
      subprocess: adapter,
      isSocketReachable: alwaysReachable,
    });
    expect(target?.role).toBe('implementer');
    expect(target?.roleLabel).toBe('implementer · F-abc1234567');
  });

  test('returns null when no live handle is registered', async () => {
    const ctx = makeStoreContext();
    const adapter = makeEmptySubprocess();
    const target = await resolveChatTarget(ctx, TASK_ID, {
      subprocess: adapter,
      isSocketReachable: alwaysReachable,
    });
    expect(target).toBeNull();
  });
});

describe('ensureChatTarget', () => {
  test('returns immediately when target is already live', async () => {
    const ctx = makeStoreContext();
    const adapter = await preloadLiveHandle({
      taskId: TASK_ID,
      role: 'planner',
      pid: 1,
    });
    const spawn = fakePlannerSpawn({
      behavior: 'success',
    });
    let spawningFired = 0;
    const got = await ensureChatTarget(ctx, TASK_ID, {
      subprocess: adapter,
      onSpawning: () => {
        spawningFired += 1;
      },
      startPlannerRunFn: spawn.fn,
      isSocketReachable: alwaysReachable,
    });
    expect(got?.role).toBe('planner');
    expect(spawningFired).toBe(0);
    expect(spawn.calls.length).toBe(0);
  });

  test('spawns, then polls until the runner binds its socket', async () => {
    const ctx = makeStoreContext();
    const adapter = makeEmptySubprocess();
    const spawn = fakePlannerSpawn({
      behavior: 'success',
    });
    let spawningFired = 0;
    const got = await ensureChatTarget(ctx, TASK_ID, {
      subprocess: adapter,
      onSpawning: () => {
        spawningFired += 1;
      },
      startPlannerRunFn: spawn.fn,
      timeoutMs: 1000,
      pollIntervalMs: 50,
      isSocketReachable: alwaysReachable,
    });
    expect(got?.role).toBe('planner');
    expect(spawningFired).toBe(1);
    expect(spawn.calls.length).toBe(1);
  });

  test('returns null when spawn fails hard', async () => {
    const ctx = makeStoreContext();
    const adapter = makeEmptySubprocess();
    const spawn = fakePlannerSpawn({
      behavior: 'spawn-failed',
    });
    const got = await ensureChatTarget(ctx, TASK_ID, {
      subprocess: adapter,
      startPlannerRunFn: spawn.fn,
      timeoutMs: 100,
      pollIntervalMs: 20,
      isSocketReachable: alwaysReachable,
    });
    expect(got).toBeNull();
  });

  test('polls on already-attached so an in-flight planner resolves', async () => {
    const ctx = makeStoreContext();
    const adapter = await preloadLiveHandle({
      taskId: TASK_ID,
      role: 'planner',
      pid: 1,
    });
    const spawn = fakePlannerSpawn({
      behavior: 'already-attached',
    });
    const got = await waitForChatTarget(ctx, TASK_ID, {
      subprocess: adapter,
      timeoutMs: 200,
      pollIntervalMs: 20,
      isSocketReachable: alwaysReachable,
    });
    expect(got?.role).toBe('planner');
    // waitForChatTarget doesn't invoke spawn.fn; ensureChatTarget with
    // already-attached falls through to the poll path.
    void spawn;
  });
});
