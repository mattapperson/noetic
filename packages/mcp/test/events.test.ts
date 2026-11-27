import { afterEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { AgentHarness, createInMemoryStorage, runCode } from '@noetic-tools/core';
import type {
  Connection,
  ConnectionEventInit,
  ConnectionTrigger,
  EventStream,
  EventStreamMessage,
} from '@noetic-tools/types';
import { NoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';
import { refreshDelay } from '../src/events';
import type { McpWebhooks, WebhookDelivery, WebhookReply } from '../src/webhooks';
import { signWebhook } from '../src/webhooks';
import type { TestServerOptions } from './_helpers';
import { connectOptions, TestServer, waitFor } from './_helpers';
import { kioskServerOptions, kioskState } from './_profiles';

type Message = EventStreamMessage<ConnectionEventInit>;

const opened: Connection[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.release()));
});

async function connect(
  overrides: Partial<TestServerOptions>,
  webhooks?: McpWebhooks,
): Promise<{
  connection: Connection;
  fixture: TestServer;
}> {
  const fixture = new TestServer(kioskServerOptions(kioskState(), overrides));
  const [connection] = await fixture
    .provider(
      webhooks === undefined
        ? {}
        : {
            webhooks,
          },
    )
    .connect(connectOptions('kiosk'));
  assert(connection !== undefined);
  opened.push(connection);
  return {
    connection,
    fixture,
  };
}

function collect(stream: EventStream): {
  messages: Message[];
  done: Promise<void>;
} {
  const messages: Message[] = [];
  const done = (async (): Promise<void> => {
    for await (const message of stream) {
      messages.push(message);
    }
  })();
  return {
    messages,
    done,
  };
}

/** A receiver that hands deliveries straight to the bridge's handler. */
function fakeReceiver(): {
  webhooks: McpWebhooks;
  deliver: (delivery: WebhookDelivery) => Promise<WebhookReply>;
  closed: () => boolean;
} {
  let handler: ((delivery: WebhookDelivery) => Promise<WebhookReply>) | undefined;
  let closed = false;
  return {
    webhooks: {
      receiver: {
        register: async (h) => {
          handler = h;
          return {
            url: 'https://hooks.example.test/noetic/1',
            close: async () => {
              closed = true;
            },
          };
        },
      },
    },
    deliver: async (delivery) => {
      assert(handler !== undefined);
      return handler(delivery);
    },
    closed: () => closed,
  };
}

describe('push delivery (events/stream)', () => {
  it('confirms the stream, delivers events in order, dedupes ids, and reports a skip as a gap', async () => {
    const { connection, fixture } = await connect({});
    const stream = connection.listen({
      event: 'kiosk.printed',
      arguments: {
        ticket: 't1',
      },
      signal: new AbortController().signal,
    });
    expect(await stream.ready).toEqual({
      cursor: 'c0',
    });
    const sub = [
      ...fixture.subscriptions.values(),
    ].find((s) => s.name === 'kiosk.printed');
    expect(sub?.arguments).toEqual({
      ticket: 't1',
    });
    const { messages } = collect(stream);
    await fixture.emit({
      eventId: 'e1',
      name: 'kiosk.printed',
      data: {
        text: 'one',
      },
      cursor: 'c1',
      actionId: 'a1',
    });
    await fixture.emit({
      eventId: 'e1',
      name: 'kiosk.printed',
      data: {
        text: 'one again',
      },
    });
    await fixture.gap('kiosk.printed', 'c5');
    await fixture.emit({
      eventId: 'e2',
      name: 'kiosk.printed',
      data: {
        text: 'two',
      },
    });
    await waitFor(() => messages.length === 3);
    expect(messages).toEqual([
      {
        type: 'event',
        event: {
          id: 'e1',
          type: 'kiosk.printed',
          time: new Date(0).toISOString(),
          payload: {
            text: 'one',
          },
          cursor: 'c1',
          actionId: 'a1',
        },
      },
      {
        type: 'gap',
        reason: 'the server skipped ahead of the cursor: events may be missing',
      },
      {
        type: 'event',
        event: {
          id: 'e2',
          type: 'kiosk.printed',
          time: new Date(0).toISOString(),
          payload: {
            text: 'two',
          },
          cursor: null,
        },
      },
    ]);
    await stream.close();
    await waitFor(() => fixture.unsubscribed.length === 1);
  });

  it('ends with terminated when the server terminates the subscription', async () => {
    const { connection, fixture } = await connect({});
    const stream = connection.listen({
      event: 'kiosk.printed',
      signal: new AbortController().signal,
    });
    await stream.ready;
    const { messages, done } = collect(stream);
    await fixture.terminate('kiosk.printed', 'subscription expired');
    await done;
    expect(messages).toEqual([
      {
        type: 'terminated',
        reason: 'subscription expired (-32024)',
      },
    ]);
  });

  it('closes when its signal aborts', async () => {
    const { connection, fixture } = await connect({});
    const controller = new AbortController();
    const stream = connection.listen({
      event: 'kiosk.printed',
      signal: controller.signal,
    });
    await stream.ready;
    const { done } = collect(stream);
    controller.abort();
    await done;
    await waitFor(() => fixture.unsubscribed.length === 1);
  });

  it('stores inline binary in event payloads as blobs', async () => {
    const { connection, fixture } = await connect({});
    const stream = connection.listen({
      event: 'kiosk.printed',
      signal: new AbortController().signal,
    });
    await stream.ready;
    const { messages } = collect(stream);
    await fixture.emit({
      eventId: 'e1',
      name: 'kiosk.printed',
      data: {
        scan: {
          $blob: {
            data: btoa('pixels'),
            mimeType: 'image/png',
          },
        },
      },
    });
    await waitFor(() => messages.length === 1);
    const first = messages[0];
    assert(first?.type === 'event');
    expect(first.event.payload).toMatchObject({
      scan: {
        $blob: {
          mimeType: 'image/png',
          bytes: 6,
        },
      },
    });
    await stream.close();
  });
});

describe('push stream liveness', () => {
  it('commits a heartbeat cursor after the events before it are stored', async () => {
    const { connection, fixture } = await connect({});
    const cursors: string[] = [];
    const stream = connection.listen({
      event: 'kiosk.printed',
      stores: true,
      checkpoint: async (cursor) => {
        cursors.push(cursor);
      },
      signal: new AbortController().signal,
    });
    await stream.ready;
    const { messages } = collect(stream);
    await fixture.emit({
      eventId: 'e1',
      name: 'kiosk.printed',
      data: {
        text: 'one',
      },
    });
    await fixture.heartbeat('kiosk.printed', 'c7');
    await waitFor(() => messages.length === 1);
    // The listener had no place, so it keeps the one the server started it from.
    expect(cursors).toEqual([
      'c0',
    ]);
    const message = messages[0];
    assert(message?.type === 'event' && message.stored);
    message.stored();
    await waitFor(() => cursors.includes('c7'));
    await stream.close();
  });

  it('keeps its own place over the one the server grants', async () => {
    const { connection, fixture } = await connect({});
    const cursors: string[] = [];
    const stream = connection.listen({
      event: 'kiosk.printed',
      cursor: 'c5',
      stores: true,
      checkpoint: async (cursor) => {
        cursors.push(cursor);
      },
      signal: new AbortController().signal,
    });
    await stream.ready;
    await fixture.heartbeat('kiosk.printed', 'c7');
    await waitFor(() => cursors.length === 1);
    expect(cursors).toEqual([
      'c7',
    ]);
    await stream.close();
  });

  it('keeps its place behind an event that was not stored', async () => {
    const { connection, fixture } = await connect({});
    const cursors: string[] = [];
    const stream = connection.listen({
      event: 'kiosk.printed',
      stores: true,
      checkpoint: async (cursor) => {
        cursors.push(cursor);
      },
      signal: new AbortController().signal,
    });
    await stream.ready;
    const { messages, done } = collect(stream);
    await fixture.emit({
      eventId: 'e1',
      name: 'kiosk.printed',
      data: {
        text: 'one',
      },
    });
    await fixture.heartbeat('kiosk.printed', 'c7');
    await waitFor(() => messages.length === 1);
    const message = messages[0];
    assert(message?.type === 'event' && message.stored);
    message.stored(new Error('inbox unavailable'));
    await done;
    expect(messages.at(-1)).toMatchObject({
      type: 'terminated',
      reason: 'inbox unavailable',
    });
    expect(cursors).toEqual([
      'c0',
    ]);
  });

  it('takes the place the server skipped ahead to, over its own', async () => {
    const { connection, fixture } = await connect({});
    const cursors: string[] = [];
    const stream = connection.listen({
      event: 'kiosk.printed',
      cursor: 'c5',
      stores: true,
      checkpoint: async (cursor) => {
        cursors.push(cursor);
      },
      signal: new AbortController().signal,
    });
    await stream.ready;
    const { messages } = collect(stream);
    await fixture.gap('kiosk.printed', 'c9');
    await waitFor(() => cursors.length === 1);
    expect(messages.map((m) => m.type)).toEqual([
      'gap',
    ]);
    expect(cursors).toEqual([
      'c9',
    ]);
    await stream.close();
  });

  it('ends a stream that misses its heartbeats, and one the server closes', async () => {
    const quiet = await connect({
      heartbeatMs: 5,
    });
    const silent = collect(
      quiet.connection.listen({
        event: 'kiosk.printed',
        signal: new AbortController().signal,
      }),
    );
    await silent.done;
    expect(silent.messages).toEqual([
      {
        type: 'terminated',
        reason: 'the event stream went quiet',
      },
    ]);

    const { connection, fixture } = await connect({});
    const stream = connection.listen({
      event: 'kiosk.printed',
      signal: new AbortController().signal,
    });
    await stream.ready;
    const closed = collect(stream);
    fixture.closeStreams('kiosk.printed');
    await closed.done;
    expect(closed.messages).toEqual([
      {
        type: 'terminated',
        reason: 'the server closed the event stream',
      },
    ]);
  });
});

describe('a trigger on an MCP event', () => {
  it('starts one run for an event the server delivers twice, and stops when access is revoked', async () => {
    const fixture = new TestServer(
      kioskServerOptions(kioskState(), {
        delivery: [
          'push',
        ],
      }),
    );
    let calls = 0;
    const harness = new AgentHarness({
      name: 'print-workflow',
      params: {},
      agentGraph: runCode({
        id: 'print',
        execute: async () => {
          calls++;
          return 'printed';
        },
      }),
      environment: {
        storage: {
          adapter: createInMemoryStorage(),
        },
      },
      connections: {
        kiosk: fixture.provider(),
      },
      triggerTurnOn: [
        {
          id: 'print',
          connection: 'kiosk',
          event: 'kiosk.printed',
          input: 'event.payload.text',
        },
      ],
    });
    const printing = (): boolean =>
      [
        ...fixture.subscriptions.values(),
      ].some((sub) => sub.name === 'kiosk.printed');
    try {
      await harness.start();
      await waitFor(printing);
      const event = {
        eventId: 'e1',
        name: 'kiosk.printed',
        data: {
          text: 'one',
        },
        cursor: 'p1',
      };
      await fixture.emit(event);
      await fixture.emit(event);
      await waitFor(() => calls === 1);
      await harness.waitForIdle();
      expect(await harness.getTriggerOutcomes('print')).toMatchObject([
        {
          eventId: 'e1',
          status: 'delivered',
        },
      ]);
      // The server owns the grant: it ends the subscription, and nothing more arrives.
      await fixture.terminate('kiosk.printed', 'Access revoked');
      await waitFor(() => !printing());
      expect(calls).toBe(1);
    } finally {
      await harness.close();
    }
  });
});

describe('a trigger checked against what the server declares', () => {
  const printed = {
    name: 'kiosk.printed',
    replay: 'live' as const,
    inputSchema: {
      type: 'object',
      properties: {
        ticket: {
          type: 'string',
        },
      },
      additionalProperties: false,
    },
    payloadSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
        },
      },
      required: [
        'text',
      ],
    },
  };

  function harnessWith(trigger: Partial<ConnectionTrigger>): AgentHarness {
    const fixture = new TestServer(
      kioskServerOptions(kioskState(), {
        events: [
          printed,
          {
            name: 'identity.changed',
          },
        ],
      }),
    );
    return new AgentHarness({
      name: 'print-workflow',
      params: {},
      agentGraph: runCode({
        id: 'print',
        execute: async () => 'printed',
      }),
      connections: {
        kiosk: fixture.provider(),
      },
      triggerTurnOn: [
        {
          id: 'print',
          connection: 'kiosk',
          event: 'kiosk.printed',
          input: 'event.payload.text',
          ...trigger,
        },
      ],
    });
  }

  it('starts when the trigger fits the event', async () => {
    const harness = harnessWith({
      arguments: {
        ticket: 't1',
      },
      payload: z.object({
        text: z.string(),
      }),
    });
    await harness.start();
    await harness.close();
  });

  it('does not start on arguments, a field or a payload the event does not have', async () => {
    for (const [trigger, problem] of [
      [
        {
          arguments: {
            ticket: 7,
          },
        },
        "gives arguments that event 'kiosk.printed' of connection 'kiosk' does not accept",
      ],
      [
        {
          input: 'event.payload.body',
        },
        "reads 'event.payload.body' in its input",
      ],
      [
        {
          payload: z.object({
            text: z.string(),
            copies: z.number(),
          }),
        },
        'payload.copies is not declared',
      ],
    ] as const) {
      const harness = harnessWith(trigger);
      const error = await harness.start().then(
        () => undefined,
        (e: unknown) => e,
      );
      assert(error instanceof NoeticConfigError);
      expect(error.code).toBe('CONNECTION_INVALID');
      expect(error.message).toContain(problem);
      await harness.close();
    }
  });
});

describe('poll delivery (events/poll)', () => {
  it('does not advance a storing listener’s poll cursor before acknowledgement', async () => {
    const { connection, fixture } = await connect({
      delivery: [
        'poll',
      ],
    });
    await fixture.emit({
      eventId: 'e1',
      name: 'kiosk.printed',
      data: {
        text: 'one',
      },
      cursor: 'p1',
    });
    const cursors: string[] = [];
    const stream = connection.listen({
      event: 'kiosk.printed',
      stores: true,
      checkpoint: async (cursor) => {
        cursors.push(cursor);
      },
      signal: new AbortController().signal,
    });
    await stream.ready;
    const { messages } = collect(stream);
    await waitFor(() => messages.length === 1);
    expect(cursors).toEqual([]);
    const message = messages[0];
    assert(message?.type === 'event' && message.stored);
    message.stored();
    await waitFor(() => cursors.includes('p1'));
    await stream.close();
  });

  it('polls with the advancing cursor when the server offers only poll', async () => {
    const { connection, fixture } = await connect({
      delivery: [
        'poll',
      ],
    });
    const stream = connection.listen({
      event: 'kiosk.printed',
      signal: new AbortController().signal,
    });
    expect(await stream.ready).toEqual({
      cursor: 'p0',
    });
    const { messages } = collect(stream);
    await fixture.emit({
      eventId: 'e1',
      name: 'kiosk.printed',
      data: {
        text: 'one',
      },
      cursor: 'p1',
    });
    await waitFor(() => messages.length === 1);
    await waitFor(() => fixture.polled.some((p) => p.cursor === 'p1'));
    expect(messages[0]).toMatchObject({
      event: {
        id: 'e1',
        cursor: 'p1',
      },
    });
    fixture.pollTruncated = 'kiosk.printed';
    await waitFor(() => messages.length === 2);
    expect(messages[1]).toEqual({
      type: 'gap',
      reason: 'the server skipped ahead of the cursor: events may be missing',
    });
    // A subscription the server ended answers the next poll with an error.
    fixture.pollError = 'Access revoked';
    await waitFor(() => messages.length === 3);
    expect(messages[2]).toMatchObject({
      type: 'terminated',
      reason: expect.stringContaining('Access revoked'),
    });
  });

  it('reads the next page at once while the server has more', async () => {
    const { connection, fixture } = await connect({
      delivery: [
        'poll',
      ],
    });
    fixture.pollPage = 1;
    fixture.nextPollMs = 6e4;
    for (const id of [
      'e1',
      'e2',
      'e3',
    ]) {
      await fixture.emit({
        eventId: id,
        name: 'kiosk.printed',
        data: {
          text: id,
        },
        cursor: `p-${id}`,
      });
    }
    const stream = connection.listen({
      event: 'kiosk.printed',
      signal: new AbortController().signal,
    });
    const { messages } = collect(stream);
    await waitFor(() => messages.length === 3);
    expect(messages.map((m) => (m.type === 'event' ? m.event.id : m.type))).toEqual([
      'e1',
      'e2',
      'e3',
    ]);
    await stream.close();
  });

  it('checkpoints only when the cursor moves', async () => {
    const { connection, fixture } = await connect({
      delivery: [
        'poll',
      ],
    });
    const cursors: string[] = [];
    const stream = connection.listen({
      event: 'kiosk.printed',
      cursor: 'p4',
      stores: true,
      checkpoint: async (cursor) => {
        cursors.push(cursor);
      },
      signal: new AbortController().signal,
    });
    await stream.ready;
    await waitFor(() => fixture.polled.filter((p) => p.name === 'kiosk.printed').length >= 3);
    expect(cursors).toEqual([]);
    await stream.close();
  });

  it('waits at least the interval the server asks for', async () => {
    const { connection, fixture } = await connect({
      delivery: [
        'poll',
      ],
    });
    fixture.nextPollMs = 6e4;
    const stream = connection.listen({
      event: 'kiosk.printed',
      signal: new AbortController().signal,
    });
    await stream.ready;
    await Bun.sleep(50);
    expect(fixture.polled.filter((p) => p.name === 'kiosk.printed')).toHaveLength(1);
    await stream.close();
  });

  it("confirms from before the first batch's events, so a resume does not skip them", async () => {
    const { connection, fixture } = await connect({
      delivery: [
        'poll',
      ],
    });
    await fixture.emit({
      eventId: 'early',
      name: 'kiosk.printed',
      data: {
        text: 'queued before the first poll',
      },
      cursor: 'p5',
    });
    const stream = connection.listen({
      event: 'kiosk.printed',
      cursor: 'p4',
      signal: new AbortController().signal,
    });
    expect(await stream.ready).toEqual({
      cursor: 'p4',
    });
    await stream.close();
  });

  it('resumes from a given cursor', async () => {
    const { connection, fixture } = await connect({
      delivery: [
        'poll',
      ],
    });
    const stream = connection.listen({
      event: 'kiosk.printed',
      cursor: 'p9',
      signal: new AbortController().signal,
    });
    expect(await stream.ready).toEqual({
      cursor: 'p9',
    });
    expect(fixture.polled.find((p) => p.name === 'kiosk.printed')?.cursor).toBe('p9');
    await stream.close();
  });
});

describe('webhook delivery (events/subscribe)', () => {
  it('prefers webhook when a receiver is configured, and verifies deliveries', async () => {
    const receiver = fakeReceiver();
    const { connection, fixture } = await connect(
      {
        delivery: [
          'webhook',
          'push',
          'poll',
        ],
      },
      receiver.webhooks,
    );
    const replies: number[] = [];
    fixture.webhookSink = async (sub, body) => {
      assert(sub.secret !== undefined);
      const text = JSON.stringify(body);
      const headers = await signWebhook({
        secret: sub.secret,
        id: `msg-${String(body.eventId ?? body.type)}`,
        timestampSec: Math.floor(Date.now() / 1e3),
        body: text,
      });
      replies.push(
        (
          await receiver.deliver({
            headers: {
              ...headers,
              'x-mcp-subscription-id': String(sub.id),
            },
            body: text,
          })
        ).status,
      );
    };
    const stream = connection.listen({
      event: 'kiosk.printed',
      signal: new AbortController().signal,
    });
    await stream.ready;
    expect(fixture.polled.filter((p) => p.name === 'kiosk.printed').length).toBe(0);
    const sub = [
      ...fixture.subscriptions.values(),
    ].find((s) => s.name === 'kiosk.printed');
    expect(sub?.delivery).toBe('webhook');
    expect(sub?.url).toBe('https://hooks.example.test/noetic/1');
    expect(sub?.secret?.startsWith('whsec_')).toBe(true);
    assert(sub?.secret !== undefined);
    const challenge = JSON.stringify({
      type: 'verification',
      challenge: 'nonce-1',
    });
    expect(
      await receiver.deliver({
        headers: await signWebhook({
          secret: sub.secret,
          id: 'msg_verification_1',
          timestampSec: Math.floor(Date.now() / 1e3),
          body: challenge,
        }),
        body: challenge,
      }),
    ).toEqual({
      status: 200,
      body: JSON.stringify({
        challenge: 'nonce-1',
      }),
    });
    const { messages, done } = collect(stream);
    await fixture.emit({
      eventId: 'e1',
      name: 'kiosk.printed',
      data: {
        text: 'one',
      },
    });
    await fixture.emit({
      eventId: 'e1',
      name: 'kiosk.printed',
      data: {
        text: 'one',
      },
    });
    expect(replies).toEqual([
      204,
      200,
    ]);
    const stray = JSON.stringify({
      eventId: 'e9',
      name: 'kiosk.printed',
      timestamp: new Date(0).toISOString(),
      data: {},
    });
    expect(
      await receiver.deliver({
        headers: {
          ...(await signWebhook({
            secret: sub.secret,
            id: 'msg-stray',
            timestampSec: Math.floor(Date.now() / 1e3),
            body: stray,
          })),
          'x-mcp-subscription-id': 'someone-else',
        },
        body: stray,
      }),
    ).toEqual({
      status: 400,
    });
    await fixture.gap('kiosk.printed', 'c9');
    const forged = await receiver.deliver({
      headers: {
        'webhook-id': 'forged',
        'webhook-timestamp': String(Math.floor(Date.now() / 1e3)),
        'webhook-signature': 'v1,AAAA',
      },
      body: '{}',
    });
    expect(forged.status).toBe(401);
    await fixture.terminate('kiosk.printed', 'done');
    await done;
    expect(messages.map((m) => m.type)).toEqual([
      'event',
      'gap',
      'terminated',
    ]);
    expect(receiver.closed()).toBe(true);
  });

  it('subscribes again before the subscription lapses, and unsubscribes by its url', async () => {
    const receiver = fakeReceiver();
    const { connection, fixture } = await connect(
      {
        delivery: [
          'webhook',
        ],
        refreshMs: 20,
      },
      receiver.webhooks,
    );
    const stream = connection.listen({
      event: 'kiosk.printed',
      cursor: 'c3',
      signal: new AbortController().signal,
    });
    await stream.ready;
    const printed = (): Array<Record<string, unknown>> =>
      fixture.subscribes.filter((params) => params.name === 'kiosk.printed');
    await waitFor(() => printed().length >= 2, 4e3);
    expect(printed()[0]).toMatchObject({
      name: 'kiosk.printed',
      cursor: 'c3',
      delivery: {
        mode: 'webhook',
        url: 'https://hooks.example.test/noetic/1',
      },
    });
    expect(printed()[1]).toMatchObject({
      cursor: 'c3',
    });
    await stream.close();
    expect(fixture.unsubscribed).toContain('sub-kiosk.printed-https://hooks.example.test/noetic/1');
  });

  it('keeps the place a subscription starts from, and the one each refresh reports', async () => {
    const receiver = fakeReceiver();
    const fresh = await connect(
      {
        delivery: [
          'webhook',
        ],
      },
      receiver.webhooks,
    );
    const started: string[] = [];
    const first = fresh.connection.listen({
      event: 'kiosk.printed',
      stores: true,
      checkpoint: async (cursor) => {
        started.push(cursor);
      },
      signal: new AbortController().signal,
    });
    await first.ready;
    await waitFor(() => started.length === 1);
    expect(started).toEqual([
      'c0',
    ]);
    await first.close();

    const quiet = await connect(
      {
        delivery: [
          'webhook',
        ],
        refreshMs: 20,
      },
      fakeReceiver().webhooks,
    );
    const moved: string[] = [];
    const second = quiet.connection.listen({
      event: 'kiosk.printed',
      cursor: 'c3',
      stores: true,
      checkpoint: async (cursor) => {
        moved.push(cursor);
      },
      signal: new AbortController().signal,
    });
    await second.ready;
    // It had a place of its own, so the first answer's is not taken.
    expect(moved).toEqual([]);
    await waitFor(() => moved.length === 1, 4e3);
    expect(moved).toEqual([
      'c0',
    ]);
    await second.close();
  });

  it('subscribes again from the last event it stored, not one still in hand', async () => {
    const receiver = fakeReceiver();
    const { connection, fixture } = await connect(
      {
        delivery: [
          'webhook',
        ],
        refreshMs: 20,
      },
      receiver.webhooks,
    );
    fixture.webhookSink = async (sub, body) => {
      assert(sub.secret !== undefined);
      const text = JSON.stringify(body);
      await receiver.deliver({
        headers: await signWebhook({
          secret: sub.secret,
          id: `delivery-${String(body.eventId)}`,
          timestampSec: Math.floor(Date.now() / 1e3),
          body: text,
        }),
        body: text,
      });
    };
    const stream = connection.listen({
      event: 'kiosk.printed',
      cursor: 'c3',
      stores: true,
      checkpoint: async () => {},
      signal: new AbortController().signal,
    });
    await stream.ready;
    const { messages } = collect(stream);
    const send = (eventId: string, cursor: string): void => {
      void fixture
        .emit({
          eventId,
          name: 'kiosk.printed',
          data: {
            text: eventId,
          },
          cursor,
        })
        .catch(() => {});
    };
    send('e1', 'c4');
    await waitFor(() => messages.length === 1);
    const first = messages[0];
    assert(first?.type === 'event' && first.stored);
    first.stored();
    send('e2', 'c5');
    await waitFor(() => messages.length === 2);
    const printed = (): Array<Record<string, unknown>> =>
      fixture.subscribes.filter((params) => params.name === 'kiosk.printed');
    await waitFor(() => printed().length >= 2, 4e3);
    expect(printed()[1]).toMatchObject({
      cursor: 'c4',
    });
    await stream.close();
  });

  it('takes again a delivery it turned away before the subscription was confirmed', async () => {
    const receiver = fakeReceiver();
    const { connection, fixture } = await connect(
      {
        delivery: [
          'webhook',
        ],
      },
      receiver.webhooks,
    );
    const secrets = new Map<string, string>();
    const deliver = async (id: string): Promise<number> => {
      const secret = secrets.get(id);
      assert(secret !== undefined);
      const body = JSON.stringify({
        eventId: 'e1',
        name: 'kiosk.printed',
        timestamp: new Date(0).toISOString(),
        data: {
          text: 'one',
        },
      });
      const headers = await signWebhook({
        secret,
        id: 'delivery-1',
        timestampSec: Math.floor(Date.now() / 1e3),
        body,
      });
      return (
        await receiver.deliver({
          headers,
          body,
        })
      ).status;
    };
    let early: number | undefined;
    let subscription = '';
    fixture.onSubscribe = async (id) => {
      if (!id.startsWith('sub-kiosk.printed-')) {
        return;
      }
      subscription = id;
      const secret = fixture.subscriptions.get(id)?.secret;
      assert(secret !== undefined);
      secrets.set(id, secret);
      early = await deliver(id);
    };
    const stream = connection.listen({
      event: 'kiosk.printed',
      signal: new AbortController().signal,
    });
    await stream.ready;
    expect(early).toBe(503);
    const { messages } = collect(stream);
    expect(await deliver(subscription)).toBe(204);
    await waitFor(() => messages.length === 1);
    expect(await deliver(subscription)).toBe(200);
    expect(messages).toHaveLength(1);
    await stream.close();
  });

  it('waits for storage before acknowledging a signed webhook', async () => {
    const receiver = fakeReceiver();
    const { connection, fixture } = await connect(
      {
        delivery: [
          'webhook',
        ],
      },
      receiver.webhooks,
    );
    const stream = connection.listen({
      event: 'kiosk.printed',
      stores: true,
      signal: new AbortController().signal,
    });
    await stream.ready;
    let reply: number | undefined;
    fixture.webhookSink = async (sub, body) => {
      assert(sub.secret !== undefined);
      const text = JSON.stringify(body);
      const headers = await signWebhook({
        secret: sub.secret,
        id: 'delivery-1',
        timestampSec: Math.floor(Date.now() / 1e3),
        body: text,
      });
      reply = (
        await receiver.deliver({
          headers,
          body: text,
        })
      ).status;
    };
    const { messages } = collect(stream);
    const sending = fixture.emit({
      eventId: 'e1',
      name: 'kiosk.printed',
      data: {
        text: 'one',
      },
    });
    await waitFor(() => messages.length === 1);
    expect(reply).toBeUndefined();
    const message = messages[0];
    assert(message?.type === 'event' && message.stored);
    message.stored(new Error('inbox unavailable'));
    await sending;
    expect(reply).toBe(503);
    await stream.close();
  });

  it('falls back to poll when the server offers webhooks but no receiver is configured', async () => {
    const { connection, fixture } = await connect({
      delivery: [
        'webhook',
        'poll',
      ],
    });
    const stream = connection.listen({
      event: 'kiosk.printed',
      signal: new AbortController().signal,
    });
    await stream.ready;
    expect(fixture.polled.filter((p) => p.name === 'kiosk.printed').length).toBeGreaterThan(0);
    await stream.close();
  });

  it('terminates when the server offers no usable delivery', async () => {
    const { connection } = await connect({
      delivery: [
        'webhook',
      ],
    });
    const stream = connection.listen({
      event: 'kiosk.printed',
      signal: new AbortController().signal,
    });
    await expect(stream.ready).rejects.toThrow('offers no delivery mode');
    const { messages, done } = collect(stream);
    await done;
    expect(messages[0]?.type).toBe('terminated');
  });
});

describe('refreshDelay', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const at = (ms: number): string => new Date(now + ms).toISOString();

  it('waits half the time left', () => {
    expect(refreshDelay(at(6e4), now)).toBe(3e4);
  });

  it('never waits less than a second', () => {
    expect(refreshDelay(at(1999), now)).toBe(1e3);
    expect(refreshDelay(at(2e3), now)).toBe(1e3);
    expect(refreshDelay(at(2001), now)).toBe(1000.5);
    expect(refreshDelay(at(-6e4), now)).toBe(1e3);
  });

  it('has nothing to wait for when the subscription does not lapse', () => {
    expect(refreshDelay(null, now)).toBeUndefined();
    expect(refreshDelay(undefined, now)).toBeUndefined();
  });

  it('refuses a refreshBefore that is not a time', () => {
    expect(() => refreshDelay('soon', now)).toThrow('not a time');
  });
});
