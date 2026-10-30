/**
 * Webhook Receiver (spec 25 § Webhook Receiver, spec 35 § Events): Standard
 * Webhooks signature verification, the five-minute timestamp window,
 * duplicate-id dropping, handler failure → retryable, endpoint lifecycle.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { WebhookDelivery, WebhookEndpoint, WebhookReceiver } from '../src/webhook-receiver';
import {
  createWebhookReceiver,
  generateWebhookSecret,
  signStandardWebhook,
  verifyStandardWebhook,
  WEBHOOK_TOLERANCE_MS,
} from '../src/webhook-receiver';

//#region Helpers

const NOW_MS = 1.7e12;
const NOW_S = NOW_MS / 1e3;

const receivers: WebhookReceiver[] = [];

afterEach(async () => {
  await Promise.all(receivers.splice(0).map((r) => r.close()));
});

function track(receiver: WebhookReceiver): WebhookReceiver {
  receivers.push(receiver);
  return receiver;
}

interface SendInput {
  readonly endpoint: WebhookEndpoint;
  readonly id: string;
  readonly body: string;
  readonly timestamp?: number;
  readonly secret?: string;
  readonly signature?: string;
  readonly method?: string;
}

async function send(input: SendInput): Promise<Response> {
  const timestamp = input.timestamp ?? NOW_S;
  const signature =
    input.signature ??
    signStandardWebhook({
      secret: input.secret ?? input.endpoint.secret,
      id: input.id,
      timestamp,
      body: input.body,
    });
  return fetch(input.endpoint.url, {
    method: input.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': input.id,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': signature,
    },
    body: input.method === 'GET' ? undefined : input.body,
  });
}

async function setup(onDelivery: (d: WebhookDelivery) => void | Promise<void> = () => {}): Promise<{
  receiver: WebhookReceiver;
  endpoint: WebhookEndpoint;
}> {
  const receiver = track(
    createWebhookReceiver({
      now: () => NOW_MS,
    }),
  );
  const endpoint = await receiver.register({
    onDelivery,
  });
  return {
    receiver,
    endpoint,
  };
}

//#endregion

describe('signStandardWebhook / verifyStandardWebhook', () => {
  const secret = generateWebhookSecret();
  const body = '{"a":1}';
  const signature = signStandardWebhook({
    secret,
    id: 'msg_1',
    timestamp: NOW_S,
    body,
  });

  it('generates whsec_ secrets and v1 signatures', () => {
    expect(secret.startsWith('whsec_')).toBe(true);
    expect(signature.startsWith('v1,')).toBe(true);
  });

  it('verifies a correctly signed delivery', () => {
    expect(
      verifyStandardWebhook({
        secret,
        id: 'msg_1',
        timestamp: String(NOW_S),
        signature,
        body,
        now: NOW_MS,
      }),
    ).toEqual({
      ok: true,
    });
  });

  it('accepts any matching entry in a space-separated signature list', () => {
    expect(
      verifyStandardWebhook({
        secret,
        id: 'msg_1',
        timestamp: String(NOW_S),
        signature: `v1,AAAA v2,zzz ${signature}`,
        body,
        now: NOW_MS,
      }).ok,
    ).toBe(true);
  });

  it('rejects a tampered body as signature', () => {
    expect(
      verifyStandardWebhook({
        secret,
        id: 'msg_1',
        timestamp: String(NOW_S),
        signature,
        body: '{"a":2}',
        now: NOW_MS,
      }),
    ).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it('rejects missing headers or a non-numeric timestamp as malformed', () => {
    for (const partial of [
      {
        id: undefined,
        timestamp: String(NOW_S),
        signature,
      },
      {
        id: 'msg_1',
        timestamp: undefined,
        signature,
      },
      {
        id: 'msg_1',
        timestamp: String(NOW_S),
        signature: undefined,
      },
      {
        id: 'msg_1',
        timestamp: 'soon',
        signature,
      },
    ]) {
      expect(
        verifyStandardWebhook({
          secret,
          body,
          now: NOW_MS,
          ...partial,
        }),
      ).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('enforces the five-minute window at its boundary (N-1, N, N+1 seconds)', () => {
    const windowS = WEBHOOK_TOLERANCE_MS / 1e3;
    const at = (offsetS: number): boolean => {
      const timestamp = NOW_S - offsetS;
      return verifyStandardWebhook({
        secret,
        id: 'm',
        timestamp: String(timestamp),
        signature: signStandardWebhook({
          secret,
          id: 'm',
          timestamp,
          body,
        }),
        body,
        now: NOW_MS,
      }).ok;
    };
    expect(at(windowS - 1)).toBe(true);
    expect(at(windowS)).toBe(true);
    expect(at(windowS + 1)).toBe(false);
    expect(at(-(windowS + 1))).toBe(false);
  });

  it('throws on an empty secret', () => {
    expect(() =>
      signStandardWebhook({
        secret: 'whsec_',
        id: 'm',
        timestamp: NOW_S,
        body,
      }),
    ).toThrow('non-empty base64');
  });
});

describe('createWebhookReceiver', () => {
  it('delivers a verified, parsed delivery and answers 204', async () => {
    const received: WebhookDelivery[] = [];
    const { endpoint } = await setup((d) => {
      received.push(d);
    });
    const res = await send({
      endpoint,
      id: 'msg_1',
      body: '{"eventId":"e1","name":"chat.message"}',
    });
    expect(res.status).toBe(204);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      id: 'msg_1',
      timestamp: NOW_S,
      body: {
        eventId: 'e1',
        name: 'chat.message',
      },
    });
    expect(received[0]?.headers['webhook-id']).toBe('msg_1');
  });

  it('drops a duplicate id with 200 and does not call the handler again', async () => {
    let calls = 0;
    const { endpoint } = await setup(() => {
      calls += 1;
    });
    expect(
      (
        await send({
          endpoint,
          id: 'dup',
          body: '{}',
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await send({
          endpoint,
          id: 'dup',
          body: '{}',
        })
      ).status,
    ).toBe(200);
    expect(calls).toBe(1);
  });

  it('answers 500 when the handler throws and accepts the retry', async () => {
    let calls = 0;
    const { endpoint } = await setup(() => {
      calls += 1;
      if (calls === 1) {
        throw new Error('inbox unavailable');
      }
    });
    expect(
      (
        await send({
          endpoint,
          id: 'retry',
          body: '{}',
        })
      ).status,
    ).toBe(500);
    expect(
      (
        await send({
          endpoint,
          id: 'retry',
          body: '{}',
        })
      ).status,
    ).toBe(204);
    expect(calls).toBe(2);
  });

  it('answers 409 to a concurrent duplicate while the first is in flight', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { endpoint } = await setup(() => gate);
    const first = send({
      endpoint,
      id: 'slow',
      body: '{}',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await send({
      endpoint,
      id: 'slow',
      body: '{}',
    });
    release();
    expect(second.status).toBe(409);
    expect((await first).status).toBe(204);
  });

  it('rejects a bad signature with 401', async () => {
    const { endpoint } = await setup();
    const res = await send({
      endpoint,
      id: 'm',
      body: '{}',
      secret: generateWebhookSecret(),
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('signature');
  });

  it('rejects a stale timestamp with 401', async () => {
    const { endpoint } = await setup();
    const res = await send({
      endpoint,
      id: 'm',
      body: '{}',
      timestamp: NOW_S - WEBHOOK_TOLERANCE_MS / 1e3 - 1,
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('stale');
  });

  it('rejects missing signature headers and non-JSON bodies with 400', async () => {
    const { endpoint } = await setup();
    const missing = await fetch(endpoint.url, {
      method: 'POST',
      body: '{}',
    });
    expect(missing.status).toBe(400);
    const notJson = await send({
      endpoint,
      id: 'm',
      body: 'not json',
    });
    expect(notJson.status).toBe(400);
  });

  it('answers 404 for unknown endpoints and 405 for non-POST', async () => {
    const { endpoint } = await setup();
    const unknown = await fetch(endpoint.url.replace(endpoint.id, 'nope'), {
      method: 'POST',
      body: '{}',
    });
    expect(unknown.status).toBe(404);
    const get = await fetch(endpoint.url);
    expect(get.status).toBe(405);
  });

  it('answers 413 for a body over maxBodyBytes', async () => {
    const receiver = track(
      createWebhookReceiver({
        now: () => NOW_MS,
        maxBodyBytes: 8,
      }),
    );
    const endpoint = await receiver.register({
      onDelivery: () => {},
    });
    const res = await send({
      endpoint,
      id: 'm',
      body: '{"too":"large"}',
    });
    expect(res.status).toBe(413);
    const chunked = await fetch(endpoint.url, {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('{"too":'));
          controller.enqueue(new TextEncoder().encode('"large"}'));
          controller.close();
        },
      }),
    });
    expect(chunked.status).toBe(413);
  });

  it('verifies with a caller-supplied secret', async () => {
    const receiver = track(
      createWebhookReceiver({
        now: () => NOW_MS,
      }),
    );
    const secret = generateWebhookSecret();
    const endpoint = await receiver.register({
      secret,
      onDelivery: () => {},
    });
    expect(endpoint.secret).toBe(secret);
    expect(
      (
        await send({
          endpoint,
          id: 'm',
          body: '{}',
        })
      ).status,
    ).toBe(204);
  });

  it('rejects registering an invalid secret', async () => {
    const receiver = track(createWebhookReceiver());
    await expect(
      receiver.register({
        secret: 'whsec_',
        onDelivery: () => {},
      }),
    ).rejects.toThrow('non-empty base64');
  });

  it('unregisters on close() and on signal abort', async () => {
    const { receiver, endpoint } = await setup();
    await endpoint.close();
    expect(
      (
        await send({
          endpoint,
          id: 'm',
          body: '{}',
        })
      ).status,
    ).toBe(404);
    const controller = new AbortController();
    const second = await receiver.register({
      onDelivery: () => {},
      signal: controller.signal,
    });
    controller.abort();
    expect(
      (
        await send({
          endpoint: second,
          id: 'm',
          body: '{}',
        })
      ).status,
    ).toBe(404);
  });

  it('builds endpoint urls from publicUrl and a custom path', async () => {
    const receiver = track(
      createWebhookReceiver({
        publicUrl: 'https://hooks.example.test/base/',
        path: 'in',
      }),
    );
    const endpoint = await receiver.register({
      onDelivery: () => {},
    });
    expect(endpoint.url).toBe(`https://hooks.example.test/base/in/${endpoint.id}`);
  });

  it('rejects a non-http publicUrl', () => {
    expect(() =>
      createWebhookReceiver({
        publicUrl: 'ftp://example.test',
      }),
    ).toThrow('must be http(s)');
  });

  it('listen is idempotent and close before listen is a no-op', async () => {
    const idle = createWebhookReceiver();
    await idle.close();
    const receiver = track(createWebhookReceiver());
    const a = await receiver.listen();
    const b = await receiver.listen();
    expect(a.port).toBe(b.port);
    expect(a.port).toBeGreaterThan(0);
  });
});

describe('createWebhookReceiver raw endpoints (the mcp({ webhooks }) contract)', () => {
  it('hands a POST through unverified and answers with the handler status', async () => {
    const receiver = track(createWebhookReceiver());
    const seen: Array<{
      headers: Readonly<Record<string, string>>;
      body: string;
    }> = [];
    const endpoint = await receiver.register(async (request) => {
      seen.push(request);
      return {
        status: 202,
      };
    });
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Webhook-Id': 'msg_1',
        'content-type': 'text/plain',
      },
      body: 'not json, not signed',
    });
    expect(response.status).toBe(202);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body).toBe('not json, not signed');
    // Header names arrive lowercase.
    expect(seen[0]?.headers['webhook-id']).toBe('msg_1');
  });

  it('still refuses a wrong method, an oversized body and a closed endpoint', async () => {
    const receiver = track(
      createWebhookReceiver({
        maxBodyBytes: 4,
      }),
    );
    let calls = 0;
    const endpoint = await receiver.register(async () => {
      calls += 1;
      return {
        status: 204,
      };
    });
    expect((await fetch(endpoint.url)).status).toBe(405);
    expect(
      (
        await fetch(endpoint.url, {
          method: 'POST',
          body: '12345',
        })
      ).status,
    ).toBe(413);
    await endpoint.close();
    expect(
      (
        await fetch(endpoint.url, {
          method: 'POST',
          body: '1',
        })
      ).status,
    ).toBe(404);
    expect(calls).toBe(0);
  });

  it('answers 500 when the raw handler throws', async () => {
    const receiver = track(createWebhookReceiver());
    const endpoint = await receiver.register(async () => {
      throw new Error('boom');
    });
    expect(
      (
        await fetch(endpoint.url, {
          method: 'POST',
          body: '{}',
        })
      ).status,
    ).toBe(500);
  });
});
