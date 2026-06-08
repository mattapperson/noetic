import { describe, expect, it } from 'bun:test';
import type { Item } from '@noetic-tools/types';
import type { SessionSeedHarness } from '../../src/runtime/durable/session-seed';
import { seedFromItems } from '../../src/runtime/durable/session-seed';

interface SeedCall {
  readonly threadId: string;
  readonly items: ReadonlyArray<Item>;
}

function createFakeHarness(): {
  readonly harness: SessionSeedHarness;
  readonly calls: ReadonlyArray<SeedCall>;
} {
  const calls: SeedCall[] = [];
  return {
    harness: {
      seedSessionHistory(threadId, items) {
        calls.push({
          threadId,
          items,
        });
      },
    },
    calls,
  };
}

function userMessage(id: string, text: string): Item {
  return {
    id,
    type: 'message',
    role: 'user',
    status: 'completed',
    content: [
      {
        type: 'input_text',
        text,
      },
    ],
  };
}

describe('seedFromItems', () => {
  it('forwards the thread id and items to the harness', () => {
    const { harness, calls } = createFakeHarness();
    const items = [
      userMessage('u1', 'hi'),
      userMessage('u2', 'there'),
    ];
    seedFromItems(harness, 'thread-1', items);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.threadId).toBe('thread-1');
    expect(calls[0]?.items).toEqual(items);
  });

  it('short-circuits when items is empty', () => {
    const { harness, calls } = createFakeHarness();
    seedFromItems(harness, 'thread-1', []);
    expect(calls).toHaveLength(0);
  });
});
