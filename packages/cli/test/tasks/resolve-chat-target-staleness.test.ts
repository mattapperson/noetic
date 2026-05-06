/**
 * Staleness tests for `resolveChatTarget`.
 *
 * Regression coverage for the "disconnected: connect ENOENT
 * /tmp/.noetic/planner-*.sock" bug: the TUI opened chat on an
 * in-progress task, `resolveChatTarget` returned a deterministic
 * socket path, the TUI connected, and got ENOENT because the runner
 * had exited and unlinked the socket without clearing its handle
 * manifest entry.
 *
 * A target whose socket file doesn't exist on disk is not a valid
 * target — `resolveChatTarget` must treat it as absent and fall
 * through to the next role (or null).
 */

import { describe, expect, test } from 'bun:test';

import { resolveChatTarget } from '../../src/tasks/runtime/resolve-chat-target.js';
import { preloadLiveHandles } from './_adapter-helpers.js';
import { makeStoreContext } from './_helpers.js';

const TASK_ID = 'T-aaaaaaaaaa';

const alwaysDead = async (): Promise<boolean> => false;
const onlyLive =
  (liveSet: ReadonlySet<string>) =>
  async (path: string): Promise<boolean> =>
    liveSet.has(path);

describe('resolveChatTarget — socket reachability', () => {
  test('returns null when planner handle is live but its socket is unreachable', async () => {
    const ctx = makeStoreContext();
    const subprocess = await preloadLiveHandles([
      {
        role: 'planner',
        taskId: TASK_ID,
      },
    ]);
    const got = await resolveChatTarget(ctx, TASK_ID, {
      subprocess,
      isSocketReachable: alwaysDead,
    });
    expect(got).toBeNull();
  });

  test('falls through to implementer when planner socket is dead but implementer socket is live', async () => {
    const ctx = makeStoreContext();
    const subprocess = await preloadLiveHandles([
      {
        role: 'planner',
        taskId: TASK_ID,
      },
      {
        role: 'implementer',
        taskId: TASK_ID,
        featureId: 'F-abc1234567',
      },
    ]);
    // Compute the deterministic implementer socket path for the test
    // fixture. resolve-chat-target.ts reconstructs this from
    // runnerSocketPath; we just need it to be in the "live" set.
    const implementerSocketPath = (
      await import('@noetic/code-agent/tasks/store/fs-node')
    ).runnerSocketPath(ctx, {
      taskId: TASK_ID,
      role: 'implementer',
      runnerId: 'F-abc1234567',
    });
    const got = await resolveChatTarget(ctx, TASK_ID, {
      subprocess,
      isSocketReachable: onlyLive(
        new Set([
          implementerSocketPath,
        ]),
      ),
    });
    expect(got?.role).toBe('implementer');
    expect(got?.socketPath).toBe(implementerSocketPath);
  });

  test('returns null when both planner and implementer sockets are unreachable', async () => {
    const ctx = makeStoreContext();
    const subprocess = await preloadLiveHandles([
      {
        role: 'planner',
        taskId: TASK_ID,
      },
      {
        role: 'implementer',
        taskId: TASK_ID,
        featureId: 'F-abc1234567',
      },
    ]);
    const got = await resolveChatTarget(ctx, TASK_ID, {
      subprocess,
      isSocketReachable: alwaysDead,
    });
    expect(got).toBeNull();
  });

  test('prefers planner when both are reachable', async () => {
    const ctx = makeStoreContext();
    const subprocess = await preloadLiveHandles([
      {
        role: 'planner',
        taskId: TASK_ID,
      },
      {
        role: 'implementer',
        taskId: TASK_ID,
        featureId: 'F-abc1234567',
      },
    ]);
    const got = await resolveChatTarget(ctx, TASK_ID, {
      subprocess,
      isSocketReachable: async () => true,
    });
    expect(got?.role).toBe('planner');
  });
});
