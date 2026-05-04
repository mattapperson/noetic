/**
 * Staleness tests for `resolveChatTarget`.
 *
 * Regression coverage for the "disconnected: connect ENOENT
 * /tmp/.noetic/planner-*.sock" bug: the TUI opened chat on an
 * in-progress task, `resolveChatTarget` returned the `_planner.json`
 * sidecar's `socketPath` verbatim, the TUI connected, and got ENOENT
 * because the runner had exited and unlinked the socket without
 * clearing its sidecar.
 *
 * A target whose socket file doesn't exist on disk is not a valid
 * target — `resolveChatTarget` must treat it as absent and fall
 * through to the next role (or null).
 */

import { describe, expect, test } from 'bun:test';

import { saveImplementer } from '../../src/commands/builtins/tasks/implementer-state.js';
import { savePlanner } from '../../src/commands/builtins/tasks/planner-state.js';
import { resolveChatTarget } from '../../src/commands/builtins/tasks/resolve-chat-target.js';

import { makeStoreContext } from './_helpers.js';

const TASK_ID = 'T-aaaaaaaaaa';
const LIVE_SOCK = '/sock/live.sock';
const DEAD_SOCK = '/sock/dead.sock';

const alwaysLive = async (): Promise<boolean> => true;
const alwaysDead = async (): Promise<boolean> => false;
const onlyLive =
  (liveSet: ReadonlySet<string>) =>
  async (path: string): Promise<boolean> =>
    liveSet.has(path);

describe('resolveChatTarget — socket reachability', () => {
  test('returns null when planner sidecar points at a missing socket file', async () => {
    const ctx = makeStoreContext();
    await savePlanner(ctx, {
      taskId: TASK_ID,
      sessionId: 's1',
      pid: 1,
      pidStarttime: null,
      startedAt: '2026-05-02T00:00:00Z',
      pausedAt: null,
      socketPath: DEAD_SOCK,
    });
    const got = await resolveChatTarget(ctx, TASK_ID, {
      isSocketReachable: alwaysDead,
    });
    expect(got).toBeNull();
  });

  test('falls through to implementer when planner socket is dead but implementer socket is live', async () => {
    const ctx = makeStoreContext();
    await savePlanner(ctx, {
      taskId: TASK_ID,
      sessionId: 's1',
      pid: 1,
      pidStarttime: null,
      startedAt: '2026-05-02T00:00:00Z',
      pausedAt: null,
      socketPath: DEAD_SOCK,
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
      socketPath: LIVE_SOCK,
    });
    const got = await resolveChatTarget(ctx, TASK_ID, {
      isSocketReachable: onlyLive(new Set([LIVE_SOCK])),
    });
    expect(got).toEqual({
      socketPath: LIVE_SOCK,
      role: 'implementer',
      roleLabel: 'implementer · F-feat-001',
    });
  });

  test('returns null when both sidecars point at dead sockets', async () => {
    const ctx = makeStoreContext();
    await savePlanner(ctx, {
      taskId: TASK_ID,
      sessionId: 's1',
      pid: 1,
      pidStarttime: null,
      startedAt: '2026-05-02T00:00:00Z',
      pausedAt: null,
      socketPath: DEAD_SOCK,
    });
    await saveImplementer(ctx, {
      taskId: TASK_ID,
      parentTaskId: 'T-bbbbbbbbbb',
      featureId: 'F-feat-002',
      sessionId: 's2',
      pid: 2,
      pidStarttime: null,
      worktreePath: '/wt',
      branch: 'b',
      startedAt: '2026-05-02T00:00:00Z',
      pausedAt: null,
      socketPath: '/sock/also-dead.sock',
    });
    const got = await resolveChatTarget(ctx, TASK_ID, {
      isSocketReachable: alwaysDead,
    });
    expect(got).toBeNull();
  });

  test('returns planner target when its socket is live', async () => {
    const ctx = makeStoreContext();
    await savePlanner(ctx, {
      taskId: TASK_ID,
      sessionId: 's1',
      pid: 1,
      pidStarttime: null,
      startedAt: '2026-05-02T00:00:00Z',
      pausedAt: null,
      socketPath: LIVE_SOCK,
    });
    const got = await resolveChatTarget(ctx, TASK_ID, {
      isSocketReachable: alwaysLive,
    });
    expect(got).toEqual({
      socketPath: LIVE_SOCK,
      role: 'planner',
      roleLabel: 'planner',
    });
  });

  test('default reachability probe rejects a path that does not exist on real fs', async () => {
    const ctx = makeStoreContext();
    await savePlanner(ctx, {
      taskId: TASK_ID,
      sessionId: 's1',
      pid: 1,
      pidStarttime: null,
      startedAt: '2026-05-02T00:00:00Z',
      pausedAt: null,
      socketPath: '/tmp/.noetic/definitely-not-a-real-socket-xyzzy.sock',
    });
    // No isSocketReachable override — exercises the production default.
    const got = await resolveChatTarget(ctx, TASK_ID);
    expect(got).toBeNull();
  });
});
