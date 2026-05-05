/**
 * In-memory adapter durability: with a StorageAdapter, spawn + drop +
 * new-adapter-instance should find the step manifest via listLive and
 * rehydrate a handle via reattach.
 *
 * For in-memory the reattached handle is an idempotent re-run placeholder
 * (reattachMode === 'replay'), not a rebind — this is documented on the
 * manifest and test that invariant explicitly below.
 */

import { describe, expect, it } from 'bun:test';
import { createInMemorySubprocessAdapter } from '../../src/adapters/in-memory-subprocess-adapter';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import type { StepSubprocessRequest } from '../../src/types/subprocess-adapter';

describe('in-memory adapter durability', () => {
  it('without storage: reattach returns null and listLive is ephemeral only', async () => {
    const adapter = createInMemorySubprocessAdapter();
    expect(await adapter.reattach('whatever')).toBeNull();
    expect((await adapter.listLive()).length).toBe(0);
  });

  it('with storage: listLive surfaces a manifest from a prior adapter instance', async () => {
    const storage = createInMemoryStorage();
    const first = createInMemorySubprocessAdapter({
      storage,
      stepRunner: async () => {
        // Block forever so the step never "completes" during the test;
        // we want the manifest live when we drop this adapter.
        return await new Promise(() => {});
      },
    });
    const request: StepSubprocessRequest = {
      kind: 'step',
      stepId: 'trainspotter',
      serializedInput: {
        train: '7-car',
      },
      executionId: 'exec-durable-1',
      overrides: {},
    };
    const spawned = await first.spawn(request);
    expect(spawned.status).toBe('running');

    // Drop `first` and bring up a second adapter sharing the same storage.
    const second = createInMemorySubprocessAdapter({
      storage,
    });
    const live = await second.listLive();
    expect(live.length).toBe(1);
    expect(live[0]?.id).toBe(spawned.id);
    expect(live[0]?.metadata?.stepId).toBe('trainspotter');
  });

  it('reattach(handleId): returns a running handle stamped reattachMode=replay', async () => {
    const storage = createInMemoryStorage();
    const first = createInMemorySubprocessAdapter({
      storage,
      stepRunner: async () => await new Promise(() => {}),
    });
    const spawned = await first.spawn({
      kind: 'step',
      stepId: 'greet',
      serializedInput: 'hi',
      executionId: 'exec-reattach-1',
      overrides: {},
    });

    const second = createInMemorySubprocessAdapter({
      storage,
    });
    const handle = await second.reattach(spawned.id);
    expect(handle).not.toBeNull();
    expect(handle?.id).toBe(spawned.id);
    expect(handle?.status).toBe('running');
    expect(handle?.metadata?.reattachMode).toBe('replay');
    expect(handle?.metadata?.stepId).toBe('greet');
  });

  it('stop clears the manifest so listLive no longer surfaces the handle', async () => {
    const storage = createInMemoryStorage();
    const adapter = createInMemorySubprocessAdapter({
      storage,
      stepRunner: async () => await new Promise(() => {}),
    });
    const handle = await adapter.spawn({
      kind: 'step',
      stepId: 'x',
      serializedInput: {},
      executionId: 'e',
      overrides: {},
    });
    expect((await adapter.listLive()).length).toBe(1);
    await adapter.stop(handle.id, 'cleanup');
    // New adapter sees no manifest — cleared on stop.
    const next = createInMemorySubprocessAdapter({
      storage,
    });
    expect((await next.listLive()).length).toBe(0);
    expect(await next.reattach(handle.id)).toBeNull();
  });
});
