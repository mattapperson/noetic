/**
 * O(delta) item-log checkpoints: the snapshot carries a COUNT, the transcript
 * lives outside it as append-only batches keyed by the log's owner.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type { LLMResponse, MessageItem } from '@noetic-tools/types';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createCheckpointStore } from '../../src/runtime/durable/checkpoint-store';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { assistantMessage, makeMessage } from '../_helpers';

function meteringStorage(): {
  adapter: StorageAdapter;
  writes: Array<{
    key: string;
    bytes: number;
  }>;
} {
  const inner = createInMemoryStorage();
  const writes: Array<{
    key: string;
    bytes: number;
  }> = [];
  const adapter: StorageAdapter = {
    get: (key) => inner.get(key),
    set: async (key, value) => {
      writes.push({
        key,
        bytes: JSON.stringify(value).length,
      });
      return inner.set(key, value);
    },
    delete: (key) => inner.delete(key),
    list: (prefix) => inner.list(prefix),
  };
  return {
    adapter,
    writes,
  };
}

function scriptedHarness(storage: StorageAdapter): {
  harness: AgentHarness;
  checkpointStore: ReturnType<typeof createCheckpointStore>;
} {
  const checkpointStore = createCheckpointStore({
    storage,
  });
  let call = 0;
  const harness = new AgentHarness({
    name: 'batches-test',
    params: {},
    agentGraph: {
      kind: 'callModel',
      id: 'chat',
      model: 'test/scripted',
      tools: [],
    },
    environment: {
      storage: {
        adapter: storage,
        checkpointStore,
      },
    },
    _testCallModel: async (): Promise<LLMResponse> => {
      const message: MessageItem = assistantMessage(`answer ${call}`, `resp-${call}`);
      call += 1;
      return {
        items: [
          message,
        ],
        usage: {
          inputTokens: 0,
          outputTokens: 1,
        },
      };
    },
  });
  return {
    harness,
    checkpointStore,
  };
}

function batchOffsets(
  writes: ReadonlyArray<{
    key: string;
  }>,
  ownerKey: string,
): number[] {
  const prefix = `execution:${ownerKey}:itemLog:`;
  return writes
    .filter((w) => w.key.startsWith(prefix))
    .map((w) => Number(w.key.slice(prefix.length)));
}

describe('item-log checkpoint batches are O(delta) and thread-keyed', () => {
  it('each turn appends at a strictly increasing offset, never re-writing from 0', async () => {
    const metering = meteringStorage();
    const { harness } = scriptedHarness(metering.adapter);
    const threadId = 'delta-thread';

    for (const text of [
      'one',
      'two',
      'three',
      'four',
    ]) {
      await harness.execute(text, {
        threadId,
      });
      await harness.getAgentResponse({
        threadId,
      });
    }

    const offsets = batchOffsets(metering.writes, `thread:${threadId}`);
    expect(offsets.length).toBe(4);
    expect(offsets.filter((o) => o === 0)).toHaveLength(1);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThan(offsets[i - 1] ?? -1);
    }
    expect(harness.itemLogPersistence.get(`thread:${threadId}`)).toBe(8);
  });

  it('later turns write less than the whole transcript (bytes stay per-delta)', async () => {
    const metering = meteringStorage();
    const { harness } = scriptedHarness(metering.adapter);
    const threadId = 'bytes-thread';
    const prefix = `execution:thread:${threadId}:itemLog:`;

    const perTurnBytes: number[] = [];
    for (const text of [
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
    ]) {
      const before = metering.writes.length;
      await harness.execute(text, {
        threadId,
      });
      await harness.getAgentResponse({
        threadId,
      });
      perTurnBytes.push(
        metering.writes
          .slice(before)
          .filter((w) => w.key.startsWith(prefix))
          .reduce((sum, w) => sum + w.bytes, 0),
      );
    }

    const first = perTurnBytes[0] ?? 0;
    const last = perTurnBytes[perTurnBytes.length - 1] ?? 0;
    expect(first).toBeGreaterThan(0);
    expect(last).toBeLessThan(first * 2);
  });

  it('the snapshot carries persistedCount, not the transcript', async () => {
    const { harness, checkpointStore } = scriptedHarness(createInMemoryStorage());
    const threadId = 'count-thread';
    await harness.execute('hello', {
      threadId,
    });
    await harness.getAgentResponse({
      threadId,
    });

    const ids = await checkpointStore.list();
    expect(ids.length).toBeGreaterThan(0);
    const executionId = ids[ids.length - 1]?.executionId;
    assert(executionId);
    const snapshot = await checkpointStore.load(executionId);
    assert(snapshot);
    expect(snapshot.itemLog.items).toEqual([]);
    expect(snapshot.itemLog.persistedCount).toBe(2);
  });

  it('restore stitches the batches back through the thread owner key', async () => {
    const storage = createInMemoryStorage();
    const { harness, checkpointStore } = scriptedHarness(storage);
    const threadId = 'restore-thread';
    await harness.execute('remembered before the crash', {
      threadId,
    });
    await harness.getAgentResponse({
      threadId,
    });

    const ids = await checkpointStore.list();
    const executionId = ids[ids.length - 1]?.executionId;
    assert(executionId);

    const resumed = scriptedHarness(storage).harness;
    const restored = await resumed.restore(executionId);
    assert(restored);
    expect(restored.itemLog.items.length).toBe(2);
    expect(resumed.itemLogPersistence.get(`thread:${threadId}`)).toBe(2);
  });

  it('a legacy store without appendItems keeps the inline snapshot shape', async () => {
    const storage = createInMemoryStorage();
    const full = createCheckpointStore({
      storage,
    });
    const legacy = {
      save: full.save,
      load: full.load,
      list: full.list,
      clear: full.clear,
    };
    const harness = new AgentHarness({
      name: 'legacy-store',
      params: {},
      environment: {
        storage: {
          adapter: storage,
          checkpointStore: legacy,
        },
      },
    });
    const ctx = harness.createContext({
      threadId: 'legacy-thread',
      items: [
        makeMessage('user', 'inline me'),
      ],
    });
    await harness.checkpoint(ctx);

    const snapshot = await legacy.load(ctx.id);
    assert(snapshot);
    expect(snapshot.itemLog.items).toHaveLength(1);
    expect(snapshot.itemLog.persistedCount).toBeUndefined();
    expect(await storage.list('execution:thread:legacy-thread:itemLog:')).toEqual([]);
  });
});
