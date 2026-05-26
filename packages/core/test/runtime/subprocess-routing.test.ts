/**
 * Regression suite for Phase A's adapter-routing refactor.
 *
 * Covers the three invariants the plan called out:
 *   1. Zero-arg `detachedSpawn` with a synchronously-throwing step rejects
 *      `.await()` with the same error shape as the pre-refactor path.
 *   2. A step declaring `subprocess: B` runs through B, not the harness's
 *      default adapter A.
 *   3. Per-call `detachedSpawn({subprocess: B})` overrides both the step
 *      default and the harness default.
 *   4. `.await(timeout)` rejects on a never-settling adapter and does not
 *      transition the handle into `completed`.
 *
 * The fourth case has a dedicated unit next to the existing DetachedHandle
 * tests; this file focuses on adapter routing end-to-end from `detachedSpawn`.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { createInMemorySubprocessAdapter } from '../../src/adapters/in-memory-subprocess-adapter';
import { isNoeticError } from '../../src/errors/noetic-error';
import { AgentHarness } from '../../src/harness/agent-harness';
import type { ContextMemory } from '../../src/types/memory';
import type { Step } from '../../src/types/step';
import type {
  StepSubprocessRequest,
  SubprocessAdapter,
  SubprocessHandle,
  SubprocessRequest,
} from '../../src/types/subprocess-adapter';

//#region Recording adapter

interface RecordingAdapter extends SubprocessAdapter {
  readonly requests: ReadonlyArray<SubprocessRequest>;
}

function createRecordingAdapter(label: string): RecordingAdapter {
  const base = createInMemorySubprocessAdapter();
  const log: SubprocessRequest[] = [];
  const wrapped: RecordingAdapter = {
    get requests() {
      return log;
    },
    async spawn(request) {
      log.push(request);
      return base.spawn(request);
    },
    get(handleId) {
      return base.get(handleId);
    },
    stop(handleId, reason) {
      return base.stop(handleId, reason);
    },
    pause(handleId) {
      return base.pause(handleId);
    },
    resume(handleId) {
      return base.resume(handleId);
    },
    isAlive(handle) {
      return base.isAlive(handle);
    },
    reattach(handleId) {
      return base.reattach(handleId);
    },
    listLive() {
      return base.listLive();
    },
  };
  // The label is retained as a metadata-level diagnostic so a failing
  // assertion points at the right adapter.
  Object.defineProperty(wrapped, 'label', {
    value: label,
    enumerable: false,
  });
  return wrapped;
}

//#endregion

//#region Tests

describe('Phase A adapter routing', () => {
  it('detachedSpawn on a synchronously-throwing step rejects .await()', async () => {
    const harness = new AgentHarness({
      name: 'throws-harness',
      params: {},
    });
    const ctx = harness.createContext();
    const step: Step<ContextMemory, string, string> = {
      kind: 'run',
      id: 'throws-sync',
      execute: () => {
        throw new Error('sync boom');
      },
    };

    const handle = harness.detachedSpawn(step, 'irrelevant', ctx);
    try {
      await handle.await();
      expect.unreachable('await() should have rejected');
    } catch (err) {
      // `execute-run.ts` wraps the synchronous throw in a
      // `NoeticError(step_failed)`. After the adapter round-trip we should
      // still surface the same typed error (rehydrated from
      // `handle.metadata.error.noeticError`).
      assert(isNoeticError(err));
      const ne = err.noeticError;
      assert(ne.kind === 'step_failed');
      expect(ne.stepId).toBe('throws-sync');
      expect(ne.cause.message).toBe('sync boom');
    }
  });

  it('per-step subprocess override: step.subprocess wins over harness default', async () => {
    const adapterA = createRecordingAdapter('A');
    const adapterB = createRecordingAdapter('B');
    const harness = new AgentHarness({
      name: 'per-step-override',
      params: {},
      subprocess: adapterA,
    });
    const ctx = harness.createContext();
    const step: Step<ContextMemory, string, string> = {
      kind: 'run',
      id: 'per-step-step',
      execute: async (input) => `echo:${input}`,
      subprocess: adapterB,
    };

    const handle = harness.detachedSpawn(step, 'hello', ctx);
    const result = await handle.await();

    expect(result).toBe('echo:hello');
    expect(adapterA.requests.length).toBe(0);
    expect(adapterB.requests.length).toBe(1);
    const received = adapterB.requests[0];
    assert(received !== undefined);
    assert(received.kind === 'step');
    const req: StepSubprocessRequest = received;
    expect(req.stepId).toBe('per-step-step');
    expect(req.serializedInput).toBe('hello');
  });

  it('per-call subprocess override: detachedSpawn overrides both step + harness defaults', async () => {
    const adapterA = createRecordingAdapter('A');
    const adapterB = createRecordingAdapter('B');
    const adapterC = createRecordingAdapter('C');
    const harness = new AgentHarness({
      name: 'per-call-override',
      params: {},
      subprocess: adapterA,
    });
    const ctx = harness.createContext();
    const step: Step<ContextMemory, string, string> = {
      kind: 'run',
      id: 'per-call-step',
      execute: async (input) => `echo:${input}`,
      subprocess: adapterB,
    };

    const handle = harness.detachedSpawn(step, 'hi', ctx, {
      subprocess: adapterC,
    });
    const result = await handle.await();

    expect(result).toBe('echo:hi');
    expect(adapterA.requests.length).toBe(0);
    expect(adapterB.requests.length).toBe(0);
    expect(adapterC.requests.length).toBe(1);
    const received = adapterC.requests[0];
    assert(received !== undefined);
    assert(received.kind === 'step');
    expect(received.stepId).toBe('per-call-step');
  });

  it('never-settling adapter: await(timeout) rejects and handle does not transition to completed', async () => {
    // Build an adapter that registers the handle as `running` and never
    // transitions it. `.await(50)` should reject with a NoeticError and the
    // handle must not reach `completed` even after the timeout fires.
    const neverSettling: SubprocessAdapter = {
      async spawn(): Promise<SubprocessHandle> {
        const now = new Date().toISOString();
        return {
          id: `subprocess-${crypto.randomUUID()}`,
          status: 'running',
          startedAt: now,
          updatedAt: now,
          metadata: {
            runtime: 'never-settling',
          },
        };
      },
      async get(handleId) {
        // Always return `running` so the poll loop never observes a
        // terminal status. We synthesise a fresh handle object with the
        // requested id to keep the poll loop honest.
        return {
          id: handleId,
          status: 'running',
          startedAt: new Date().toISOString(),
          metadata: {
            runtime: 'never-settling',
          },
        };
      },
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
      async isAlive() {
        return true;
      },
      async reattach() {
        return null;
      },
      async listLive() {
        return [];
      },
    };
    const harness = new AgentHarness({
      name: 'timeout-harness',
      params: {},
      subprocess: neverSettling,
    });
    const ctx = harness.createContext();
    const step: Step<ContextMemory, string, string> = {
      kind: 'run',
      id: 'timeout-step',
      execute: async (input) => input,
    };

    const handle = harness.detachedSpawn(step, 'x', ctx);
    try {
      await handle.await(50);
      expect.unreachable('await(50) should have rejected');
    } catch (err) {
      assert(isNoeticError(err));
      const ne = err.noeticError;
      assert(ne.kind === 'step_failed');
      expect(ne.cause.message).toContain('timed out');
    }
    // After the timeout, the underlying handle is still running. The
    // DetachedHandle's cached status must not have flipped to completed.
    await new Promise((r) => setTimeout(r, 100));
    expect(handle.status).not.toBe('completed');
    expect(handle.result).toBeUndefined();
  });
});

//#endregion
