/**
 * Durable execution: checkpoint/restore through CheckpointStore.
 *
 * Covers the happy path (save → drop harness → reconstruct with same
 * storage → load gives equivalent snapshot) plus the list/clear surface.
 * Adapter reattach / listLive durability has its own coverage in
 * local-adapter-reattach and pid-starttime-drift.
 */

import { describe, expect, it } from 'bun:test';
import { AgentHarness } from '../../src/runtime/agent-harness';
import { createCheckpointStore } from '../../src/runtime/durable/checkpoint-store';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import type { CheckpointSnapshot } from '../../src/types/checkpoint';

describe('CheckpointStore', () => {
  it('save → load round-trips a snapshot through the StorageAdapter', async () => {
    const storage = createInMemoryStorage();
    const store = createCheckpointStore({
      storage,
    });
    const snapshot: CheckpointSnapshot = {
      schemaVersion: 1,
      executionId: 'exec-abc',
      threadId: 't-1',
      resourceId: 'u-1',
      frontier: [
        {
          stepId: 'greet',
          input: 'hi',
        },
      ],
      layers: {
        working: {
          bullets: [
            'a',
          ],
        },
      },
      cwd: {
        current: '/tmp/x',
        previous: '/tmp/prev',
      },
      askUser: [],
      itemLog: {
        items: [],
      },
      capturedAt: new Date().toISOString(),
    };
    await store.save(snapshot);
    const loaded = await store.load('exec-abc');
    expect(loaded).not.toBeNull();
    expect(loaded?.executionId).toBe('exec-abc');
    expect(loaded?.frontier.length).toBe(1);
    expect(loaded?.frontier[0]?.stepId).toBe('greet');
    expect(loaded?.layers).toEqual({
      working: {
        bullets: [
          'a',
        ],
      },
    });
    expect(loaded?.cwd?.current).toBe('/tmp/x');
  });

  it('load returns null for an unknown executionId', async () => {
    const store = createCheckpointStore({
      storage: createInMemoryStorage(),
    });
    expect(await store.load('missing')).toBeNull();
  });

  it('list enumerates every persisted executionId', async () => {
    const store = createCheckpointStore({
      storage: createInMemoryStorage(),
    });
    const base: CheckpointSnapshot = {
      schemaVersion: 1,
      executionId: 'a',
      frontier: [],
      layers: {},
      cwd: null,
      askUser: [],
      itemLog: {
        items: [],
      },
      capturedAt: new Date().toISOString(),
    };
    await store.save({
      ...base,
      executionId: 'a',
    });
    await store.save({
      ...base,
      executionId: 'b',
    });
    const ids = new Set((await store.list()).map((e) => e.executionId));
    expect(ids).toEqual(
      new Set([
        'a',
        'b',
      ]),
    );
  });

  it('clear removes a snapshot and makes subsequent loads null', async () => {
    const store = createCheckpointStore({
      storage: createInMemoryStorage(),
    });
    const snap: CheckpointSnapshot = {
      schemaVersion: 1,
      executionId: 'x',
      frontier: [],
      layers: {},
      cwd: null,
      askUser: [],
      itemLog: {
        items: [],
      },
      capturedAt: new Date().toISOString(),
    };
    await store.save(snap);
    await store.clear('x');
    expect(await store.load('x')).toBeNull();
  });
});

describe('AgentHarness.checkpoint + restore', () => {
  it('checkpoint is a no-op when no CheckpointStore is configured', async () => {
    const harness = new AgentHarness({
      name: 'noeticTest',
      params: {},
    });
    const ctx = harness.createContext({});
    // Just asserting it does not throw.
    await harness.checkpoint(ctx);
    const restored = await harness.restore('nothing');
    expect(restored).toBeNull();
  });

  it('checkpoint persists; a fresh harness with the same store can restore', async () => {
    const storage = createInMemoryStorage();
    const checkpointStore = createCheckpointStore({
      storage,
    });
    const h1 = new AgentHarness({
      name: 'noeticTest',
      params: {},
      storage,
      checkpointStore,
    });
    const ctx = h1.createContext({});
    await h1.checkpoint(ctx);
    const originalId = ctx.id;
    const h2 = new AgentHarness({
      name: 'noeticTest',
      params: {},
      storage,
      checkpointStore,
    });
    const restored = await h2.restore(originalId);
    expect(restored).not.toBeNull();
    expect(restored?.id).toBe(originalId);
  });

  it('restore returns null when no snapshot matches the executionId', async () => {
    const storage = createInMemoryStorage();
    const checkpointStore = createCheckpointStore({
      storage,
    });
    const h = new AgentHarness({
      name: 'noeticTest',
      params: {},
      storage,
      checkpointStore,
    });
    expect(await h.restore('never-stored')).toBeNull();
  });
});
