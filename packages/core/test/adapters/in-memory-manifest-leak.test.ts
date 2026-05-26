/**
 * Regression test for C3: the in-memory subprocess adapter's
 * terminal-state transitions (`completed` / `failed`) must clear the
 * durable handle manifest. Previously only `stop()` cleared the
 * manifest, so `listLive()` returned phantom handles for every step
 * ever completed against the storage. Over a long run this leaked
 * unbounded memory and would have caused `reattachLiveChildren()` to
 * resurrect stale executions as if they were live on startup.
 */

import { describe, expect, it } from 'bun:test';

import { createInMemorySubprocessAdapter } from '../../src/adapters/in-memory-subprocess-adapter';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';

describe('in-memory adapter manifest leak (C3 regression)', () => {
  it('listLive() returns empty after a step completes', async () => {
    const storage = createInMemoryStorage();
    const adapter = createInMemorySubprocessAdapter({
      storage,
      stepRunner: async () => 'ok',
    });

    const handle = await adapter.spawn({
      kind: 'step',
      stepId: 'test-step',
      serializedInput: 'input',
      executionId: 'exec-1',
      overrides: {},
    });
    expect(handle.status).toBe('running');

    // Yield microtasks so completeStepRun finishes.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const completed = await adapter.get(handle.id);
    expect(completed?.status).toBe('completed');

    // The critical assertion: after the step completes, listLive must
    // not return its manifest.
    const live = await adapter.listLive();
    expect(live).toHaveLength(0);
  });

  it('listLive() returns empty after a step fails', async () => {
    const storage = createInMemoryStorage();
    const adapter = createInMemorySubprocessAdapter({
      storage,
      stepRunner: async () => {
        throw new Error('boom');
      },
    });

    const handle = await adapter.spawn({
      kind: 'step',
      stepId: 'test-step',
      serializedInput: 'input',
      executionId: 'exec-2',
      overrides: {},
    });
    expect(handle.status).toBe('running');

    await new Promise((resolve) => setTimeout(resolve, 10));

    const failed = await adapter.get(handle.id);
    expect(failed?.status).toBe('failed');

    const live = await adapter.listLive();
    expect(live).toHaveLength(0);
  });

  it('listLive() returns the handle while it is still running', async () => {
    // Counterpart to the two above — proves we only clear on terminal
    // transitions, not indiscriminately.
    const storage = createInMemoryStorage();
    let resolver: (value: string) => void = () => undefined;
    const adapter = createInMemorySubprocessAdapter({
      storage,
      stepRunner: () =>
        new Promise<string>((resolve) => {
          resolver = resolve;
        }),
    });

    await adapter.spawn({
      kind: 'step',
      stepId: 'test-step',
      serializedInput: 'input',
      executionId: 'exec-3',
      overrides: {},
    });

    const live = await adapter.listLive();
    expect(live).toHaveLength(1);
    expect(live[0]?.status).toBe('running');

    // Clean up: let the step finish so the test doesn't leak a pending
    // promise into the next one.
    resolver('done');
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('does not leak across multiple sequential completions', async () => {
    // Before the fix, running N steps and calling listLive() would
    // return N phantom handles. Confirm that running 5 now returns 0.
    const storage = createInMemoryStorage();
    const adapter = createInMemorySubprocessAdapter({
      storage,
      stepRunner: async () => 'ok',
    });

    for (let i = 0; i < 5; i++) {
      await adapter.spawn({
        kind: 'step',
        stepId: `test-step-${i}`,
        serializedInput: `input-${i}`,
        executionId: `exec-${i}`,
        overrides: {},
      });
    }

    // Wait for all async completions.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const live = await adapter.listLive();
    expect(live).toHaveLength(0);
  });
});
