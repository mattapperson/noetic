/**
 * Durable execution: checkpoint/restore through CheckpointStore.
 *
 * Covers the happy path (save → drop harness → reconstruct with same
 * storage → load gives equivalent snapshot) plus the list/clear surface.
 * Adapter reattach / listLive durability has its own coverage in
 * local-adapter-reattach and pid-starttime-drift.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextLayer } from '@noetic-tools/context';
import { Slot } from '@noetic-tools/context';
import type { Item } from '@noetic-tools/types';
import { AgentHarness } from '../../src/harness/agent-harness';
import { getBroadcaster } from '../../src/runtime/broadcaster-utils';
import { createCheckpointStore } from '../../src/runtime/durable/checkpoint-store';
import type { RestoreCheckpointOptions } from '../../src/runtime/durable/harness-checkpoints';
import { EventBroadcaster } from '../../src/runtime/event-broadcaster';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import type { CheckpointSnapshot } from '../../src/types/checkpoint';
import { makeLayer, makeMessage } from '../_helpers';

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

//#region restore(executionId, opts) — caller-supplied context wiring

/**
 * A harness pair over one shared store: `origin` creates + checkpoints the
 * pre-crash context, `resumed` stands in for the process that came back up.
 */
function makeHarnessPair(context?: ContextLayer[]): {
  origin: AgentHarness;
  resumed: AgentHarness;
} {
  const storage = createInMemoryStorage();
  const checkpointStore = createCheckpointStore({
    storage,
  });
  const config = {
    name: 'noeticTest',
    params: {},
    storage,
    checkpointStore,
    context,
  };
  return {
    origin: new AgentHarness(config),
    resumed: new AgentHarness(config),
  };
}

describe('AgentHarness.restore context wiring', () => {
  it('forwards the caller broadcaster so a resumed turn keeps streaming', async () => {
    const { origin, resumed } = makeHarnessPair();
    const broadcaster = new EventBroadcaster();
    const ctx = origin.createContext({
      _broadcaster: broadcaster,
    });
    await origin.checkpoint(ctx);

    const restored = await resumed.restore(ctx.id, {
      _broadcaster: broadcaster,
    });
    assert(restored);
    expect(getBroadcaster(restored)).toBe(broadcaster);
  });

  it('lets the caller swap the context layers on restore', async () => {
    // `restore` forwards its opts straight to `createContext`, which owns the
    // harness-default fallback. These cases pin that delegation.
    const harnessLayer = makeLayer('from-harness', {
      slot: 100,
    });
    const overrideLayer = makeLayer('from-caller', {
      slot: 100,
    });

    {
      const { origin, resumed } = makeHarnessPair([
        harnessLayer,
      ]);
      const ctx = origin.createContext({});
      await origin.checkpoint(ctx);
      const restored = await resumed.restore(ctx.id, {
        context: [
          overrideLayer,
        ],
      });
      assert(restored);
      expect(restored.layers).toEqual([
        overrideLayer,
      ]);
    }

    // No override falls back to the harness default.
    const { origin, resumed } = makeHarnessPair([
      harnessLayer,
    ]);
    const ctx = origin.createContext({});
    await origin.checkpoint(ctx);
    const restored = await resumed.restore(ctx.id);
    assert(restored);
    expect(restored.layers).toEqual([
      harnessLayer,
    ]);
  });

  it('restores a bare context when the caller supplies no wiring', async () => {
    const { origin, resumed } = makeHarnessPair();
    const ctx = origin.createContext({
      _broadcaster: new EventBroadcaster(),
    });
    await origin.checkpoint(ctx);

    // The regression this documents: wiring is not recoverable from a snapshot,
    // so omitting `opts` still yields an undecorated context — by design, not by
    // accident. Hosts must pass their wiring back in.
    const restored = await resumed.restore(ctx.id);
    assert(restored);
    expect(getBroadcaster(restored)).toBeUndefined();
  });

  it('forwards caller state and parent onto the restored context', async () => {
    const { origin, resumed } = makeHarnessPair();
    const ctx = origin.createContext({});
    await origin.checkpoint(ctx);

    const parent = resumed.createContext({});
    const restored = await resumed.restore(ctx.id, {
      parent,
      state: {
        sessionQueue: 'live-object',
      },
    });
    assert(restored);
    expect(restored.parent).toBe(parent);
    expect(restored.depth).toBe(parent.depth + 1);
    expect(restored.state).toEqual({
      sessionQueue: 'live-object',
    });
  });

  it('caller context layers override the harness defaults on restore', async () => {
    const harnessLayer = makeLayer('harness-layer', {
      slot: Slot.STEERING,
    });
    const { origin, resumed } = makeHarnessPair([
      harnessLayer,
    ]);
    const ctx = origin.createContext({});
    await origin.checkpoint(ctx);

    const restored = await resumed.restore(ctx.id, {
      context: [
        makeLayer('call-layer', {
          slot: Slot.WORKING_MEMORY,
        }),
      ],
    });
    assert(restored);
    assert(restored.layers);
    expect(restored.layers.map((l) => l.id)).toEqual([
      'call-layer',
    ]);
  });

  it('falls back to the harness context layers when the caller omits them', async () => {
    const { origin, resumed } = makeHarnessPair([
      makeLayer('harness-layer', {
        slot: Slot.STEERING,
      }),
    ]);
    const ctx = origin.createContext({});
    await origin.checkpoint(ctx);

    const restored = await resumed.restore(ctx.id, {
      state: {},
    });
    assert(restored);
    assert(restored.layers);
    expect(restored.layers.map((l) => l.id)).toEqual([
      'harness-layer',
    ]);
  });

  it('snapshot-owned fields win over anything the caller passes', async () => {
    const { origin, resumed } = makeHarnessPair();
    const ctx = origin.createContext({
      threadId: 'thread-from-snapshot',
      resourceId: 'resource-from-snapshot',
      cwdInit: '/tmp/snapshot-cwd',
      items: [
        makeMessage('user', 'recorded before the crash'),
      ],
    });
    await origin.checkpoint(ctx);

    /* `RestoreContextOptions` deliberately omits these, so a caller can only get
     * here by widening the type — the assertion locks the precedence rather than
     * the compile error. */
    const rogue: RestoreCheckpointOptions & {
      threadId?: string;
      resourceId?: string;
      cwdInit?: string;
      items?: Item[];
    } = {
      threadId: 'hijacked',
      resourceId: 'hijacked',
      cwdInit: '/tmp/hijacked',
      items: [
        makeMessage('user', 'never happened'),
      ],
    };
    const restored = await resumed.restore(ctx.id, rogue);
    assert(restored);
    expect(restored.id).toBe(ctx.id);
    expect(restored.threadId).toBe('thread-from-snapshot');
    expect(restored.resourceId).toBe('resource-from-snapshot');
    expect(restored.cwdState.cwd).toBe('/tmp/snapshot-cwd');
    expect(restored.itemLog.items).toHaveLength(1);
  });
});

//#endregion
