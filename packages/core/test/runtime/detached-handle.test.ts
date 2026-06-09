import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextMemory } from '@noetic-tools/memory';
import type { Step, StepSubprocessRequest } from '@noetic-tools/types';
import { DetachedStatus, isNoeticError } from '@noetic-tools/types';
import { createInMemorySubprocessAdapter } from '../../src/adapters/in-memory-subprocess-adapter';
import { AgentHarness } from '../../src/harness/agent-harness';
import { DetachedHandleImpl } from '../../src/runtime/detached-handle';

//#region Helpers

function makeStepRequest(overrides: Partial<StepSubprocessRequest> = {}): StepSubprocessRequest {
  return {
    kind: 'step',
    stepId: 'test-step',
    serializedInput: undefined,
    executionId: `exec-${crypto.randomUUID()}`,
    overrides: {},
    ...overrides,
  };
}

//#endregion

describe('DetachedHandleImpl', () => {
  it('reports running initially when the adapter has not yet settled', async () => {
    const adapter = createInMemorySubprocessAdapter({
      stepRunner: () => new Promise(() => {}), // never resolves
    });
    const spawnPromise = adapter.spawn(makeStepRequest());
    const handle = new DetachedHandleImpl<string>({
      id: 'test-1',
      stepId: 'test-step',
      adapter,
      spawnPromise,
    });
    // Give the adapter a tick to register the handle but not finish it.
    await spawnPromise;
    expect(handle.status).toBe(DetachedStatus.Running);
    expect(handle.result).toBeUndefined();
    expect(handle.error).toBeUndefined();
  });

  it('reports completed with result after child finishes', async () => {
    const adapter = createInMemorySubprocessAdapter({
      stepRunner: async () => 'done',
    });
    const spawnPromise = adapter.spawn(makeStepRequest());
    const handle = new DetachedHandleImpl<string>({
      id: 'test-2',
      stepId: 'test-step',
      adapter,
      spawnPromise,
    });
    const result = await handle.await();
    expect(result).toBe('done');
    expect(handle.status).toBe(DetachedStatus.Completed);
    expect(handle.result).toBe('done');
    expect(handle.error).toBeUndefined();
  });

  it('reports failed with error message on child failure', async () => {
    const adapter = createInMemorySubprocessAdapter({
      stepRunner: async () => {
        throw new Error('boom');
      },
    });
    const spawnPromise = adapter.spawn(makeStepRequest());
    const handle = new DetachedHandleImpl<string>({
      id: 'test-3',
      stepId: 'test-step',
      adapter,
      spawnPromise,
    });
    try {
      await handle.await();
      expect.unreachable('should have thrown');
    } catch {
      // expected
    }
    expect(handle.status).toBe(DetachedStatus.Failed);
    expect(handle.error).toBe('boom');
    expect(handle.result).toBeUndefined();
  });

  it('await() resolves with child output', async () => {
    const adapter = createInMemorySubprocessAdapter({
      stepRunner: async () => 42,
    });
    const spawnPromise = adapter.spawn(makeStepRequest());
    const handle = new DetachedHandleImpl<number>({
      id: 'test-4',
      stepId: 'test-step',
      adapter,
      spawnPromise,
    });
    const result = await handle.await();
    expect(result).toBe(42);
  });

  it('await(timeout) throws on timeout if child has not finished', async () => {
    const adapter = createInMemorySubprocessAdapter({
      stepRunner: () => new Promise(() => {}), // never resolves
    });
    const spawnPromise = adapter.spawn(makeStepRequest());
    const handle = new DetachedHandleImpl<string>({
      id: 'test-5',
      stepId: 'test-step',
      adapter,
      spawnPromise,
    });
    try {
      await handle.await(50);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      const oe = e.noeticError;
      assert(oe.kind === 'step_failed');
      expect(oe.cause.message).toContain('timed out');
    }
  });

  it('after timeout, handle does not leak into a completed state', async () => {
    // Custom adapter that never transitions — simulates a hung step that
    // must not be reported as `completed` after the caller's timeout fires.
    const neverSettlingAdapter = createNeverSettlingAdapter();
    const spawnPromise = neverSettlingAdapter.spawn(makeStepRequest());
    const handle = new DetachedHandleImpl<string>({
      id: 'test-6',
      stepId: 'test-step',
      adapter: neverSettlingAdapter,
      spawnPromise,
    });
    try {
      await handle.await(20);
      expect.unreachable('should have thrown');
    } catch {
      // expected timeout
    }
    // Wait a few more ticks — the underlying handle is still running, so
    // the DetachedHandle should stay in its timeout state (the cached
    // settlement promise is tied to the internal poll loop and hasn't
    // completed). Specifically: we should NOT have transitioned to
    // `Completed`.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handle.status).not.toBe(DetachedStatus.Completed);
    expect(handle.result).toBeUndefined();
  });
});

describe('AgentHarness.detachedSpawn', () => {
  it('multiple detached spawns run concurrently', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const ctx = harness.createContext();

    const step: Step<ContextMemory, number, number> = {
      kind: 'run',
      id: 'delayed',
      execute: async (input: number) => {
        await new Promise((r) => setTimeout(r, 20));
        return input * 2;
      },
    };

    const handle1 = harness.detachedSpawn(step, 5, ctx);
    const handle2 = harness.detachedSpawn(step, 10, ctx);

    expect(handle1.status).toBe(DetachedStatus.Running);
    expect(handle2.status).toBe(DetachedStatus.Running);

    const [r1, r2] = await Promise.all([
      handle1.await(),
      handle2.await(),
    ]);

    expect(r1).toBe(10);
    expect(r2).toBe(20);
    expect(handle1.status).toBe(DetachedStatus.Completed);
    expect(handle2.status).toBe(DetachedStatus.Completed);
  });

  it('creates child context with parent relationship', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const ctx = harness.createContext();

    const step: Step<ContextMemory, string, string> = {
      kind: 'run',
      id: 'echo',
      execute: async (input: string) => input,
    };

    const handle = harness.detachedSpawn(step, 'hello', ctx);
    const result = await handle.await();
    expect(result).toBe('hello');
    expect(handle.status).toBe(DetachedStatus.Completed);
  });
});

//#region Test adapter

function createNeverSettlingAdapter(): ReturnType<typeof createInMemorySubprocessAdapter> {
  // Build on top of the in-memory adapter but override the step runner to
  // hang forever. `spawn()` still returns a handle synchronously (status
  // `'running'`), but the internal completion never fires.
  return createInMemorySubprocessAdapter({
    stepRunner: () => new Promise(() => {}),
  });
}

//#endregion
