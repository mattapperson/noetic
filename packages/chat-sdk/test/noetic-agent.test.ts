import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import { noeticAgent } from '../src/noetic-agent';
import { chatMessage, fwEvent, itemIds, mockHarness, mockThread, sdkEvent } from './_helpers';

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const TRIGGER = chatMessage({
  id: 'trigger',
  text: 'do the thing',
  userName: 'alice',
});

describe('noeticAgent', () => {
  test('seeds history minus the trigger on first contact, then executes and posts', async () => {
    const harness = mockHarness({
      body: [
        sdkEvent('response.output_text.delta', {
          delta: 'done!',
        }),
      ],
    });
    const thread = mockThread({
      history: [
        chatMessage({
          id: 'h1',
          text: 'earlier',
          userName: 'alice',
          dateSent: new Date(1000),
        }),
        chatMessage({
          id: 'h2',
          text: 'reply',
          isMe: true,
          dateSent: new Date(2000),
        }),
        {
          ...TRIGGER,
          metadata: {
            dateSent: new Date(3000),
            edited: false,
          },
        },
      ],
    });

    await noeticAgent({
      harness,
    })(thread, TRIGGER);

    expect(harness.seeded).toHaveLength(1);
    expect(harness.seeded[0].threadId).toBe('thread-1');
    expect(itemIds(harness.seeded[0].items)).toEqual([
      'h1',
      'h2',
    ]);

    expect(harness.executed).toHaveLength(1);
    const { input, options } = harness.executed[0];
    assert(Array.isArray(input));
    expect(itemIds(input)).toEqual([
      'trigger',
    ]);
    assert(options);
    expect(options.threadId).toBe('thread-1');
    expect(typeof options.messageId).toBe('string');

    expect(thread.posted).toEqual([
      'done!',
    ]);
  });

  test('does not re-seed on a second message in the same thread', async () => {
    const harness = mockHarness({});
    const thread = mockThread({
      history: [
        TRIGGER,
      ],
    });
    const handler = noeticAgent({
      harness,
    });

    await handler(thread, TRIGGER);
    await handler(thread, TRIGGER);

    expect(thread.fetches).toHaveLength(1);
    expect(harness.executed).toHaveLength(2);
  });

  test('historyLimit 0 disables fetching and seeding', async () => {
    const harness = mockHarness({});
    const thread = mockThread({
      history: [
        TRIGGER,
      ],
    });

    await noeticAgent({
      harness,
      historyLimit: 0,
    })(thread, TRIGGER);

    expect(thread.fetches).toHaveLength(0);
    expect(harness.seeded).toHaveLength(0);
    expect(harness.executed).toHaveLength(1);
  });

  test('custom threadId mapping flows into execute and the stream scope', async () => {
    const harness = mockHarness({});
    const thread = mockThread({
      history: [],
    });

    await noeticAgent({
      harness,
      threadId: (t) => `slack:${t.id}`,
    })(thread, TRIGGER);

    assert(harness.executed[0].options);
    expect(harness.executed[0].options.threadId).toBe('slack:thread-1');
    expect(harness.streamScopes[0]).toEqual({
      threadId: 'slack:thread-1',
    });
  });

  test('deliveryMode is forwarded to execute', async () => {
    const harness = mockHarness({});
    const thread = mockThread({
      history: [],
    });

    await noeticAgent({
      harness,
      deliveryMode: 'interrupt',
    })(thread, TRIGGER);

    assert(harness.executed[0].options);
    expect(harness.executed[0].options.deliveryMode).toBe('interrupt');
  });

  test('a second message on the same thread streams its own turn (no hang)', async () => {
    // Regression: the broadcaster discards events once its consumer set
    // empties, and execute() emits turn_started synchronously — a handler
    // subscribing after execute() would wait forever on message 2.
    const harness = mockHarness({
      body: [
        sdkEvent('response.output_text.delta', {
          delta: 'reply',
        }),
      ],
    });
    const thread = mockThread({
      history: [],
    });
    const handler = noeticAgent({
      harness,
      historyLimit: 0,
    });

    await handler(
      thread,
      chatMessage({
        id: 'm1',
        text: 'one',
        userName: 'a',
      }),
    );
    await handler(
      thread,
      chatMessage({
        id: 'm2',
        text: 'two',
        userName: 'a',
      }),
    );

    expect(thread.posted).toEqual([
      'reply',
      'reply',
    ]);
  });

  test('messages coalesced into one turn post exactly once', async () => {
    const harness = mockHarness({
      autoTurn: false,
    });
    const thread = mockThread({
      history: [],
    });
    const handler = noeticAgent({
      harness,
      historyLimit: 0,
    });

    const first = handler(
      thread,
      chatMessage({
        id: 'm1',
        text: 'one',
        userName: 'a',
      }),
    );
    const second = handler(
      thread,
      chatMessage({
        id: 'm2',
        text: 'two',
        userName: 'a',
      }),
    );
    await tick();
    const ids = harness.executed.map((e) => e.options?.messageId);
    harness.emit(
      fwEvent('turn_started', {
        turnId: 't1',
        messageIds: ids,
      }),
    );
    harness.emit(
      sdkEvent('response.output_text.delta', {
        delta: 'shared reply',
      }),
    );
    harness.emit(
      fwEvent('turn_completed', {
        turnId: 't1',
      }),
    );
    await Promise.all([
      first,
      second,
    ]);

    expect(thread.posted).toEqual([
      'shared reply',
    ]);
  });

  test('a between-rounds injection claims the running turn', async () => {
    const harness = mockHarness({
      autoTurn: false,
    });
    const thread = mockThread({
      history: [],
    });
    const handler = noeticAgent({
      harness,
      historyLimit: 0,
      deliveryMode: 'between-rounds',
    });

    const pending = handler(
      thread,
      chatMessage({
        id: 'm1',
        text: 'go',
        userName: 'a',
      }),
    );
    await tick();
    const messageId = harness.executed[0].options?.messageId;
    harness.emit(
      fwEvent('turn_started', {
        turnId: 't1',
        messageIds: [
          'someone-else',
        ],
      }),
    );
    harness.emit(
      fwEvent('inbox_injected', {
        round: 1,
        count: 1,
        messageIds: [
          messageId,
        ],
      }),
    );
    harness.emit(
      sdkEvent('response.output_text.delta', {
        delta: 'mid-turn reply',
      }),
    );
    harness.emit(
      fwEvent('turn_completed', {
        turnId: 't1',
      }),
    );
    await pending;

    expect(thread.posted).toEqual([
      'mid-turn reply',
    ]);
  });

  test('a message that converts to no items is ignored', async () => {
    const harness = mockHarness({});
    const thread = mockThread({
      history: [],
    });

    await noeticAgent({
      harness,
      historyLimit: 0,
    })(
      thread,
      chatMessage({
        id: 'empty',
      }),
    );

    expect(harness.executed).toHaveLength(0);
    expect(thread.posted).toEqual([]);
  });

  test('a failed seed is reported, the turn still runs, and the next message retries seeding', async () => {
    const harness = mockHarness({});
    const failure = new Error('fetch failed');
    const thread = mockThread({
      fetchError: failure,
    });
    const errors: unknown[] = [];
    const handler = noeticAgent({
      harness,
      onError: (e) => void errors.push(e),
    });

    await handler(thread, TRIGGER);
    expect(errors).toEqual([
      failure,
    ]);
    // Seed failure is non-fatal: the triggering message still runs.
    expect(harness.executed).toHaveLength(1);

    // The thread was NOT poisoned — the next message fetches again.
    await handler(thread, TRIGGER);
    expect(thread.fetches).toHaveLength(2);
  });

  test('without onError a seed failure is non-fatal and the turn runs', async () => {
    const harness = mockHarness({});
    const thread = mockThread({
      fetchError: new Error('fetch failed'),
    });

    await noeticAgent({
      harness,
    })(thread, TRIGGER);
    expect(harness.executed).toHaveLength(1);
  });
});
