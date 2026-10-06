/**
 * Durable execution × failed turns: the item-log persistence watermark must
 * follow the session log through rollback truncation, and remain harness-scoped.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData } from '@noetic-tools/context';
import type { Item, LLMResponse, MessageItem, Step } from '@noetic-tools/types';
import { defaultItemSchemaRegistry } from '@noetic-tools/types';
import { loop } from '../../src/builders/loop-builder';
import { runCode } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createCheckpointStore } from '../../src/runtime/durable/checkpoint-store';
import { ItemLogPersistence, itemLogOwnerKey } from '../../src/runtime/durable/harness-checkpoints';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { until } from '../../src/until/predicates';
import { assistantMessage } from '../_helpers';

let uniq = 0;
const ITEMS_PER_TURN = 4;

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

function makeHarness(opts?: { responses?: Array<'ok' | 'fail'> }): {
  harness: AgentHarness;
  checkpointStore: ReturnType<typeof createCheckpointStore>;
} {
  const storage = createInMemoryStorage();
  const checkpointStore = createCheckpointStore({
    storage,
  });
  const script = opts?.responses ?? [
    'ok',
  ];
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
    until: until.maxSteps(2),
    maxIterations: 2,
  });
  const harness = new AgentHarness({
    name: 'rollback-test',
    params: {},
    agentGraph: body,
    environment: {
      storage: {
        adapter: storage,
        checkpointStore,
      },
    },
    _testCallModel: async (): Promise<LLMResponse> => {
      const mode = script[Math.min(call, script.length - 1)];
      const i = call++;
      if (mode === 'fail') {
        throw new Error(`scripted turn failure #${i}`);
      }
      const message: MessageItem = assistantMessage(`answer ${i}`, `resp-${i}`);
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

describe('item-log persistence watermark under turn rollback (D1)', () => {
  it('a failed turn rolls the persistence watermark back with the log', async () => {
    const { harness } = makeHarness({
      responses: [
        'ok',
        'ok',
        'ok',
        'fail',
        'ok',
        'ok',
      ],
    });

    await harness.execute('turn one', {
      threadId: 't-roll',
    });
    await harness.getAgentResponse({
      threadId: 't-roll',
    });
    const afterTurn1 = harness.itemLogPersistence.get('thread:t-roll');
    expect(afterTurn1).toBe(ITEMS_PER_TURN);

    await harness.execute('turn two (will fail)', {
      threadId: 't-roll',
    });
    await harness
      .getAgentResponse({
        threadId: 't-roll',
      })
      .catch(() => undefined);
    const afterFail = harness.itemLogPersistence.get('thread:t-roll');
    expect(afterFail).toBeLessThanOrEqual(afterTurn1);

    await harness.execute('turn three', {
      threadId: 't-roll',
    });
    const resp = await harness.getAgentResponse({
      threadId: 't-roll',
    });
    expect(resp.text).toContain('answer');
    expect(harness.itemLogPersistence.get('thread:t-roll')).toBe(ITEMS_PER_TURN * 2);
  });

  it('restore never resurrects a rolled-back turn (durable = live)', async () => {
    const { harness, checkpointStore } = makeHarness({
      responses: [
        'ok',
        'ok',
        'ok',
        'fail',
        'ok',
        'ok',
      ],
    });
    const threadId = 't-resurrect';
    await harness.execute('turn one', {
      threadId,
    });
    await harness.getAgentResponse({
      threadId,
    });
    await harness.execute('turn two (will fail)', {
      threadId,
    });
    await harness
      .getAgentResponse({
        threadId,
      })
      .catch(() => undefined);
    await harness.execute('turn three', {
      threadId,
    });
    await harness.getAgentResponse({
      threadId,
    });

    assert(checkpointStore.loadItems);
    const raw = await checkpointStore.loadItems(
      `thread:${threadId}`,
      harness.itemLogPersistence.get(`thread:${threadId}`),
    );
    const texts = durableTexts(raw);
    expect(texts).toContain('turn one');
    expect(texts).toContain('turn three');
    expect(texts).not.toContain('turn two (will fail)');
  });
});

describe('watermarks are harness-scoped, not module-global (D2)', () => {
  it('two harnesses with the same threadId keep independent watermarks', async () => {
    const a = makeHarness();
    const b = makeHarness();

    await a.harness.execute('only harness A speaks', {
      threadId: 'main',
    });
    await a.harness.getAgentResponse({
      threadId: 'main',
    });

    expect(a.harness.itemLogPersistence.get('thread:main')).toBe(ITEMS_PER_TURN);
    expect(b.harness.itemLogPersistence.get('thread:main')).toBe(0);
  });
});

describe('ItemLogPersistence contract', () => {
  it('an unknown owner reads as zero', () => {
    const p = new ItemLogPersistence();
    expect(p.get('thread:nobody')).toBe(0);
  });

  it('set then get round-trips per owner', () => {
    const p = new ItemLogPersistence();
    p.set('thread:a', 7);
    p.set('thread:b', 2);
    expect(p.get('thread:a')).toBe(7);
    expect(p.get('thread:b')).toBe(2);
  });

  it('rollback clamps a watermark that is ahead of the live log', () => {
    const p = new ItemLogPersistence();
    p.set('thread:a', 9);
    p.rollback('thread:a', 4);
    expect(p.get('thread:a')).toBe(4);
  });

  it('rollback never raises a watermark that is already at or below the log', () => {
    const p = new ItemLogPersistence();
    p.set('thread:a', 3);
    p.rollback('thread:a', 5);
    expect(p.get('thread:a')).toBe(3);
    p.rollback('thread:a', 3);
    expect(p.get('thread:a')).toBe(3);
  });

  it('rollback on an unseen owner records nothing (stays zero)', () => {
    const p = new ItemLogPersistence();
    p.rollback('thread:unseen', 6);
    expect(p.get('thread:unseen')).toBe(0);
  });

  it('delete drops an owner back to zero', () => {
    const p = new ItemLogPersistence();
    p.set('thread:a', 5);
    p.delete('thread:a');
    expect(p.get('thread:a')).toBe(0);
  });
});

describe('itemLogOwnerKey', () => {
  it('keys on the thread when there is one', () => {
    expect(
      itemLogOwnerKey({
        threadId: 'main',
        id: 'exec-1',
      }),
    ).toBe('thread:main');
  });

  it('falls back to the execution for a threadless one-shot context', () => {
    expect(
      itemLogOwnerKey({
        id: 'exec-1',
      }),
    ).toBe('execution:exec-1');
  });

  it('capture and restore derive the same key from their different inputs', () => {
    const fromContext = itemLogOwnerKey({
      threadId: 't',
      id: 'exec-live',
    });
    const fromSnapshot = itemLogOwnerKey({
      threadId: 't',
      id: 'exec-restored',
    });
    expect(fromContext).toBe(fromSnapshot);
  });
});
