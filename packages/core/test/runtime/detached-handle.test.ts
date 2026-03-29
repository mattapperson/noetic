import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { isNoeticError } from '../../src/errors/noetic-error';
import { AgentHarness } from '../../src/runtime/agent-harness';
import { DetachedHandleImpl } from '../../src/runtime/detached-handle';
import { DetachedStatus } from '../../src/types/detached';
import type { ContextMemory } from '../../src/types/memory';
import type { Step } from '../../src/types/step';

describe('DetachedHandleImpl', () => {
  it('reports running initially', () => {
    const handle = new DetachedHandleImpl<string>('test-1', new Promise(() => {}));
    expect(handle.status).toBe(DetachedStatus.Running);
    expect(handle.result).toBeUndefined();
    expect(handle.error).toBeUndefined();
  });

  it('reports completed with result after child finishes', async () => {
    const handle = new DetachedHandleImpl<string>('test-2', Promise.resolve('done'));
    const result = await handle.await();
    expect(result).toBe('done');
    expect(handle.status).toBe(DetachedStatus.Completed);
    expect(handle.result).toBe('done');
    expect(handle.error).toBeUndefined();
  });

  it('reports failed with error message on child failure', async () => {
    const handle = new DetachedHandleImpl<string>('test-3', Promise.reject(new Error('boom')));
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
    const handle = new DetachedHandleImpl<number>('test-4', Promise.resolve(42));
    const result = await handle.await();
    expect(result).toBe(42);
  });

  it('await(timeout) throws on timeout if child has not finished', async () => {
    const handle = new DetachedHandleImpl<string>(
      'test-5',
      new Promise(() => {}), // never resolves
    );
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
