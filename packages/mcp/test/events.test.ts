import { afterEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  Connection,
  ConnectionEventInit,
  EventStream,
  EventStreamMessage,
} from '@noetic-tools/types';
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
  it('confirms the subscription, delivers events in order, dedupes ids, and passes gaps', async () => {
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
    await fixture.gap('kiosk.printed', 'server restarted');
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
        reason: 'server restarted',
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
    expect(fixture.unsubscribed.length).toBe(1);
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
        reason: 'subscription expired',
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

describe('poll delivery (events/poll)', () => {
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
    fixture.pollTerminated = 'gone';
    await waitFor(() => messages.length === 2);
    expect(messages[1]).toEqual({
      type: 'terminated',
      reason: 'gone',
    });
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
  it('prefers webhook over poll when a receiver is configured, and verifies deliveries', async () => {
    const receiver = fakeReceiver();
    const { connection, fixture } = await connect(
      {
        delivery: [
          'webhook',
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
            headers,
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
      'terminated',
    ]);
    expect(receiver.closed()).toBe(true);
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
    await expect(stream.ready).rejects.toThrow('no event delivery');
    const { messages, done } = collect(stream);
    await done;
    expect(messages[0]?.type).toBe('terminated');
  });
});
