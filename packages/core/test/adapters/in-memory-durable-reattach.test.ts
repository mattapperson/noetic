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
import assert from 'node:assert';
import type { ContextData } from '@noetic-tools/context';
import type { Step, StepSubprocessRequest, SubprocessHandle } from '@noetic-tools/types';
import { createInMemorySubprocessAdapter } from '../../src/adapters/in-memory-subprocess-adapter';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createCheckpointStore } from '../../src/runtime/durable/checkpoint-store';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';

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
    const { handle: spawned } = await first.spawn(request);
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
    const { handle: spawned } = await first.spawn({
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

  it('persists caller metadata tags and the parent id, and restores them on reattach', async () => {
    const storage = createInMemoryStorage();
    const first = createInMemorySubprocessAdapter({
      storage,
      stepRunner: async () => await new Promise(() => {}),
    });
    const { handle: spawned } = await first.spawn({
      kind: 'step',
      stepId: 'plan',
      serializedInput: null,
      executionId: 'exec-child-1',
      parentExecutionId: 'exec-parent-1',
      overrides: {},
      metadata: {
        taskRole: 'planner',
        taskId: 'T-1',
      },
    });

    const second = createInMemorySubprocessAdapter({
      storage,
    });
    const handle = await second.reattach(spawned.id);
    assert(handle !== null);
    expect(handle.metadata?.taskRole).toBe('planner');
    expect(handle.metadata?.taskId).toBe('T-1');
    expect(handle.metadata?.executionId).toBe('exec-child-1');
    expect(handle.metadata?.parentExecutionId).toBe('exec-parent-1');
    // Caller tags never shadow the adapter's own keys.
    expect(handle.metadata?.runtime).toBe('in-memory');
  });

  it('a detachedSpawn manifest names a parent that harness.restore() can find', async () => {
    const storage = createInMemoryStorage();
    const checkpointStore = createCheckpointStore({
      storage,
    });
    const subprocess = createInMemorySubprocessAdapter({
      storage,
      stepRunner: async () => await new Promise(() => {}),
    });
    const harness = new AgentHarness({
      name: 'durable-parent',
      params: {},
      environment: {
        subprocess,
        storage: {
          adapter: storage,
          checkpointStore,
        },
      },
    });
    const parent = harness.createContext();
    await harness.checkpoint(parent);
    const step: Step<ContextData, null, string> = {
      kind: 'runCode',
      id: 'durable-detached-child',
      execute: async () => await new Promise<string>(() => {}),
    };
    const detached = harness.detachedSpawn(step, null, parent);

    // The manifest is written once the adapter's spawn settles.
    const reader = createInMemorySubprocessAdapter({
      storage,
    });
    let manifestHandle: SubprocessHandle | undefined;
    for (let i = 0; i < 50 && manifestHandle === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const live = await reader.listLive();
      manifestHandle = live.find((h) => h.metadata?.stepId === 'durable-detached-child');
    }
    assert(manifestHandle !== undefined);
    expect(manifestHandle.metadata?.executionId).toBe(detached.id);
    const parentId = manifestHandle.metadata?.parentExecutionId;
    expect(parentId).toBe(parent.id);
    assert(typeof parentId === 'string');
    const restored = await harness.restore(parentId);
    expect(restored?.id).toBe(parent.id);
  });

  it('stop clears the manifest so listLive no longer surfaces the handle', async () => {
    const storage = createInMemoryStorage();
    const adapter = createInMemorySubprocessAdapter({
      storage,
      stepRunner: async () => await new Promise(() => {}),
    });
    const { handle } = await adapter.spawn({
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
