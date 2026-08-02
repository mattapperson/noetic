import { describe, expect, test } from 'bun:test';
import type { InputMessageItem } from '@noetic-tools/types';
import type { ChatStateLike } from '../src/history-store';
import { createChatHistoryStore } from '../src/history-store';
import { noeticAgent } from '../src/noetic-agent';
import { chatMessage, itemIds, mockHarness, mockThread } from './_helpers';

function memoryState(): ChatStateLike & {
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  return {
    data,
    get: (key) => Promise.resolve(data.get(key) ?? null),
    set: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

function userItem(id: string, text: string): InputMessageItem {
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

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createChatHistoryStore', () => {
  test('reads empty history as []', async () => {
    const store = createChatHistoryStore(memoryState());
    expect(await store.readChatHistory('t1')).toEqual([]);
  });

  test('append/read round-trips items in order', async () => {
    const store = createChatHistoryStore(memoryState());
    await store.appendChatItem('t1', userItem('a', 'first'));
    await store.appendChatItem('t1', userItem('b', 'second'));
    expect(itemIds(await store.readChatHistory('t1'))).toEqual([
      'a',
      'b',
    ]);
  });

  test('concurrent appends do not drop items', async () => {
    const store = createChatHistoryStore(memoryState());
    await Promise.all(
      Array.from(
        {
          length: 10,
        },
        (_, i) => store.appendChatItem('t1', userItem(`i${i}`, 'x')),
      ),
    );
    expect(await store.readChatHistory('t1')).toHaveLength(10);
  });

  test('histories are per thread', async () => {
    const store = createChatHistoryStore(memoryState());
    await store.appendChatItem('t1', userItem('a', 'x'));
    expect(await store.readChatHistory('t2')).toEqual([]);
  });

  test('corrupt stored state reads as empty history instead of throwing', async () => {
    const state = memoryState();
    state.data.set('noetic:history:t1', '{not json');
    state.data.set('noetic:history:t2', '[{"noType": true}]');
    const store = createChatHistoryStore(state);
    expect(await store.readChatHistory('t1')).toEqual([]);
    expect(await store.readChatHistory('t2')).toEqual([]);
    // Appending over a corrupt key starts fresh rather than failing forever.
    await store.appendChatItem('t1', userItem('a', 'recovered'));
    expect(itemIds(await store.readChatHistory('t1'))).toEqual([
      'a',
    ]);
  });

  test('isSeeded flips after markSeeded', async () => {
    const store = createChatHistoryStore(memoryState());
    expect(await store.isSeeded('t1')).toBe(false);
    await store.markSeeded('t1');
    expect(await store.isSeeded('t1')).toBe(true);
  });
});

describe('noeticAgent with a history store', () => {
  test('first contact seeds from the platform, persists, and marks seeded', async () => {
    const store = createChatHistoryStore(memoryState());
    const harness = mockHarness({});
    const trigger = chatMessage({
      id: 'trigger',
      text: 'go',
      userName: 'alice',
    });
    const thread = mockThread({
      history: [
        chatMessage({
          id: 'h1',
          text: 'earlier',
          userName: 'alice',
          dateSent: new Date(1000),
        }),
        {
          ...trigger,
          metadata: {
            dateSent: new Date(2000),
            edited: false,
          },
        },
      ],
    });

    await noeticAgent({
      harness,
      history: store,
    })(thread, trigger);

    expect(await store.isSeeded('thread-1')).toBe(true);
    // Seeded platform history plus the triggering input item.
    expect(itemIds(await store.readChatHistory('thread-1'))).toEqual([
      'h1',
      'trigger',
    ]);
  });

  test('a seeded store replaces platform fetch after a restart', async () => {
    const state = memoryState();
    const store = createChatHistoryStore(state);
    await store.appendChatItem('thread-1', userItem('persisted', 'from last run'));
    await store.markSeeded('thread-1');

    const harness = mockHarness({});
    const thread = mockThread({
      history: [],
    });
    const trigger = chatMessage({
      id: 'trigger',
      text: 'again',
      userName: 'alice',
    });

    await noeticAgent({
      harness,
      history: store,
    })(thread, trigger);

    expect(thread.fetches).toHaveLength(0);
    expect(harness.seeded).toHaveLength(1);
    expect(itemIds(harness.seeded[0].items)).toEqual([
      'persisted',
    ]);
  });

  test('the item pump persists completed model items', async () => {
    const store = createChatHistoryStore(memoryState());
    const harness = mockHarness({
      items: [
        {
          ...userItem('partial', 'streaming'),
          isComplete: false,
        },
        {
          ...userItem('final', 'done'),
          isComplete: true,
        },
      ],
    });
    const thread = mockThread({
      history: [],
    });
    const trigger = chatMessage({
      id: 'trigger',
      text: 'go',
      userName: 'alice',
    });

    await noeticAgent({
      harness,
      history: store,
      historyLimit: 0,
    })(thread, trigger);
    await tick();

    const persisted = itemIds(await store.readChatHistory('thread-1'));
    expect(persisted).toContain('trigger');
    expect(persisted).toContain('final');
    expect(persisted).not.toContain('partial');
  });
});
