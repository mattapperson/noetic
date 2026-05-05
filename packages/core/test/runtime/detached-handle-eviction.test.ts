/**
 * Regression test for C9: `DetachedHandle.pollUntilSettled` must not
 * loop forever when the adapter persistently returns `null` for a
 * handle. Previously the fast-path microtask loop and the slow-path
 * timer loop both silently skipped null handles and kept polling,
 * holding the `.await()` promise open indefinitely on any adapter-state
 * anomaly.
 *
 * The fix: track the first observation of `null` and, if nulls persist
 * past `HANDLE_EVICTED_GRACE_MS`, throw `NoeticError(handle_evicted)`.
 * Non-null observations reset the grace window so a single transient
 * null doesn't blow up a long-running handle.
 */

import { describe, expect, it } from 'bun:test';
import { isNoeticError } from '../../src/errors/noetic-error';
import { DetachedHandleImpl } from '../../src/runtime/detached-handle';
import type { SubprocessAdapter, SubprocessHandle } from '../../src/types/subprocess-adapter';

/**
 * Minimal adapter stub for the eviction test. `pollUntilSettled` only
 * calls `adapter.get`; all other methods would be framework bugs if
 * they fired. We return well-typed no-ops rather than rejecting with
 * typecasts so biome's no-as-unknown rule stays happy.
 */
function makeAdapterReturning(get: () => Promise<SubprocessHandle | null>): SubprocessAdapter {
  return {
    async spawn(): Promise<SubprocessHandle> {
      throw new Error('adapter.spawn should not be called in this test');
    },
    get: async () => get(),
    async stop(handleId) {
      return {
        kind: 'not_found',
        handleId,
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
    isAlive: () => Promise.resolve(true),
    reattach: async () => null,
    listLive: async () => [],
  };
}

function runningHandle(id: string): SubprocessHandle {
  return {
    id,
    status: 'running',
    startedAt: new Date().toISOString(),
    metadata: {},
  };
}

describe('DetachedHandle eviction (C9 regression)', () => {
  it('rejects with handle_evicted when adapter.get persistently returns null', async () => {
    const handleId = 'handle-evicted-1';
    const adapter = makeAdapterReturning(() => Promise.resolve(null));
    const handle = new DetachedHandleImpl<string>({
      id: handleId,
      stepId: 'test-step',
      adapter,
      spawnPromise: Promise.resolve(runningHandle(handleId)),
    });

    let thrown: unknown;
    try {
      await handle.await();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    if (!isNoeticError(thrown)) {
      throw new Error(`expected NoeticError, got ${thrown?.constructor?.name ?? typeof thrown}`);
    }
    expect(thrown.noeticError.kind).toBe('handle_evicted');
    if (thrown.noeticError.kind === 'handle_evicted') {
      expect(thrown.noeticError.handleId).toBe(handleId);
      expect(thrown.noeticError.stepId).toBe('test-step');
    }
  }, 5_000);

  it('tolerates a transient null before the handle settles', async () => {
    // Simulates an adapter that returns null on the first get() call
    // (handle registration raced the spawn promise settling) and then
    // returns the completed handle. The pollUntilSettled loop should
    // reset its grace window on the non-null observation and return
    // the result without raising eviction.
    const handleId = 'handle-transient-null';
    let callCount = 0;
    const adapter = makeAdapterReturning(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        id: handleId,
        status: 'completed',
        startedAt: new Date().toISOString(),
        metadata: {
          result: 'ok',
        },
      });
    });
    const handle = new DetachedHandleImpl<string>({
      id: handleId,
      stepId: 'test-step',
      adapter,
      spawnPromise: Promise.resolve(runningHandle(handleId)),
    });

    const result = await handle.await();
    expect(result).toBe('ok');
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});
