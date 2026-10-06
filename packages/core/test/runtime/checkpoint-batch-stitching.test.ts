/**
 * Item-log batch stitching and truncation behavior.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData, StorageAdapter } from '@noetic-tools/context';
import type { Item, LLMResponse, MessageItem, Step } from '@noetic-tools/types';
import { defaultItemSchemaRegistry } from '@noetic-tools/types';
import { loop } from '../../src/builders/loop-builder';
import { runCode } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createCheckpointStore } from '../../src/runtime/durable/checkpoint-store';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { until } from '../../src/until/predicates';
import { assistantMessage } from '../_helpers';

function itemTexts(item: Item): string[] {
  if (item.type !== 'message') {
    return [];
  }
  const texts: string[] = [];
  for (const part of item.content) {
    if (part.type === 'input_text' || part.type === 'output_text') {
      texts.push(part.text);
    }
  }
  return texts;
}

function durableTexts(raw: readonly unknown[]): string[] {
  return defaultItemSchemaRegistry.parseMany(raw).flatMap(itemTexts);
}

let uniq = 0;
type ScriptedCall = number | 'fail';

function makeHarness(script: ScriptedCall[]): {
  harness: AgentHarness;
  checkpointStore: ReturnType<typeof createCheckpointStore>;
  storage: StorageAdapter;
} {
  const storage = createInMemoryStorage();
  const checkpointStore = createCheckpointStore({
    storage,
  });
  let call = 0;
  const n = uniq++;
  const body: Step<ContextData, string, string> = loop<ContextData, string, string>({
    id: `turn-body-${n}`,
    steps: [
      runCode<ContextData, string, string>({
        id: `pre-${n}`,
        execute: async (input) => input,
      }),
      {
        kind: 'callModel',
        id: `chat-${n}`,
        model: 'test/scripted',
        tools: [],
      },
    ],
    until: until.maxSteps(3),
    maxIterations: 3,
  });
  const harness = new AgentHarness({
    name: 'stitch-test',
    params: {},
    agentGraph: body,
    environment: {
      storage: {
        adapter: storage,
        checkpointStore,
      },
    },
    _testCallModel: async (): Promise<LLMResponse> => {
      const mode = script[Math.min(call, script.length - 1)] ?? 1;
      const i = call++;
      if (mode === 'fail') {
        throw new Error(`scripted turn failure #${i}`);
      }
      const items: MessageItem[] = [];
      for (let k = 0; k < mode; k++) {
        items.push(assistantMessage(`answer ${i}.${k}`, `resp-${i}-${k}`));
      }
      return {
        items,
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
    storage,
  };
}

async function runTurn(harness: AgentHarness, threadId: string, text: string): Promise<void> {
  await harness.execute(text, {
    threadId,
  });
  await harness
    .getAgentResponse({
      threadId,
    })
    .catch(() => undefined);
}

describe('loadItems stitches only contiguous batches', () => {
  it('a shorter batch at offset 0 does not leave the old longer batch stitchable', async () => {
    const storage = createInMemoryStorage();
    const store = createCheckpointStore({
      storage,
    });
    assert(store.appendItems);
    assert(store.loadItems);
    const owner = 'thread:reseeded';

    await store.appendItems(owner, 0, [
      'old0',
      'old1',
    ]);
    await store.appendItems(owner, 2, [
      'old2',
      'old3',
      'old4',
    ]);
    await store.appendItems(owner, 5, [
      'old5',
      'old6',
    ]);
    await store.appendItems(owner, 0, [
      'new0',
      'new1',
      'new2',
    ]);
    await store.appendItems(owner, 3, [
      'new3',
      'new4',
      'new5',
    ]);

    const stitched = await store.loadItems(owner, 6);
    expect(stitched).toEqual([
      'new0',
      'new1',
      'new2',
    ]);
    expect(stitched).not.toContain('old2');
    expect(stitched).not.toContain('old5');
  });

  it('and the reseed path deletes those batches, so the full new log stitches', async () => {
    const storage = createInMemoryStorage();
    const store = createCheckpointStore({
      storage,
    });
    assert(store.appendItems);
    assert(store.loadItems);
    assert(store.truncateItems);
    const owner = 'thread:reseeded-clean';

    await store.appendItems(owner, 0, [
      'old0',
      'old1',
    ]);
    await store.appendItems(owner, 2, [
      'old2',
      'old3',
      'old4',
    ]);
    await store.appendItems(owner, 5, [
      'old5',
      'old6',
    ]);
    await store.truncateItems(owner, 0);
    await store.appendItems(owner, 0, [
      'new0',
      'new1',
      'new2',
    ]);
    await store.appendItems(owner, 3, [
      'new3',
      'new4',
      'new5',
    ]);

    expect(await store.loadItems(owner, 6)).toEqual([
      'new0',
      'new1',
      'new2',
      'new3',
      'new4',
      'new5',
    ]);
  });

  it('an overlapping stale batch ends the stitch instead of appending after the good items', async () => {
    const storage = createInMemoryStorage();
    const store = createCheckpointStore({
      storage,
    });
    assert(store.appendItems);
    assert(store.loadItems);
    const owner = 'thread:overlap';

    await store.appendItems(owner, 2, [
      'stale2',
      'stale3',
    ]);
    await store.appendItems(owner, 0, [
      'good0',
      'good1',
      'good2',
    ]);

    expect(await store.loadItems(owner, 4)).toEqual([
      'good0',
      'good1',
      'good2',
    ]);
  });

  it('a missing leading batch is a short read, not a silent re-positioning', async () => {
    const storage = createInMemoryStorage();
    const store = createCheckpointStore({
      storage,
    });
    assert(store.appendItems);
    assert(store.loadItems);
    const owner = 'thread:hole';

    await store.appendItems(owner, 0, [
      'i0',
      'i1',
      'i2',
      'i3',
      'i4',
    ]);
    await store.appendItems(owner, 5, [
      'i5',
      'i6',
      'i7',
    ]);
    for (const key of await storage.list(`execution:${owner}:itemLog:`)) {
      if (key.endsWith('00000000')) {
        await storage.delete(key);
      }
    }

    expect(await store.loadItems(owner, 8)).toEqual([]);
  });

  it('a missing middle batch does not weld the two sides together', async () => {
    const storage = createInMemoryStorage();
    const store = createCheckpointStore({
      storage,
    });
    assert(store.appendItems);
    assert(store.loadItems);
    const owner = 'thread:middle-hole';

    await store.appendItems(owner, 0, [
      'a',
      'b',
    ]);
    await store.appendItems(owner, 2, [
      'c',
      'd',
    ]);
    await store.appendItems(owner, 4, [
      'e',
      'f',
    ]);
    for (const key of await storage.list(`execution:${owner}:itemLog:`)) {
      if (key.endsWith('00000002')) {
        await storage.delete(key);
      }
    }

    expect(await store.loadItems(owner, 6)).toEqual([
      'a',
      'b',
    ]);
  });

  it('contiguous batches still stitch to the full log', async () => {
    const storage = createInMemoryStorage();
    const store = createCheckpointStore({
      storage,
    });
    assert(store.appendItems);
    assert(store.loadItems);
    const owner = 'thread:happy';

    await store.appendItems(owner, 0, [
      'a',
      'b',
    ]);
    await store.appendItems(owner, 2, [
      'c',
    ]);
    await store.appendItems(owner, 3, [
      'd',
      'e',
    ]);

    expect(await store.loadItems(owner, 5)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    expect(await store.loadItems(owner, 3)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('truncateItems removes the batches a rollback orphaned', () => {
  it('drops whole batches at or past the cut and trims a straddling one', async () => {
    const storage = createInMemoryStorage();
    const store = createCheckpointStore({
      storage,
    });
    assert(store.appendItems);
    assert(store.loadItems);
    assert(store.truncateItems);
    const owner = 'thread:truncate';

    await store.appendItems(owner, 0, [
      'a',
      'b',
    ]);
    await store.appendItems(owner, 2, [
      'c',
      'd',
      'e',
    ]);
    await store.appendItems(owner, 5, [
      'f',
    ]);
    await store.truncateItems(owner, 3);

    expect(await store.loadItems(owner, 6)).toEqual([
      'a',
      'b',
      'c',
    ]);
    await store.appendItems(owner, 3, [
      'C',
      'D',
    ]);
    expect(await store.loadItems(owner, 5)).toEqual([
      'a',
      'b',
      'c',
      'C',
      'D',
    ]);
  });

  it('a cut on a batch boundary leaves the prefix byte-identical', async () => {
    const storage = createInMemoryStorage();
    const store = createCheckpointStore({
      storage,
    });
    assert(store.appendItems);
    assert(store.loadItems);
    assert(store.truncateItems);
    const owner = 'thread:boundary';

    await store.appendItems(owner, 0, [
      'a',
      'b',
    ]);
    await store.appendItems(owner, 2, [
      'c',
      'd',
    ]);
    await store.truncateItems(owner, 2);

    expect(await store.loadItems(owner, 4)).toEqual([
      'a',
      'b',
    ]);
  });

  it('a cut at 0 clears the owner entirely', async () => {
    const storage = createInMemoryStorage();
    const store = createCheckpointStore({
      storage,
    });
    assert(store.appendItems);
    assert(store.loadItems);
    assert(store.truncateItems);
    const owner = 'thread:wipe';

    await store.appendItems(owner, 0, [
      'a',
      'b',
    ]);
    await store.appendItems(owner, 2, [
      'c',
    ]);
    await store.truncateItems(owner, 0);

    expect(await storage.list(`execution:${owner}:itemLog:`)).toEqual([]);
    expect(await store.loadItems(owner, 3)).toEqual([]);
  });
});

describe('a rolled-back turn leaves no durable trace at any checkpoint cadence', () => {
  it('the stitched durable log equals the live log when the recovery turn writes longer batches', async () => {
    const { harness, checkpointStore } = makeHarness([
      1,
      1,
      1,
      1,
      1,
      'fail',
      3,
      1,
      1,
      1,
      1,
      1,
    ]);
    const threadId = 'cadence-longer';

    await runTurn(harness, threadId, 'turn one');
    await runTurn(harness, threadId, 'turn two (will fail)');
    await runTurn(harness, threadId, 'turn three');
    await runTurn(harness, threadId, 'turn four');

    assert(checkpointStore.loadItems);
    const watermark = harness.itemLogPersistence.get(`thread:${threadId}`);
    const raw = await checkpointStore.loadItems(`thread:${threadId}`, watermark);
    const live = await harness.previewRequestItems({
      threadId,
    });
    expect(durableTexts(raw)).toEqual(live.flatMap(itemTexts));
    expect(raw.length).toBe(watermark);
    const texts = durableTexts(raw);
    expect(texts).toContain('turn one');
    expect(texts).toContain('turn three');
    expect(texts).toContain('turn four');
    expect(texts).not.toContain('turn two (will fail)');
  });

  it('and when the recovery turn writes shorter batches than the aborted one', async () => {
    const { harness, checkpointStore } = makeHarness([
      1,
      1,
      1,
      1,
      3,
      'fail',
      1,
      1,
      1,
      1,
      1,
      1,
    ]);
    const threadId = 'cadence-shorter';

    await runTurn(harness, threadId, 'alpha');
    await runTurn(harness, threadId, 'beta (will fail)');
    await runTurn(harness, threadId, 'gamma');
    await runTurn(harness, threadId, 'delta');

    assert(checkpointStore.loadItems);
    const watermark = harness.itemLogPersistence.get(`thread:${threadId}`);
    const raw = await checkpointStore.loadItems(`thread:${threadId}`, watermark);
    const live = await harness.previewRequestItems({
      threadId,
    });

    expect(durableTexts(raw)).toEqual(live.flatMap(itemTexts));
    expect(durableTexts(raw)).toContain('alpha');
    expect(durableTexts(raw)).toContain('gamma');
    expect(durableTexts(raw)).not.toContain('beta (will fail)');
  });

  it('a restarted host restores exactly the live transcript after a failed turn', async () => {
    const { harness, checkpointStore, storage } = makeHarness([
      1,
      1,
      1,
      1,
      1,
      'fail',
      3,
      1,
      1,
    ]);
    const threadId = 'restart-after-fail';

    await runTurn(harness, threadId, 'kept one');
    await runTurn(harness, threadId, 'discarded (will fail)');
    await runTurn(harness, threadId, 'kept two');

    const live = await harness.previewRequestItems({
      threadId,
    });
    const ids = await checkpointStore.list();
    const executionId = ids[ids.length - 1]?.executionId;
    assert(executionId);

    const resumed = new AgentHarness({
      name: 'stitch-resumed',
      params: {},
      environment: {
        storage: {
          adapter: storage,
          checkpointStore: createCheckpointStore({
            storage,
          }),
        },
      },
    });
    const restored = await resumed.restore(executionId);
    assert(restored);

    expect(restored.itemLog.items.flatMap(itemTexts)).toEqual(live.flatMap(itemTexts));
    const restoredTexts = restored.itemLog.items.flatMap(itemTexts);
    expect(restoredTexts).toContain('kept one');
    expect(restoredTexts).toContain('kept two');
    expect(restoredTexts).not.toContain('discarded (will fail)');
  });

  it('reseeded history does not resurrect the pre-seed transcript on restore', async () => {
    const { harness, checkpointStore, storage } = makeHarness([
      1,
      1,
      1,
      1,
      1,
      1,
    ]);
    const threadId = 'reseed-restore';

    await runTurn(harness, threadId, 'pre-seed history');
    harness.seedSessionHistory(threadId, [
      assistantMessage('seeded A', 'seed-a'),
      assistantMessage('seeded B', 'seed-b'),
      assistantMessage('seeded C', 'seed-c'),
    ]);
    await runTurn(harness, threadId, 'post-seed turn');

    const live = await harness.previewRequestItems({
      threadId,
    });
    const ids = await checkpointStore.list();
    const executionId = ids[ids.length - 1]?.executionId;
    assert(executionId);

    const resumed = new AgentHarness({
      name: 'reseed-resumed',
      params: {},
      environment: {
        storage: {
          adapter: storage,
          checkpointStore: createCheckpointStore({
            storage,
          }),
        },
      },
    });
    const restored = await resumed.restore(executionId);
    assert(restored);

    expect(restored.itemLog.items.flatMap(itemTexts)).toEqual(live.flatMap(itemTexts));
    expect(restored.itemLog.items.flatMap(itemTexts)).not.toContain('pre-seed history');
  });
});
