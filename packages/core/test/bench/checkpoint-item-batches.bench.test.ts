/**
 * Opt-in checkpoint item-batch benchmark.
 *
 * Compares repeated checkpoints on a growing session transcript between the
 * legacy inline-snapshot store and the batched CheckpointStore.
 *
 * Run with:
 *   NOETIC_RUN_BENCH=1 bun test packages/core/test/bench/checkpoint-item-batches.bench.test.ts
 */

import { describe, expect, it } from 'bun:test';
import type { LLMResponse, MessageItem, StorageAdapter } from '@noetic-tools/types';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createCheckpointStore } from '../../src/runtime/durable/checkpoint-store';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { assistantMessage } from '../_helpers';

const SHOULD_RUN = process.env.NOETIC_RUN_BENCH === '1';
const TURNS = 150;

function harnessWithStore(storage: StorageAdapter, batched: boolean): AgentHarness {
  const full = createCheckpointStore({
    storage,
  });
  const checkpointStore = batched
    ? full
    : {
        save: full.save,
        load: full.load,
        list: full.list,
        clear: full.clear,
      };
  let call = 0;
  return new AgentHarness({
    name: batched ? 'bench-batched' : 'bench-inline',
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
}

async function runSession(harness: AgentHarness, threadId: string): Promise<number> {
  const start = performance.now();
  for (let i = 0; i < TURNS; i++) {
    await harness.execute(`turn ${i}`, {
      threadId,
    });
    await harness.getAgentResponse({
      threadId,
    });
  }
  return performance.now() - start;
}

describe.skipIf(!SHOULD_RUN)('checkpoint item batches benchmark', () => {
  it('logs batched vs inline checkpoint time on a growing transcript', async () => {
    const batchedMs = await runSession(harnessWithStore(createInMemoryStorage(), true), 'bench');
    const inlineMs = await runSession(harnessWithStore(createInMemoryStorage(), false), 'bench');

    console.log(
      `checkpoint batches benchmark: batched=${batchedMs.toFixed(2)}ms inline=${inlineMs.toFixed(2)}ms turns=${TURNS}`,
    );

    expect(Number.isFinite(batchedMs)).toBe(true);
    expect(Number.isFinite(inlineMs)).toBe(true);
    expect(batchedMs).toBeGreaterThan(0);
    expect(inlineMs).toBeGreaterThan(0);
  });
});
