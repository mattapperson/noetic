// The event endpoint: a request the host accepts becomes an event a source emits,
// and the provider is answered once the event is stored. See
// specs/25-platform-packages § Cloudflare Workers.

import { describe, expect, it } from 'bun:test';
import type { CallModelRequest, ContextData, LLMResponse } from '@noetic-tools/core';
import { AgentHarness, callModel, createInMemoryStorage, defineSource } from '@noetic-tools/core';
import { z } from 'zod';
import { EventEndpointStatus, eventEndpoint } from '../src/event-endpoint';
import { standardWebhookVerifier } from '../src/standard-webhook';
import { model } from './_helpers';

//#region Fixtures

interface Mail {
  type: 'received';
  id: string;
  payload: {
    from: string;
  };
}

const MailBodySchema = z.object({
  id: z.string(),
  from: z.string(),
});

function toEvent(body: string): Mail | undefined {
  if (body === 'ping') {
    return undefined;
  }
  const mail = MailBodySchema.parse(JSON.parse(body));
  return {
    type: 'received',
    id: mail.id,
    payload: {
      from: mail.from,
    },
  };
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://worker.example/events', {
    method: 'POST',
    body,
    headers,
  });
}

const BODY = JSON.stringify({
  id: 'msg-77',
  from: 'billing@vendor.example',
});

const SECRET = `whsec_${btoa('a secret that is long enough')}`;

/** The headers a Standard Webhooks sender puts on `body`. */
async function signed(
  body: string,
  opts: {
    secret?: string;
    at?: number;
  } = {},
): Promise<Record<string, string>> {
  const secret = (opts.secret ?? SECRET).slice('whsec_'.length);
  const timestamp = String(Math.floor((opts.at ?? Date.now()) / 1e3));
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(atob(secret), (char) => char.charCodeAt(0)),
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    false,
    [
      'sign',
    ],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`wh-1.${timestamp}.${body}`),
  );
  return {
    'webhook-id': 'wh-1',
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${btoa(String.fromCharCode(...new Uint8Array(signature)))}`,
  };
}

//#endregion

describe('eventEndpoint', () => {
  it('answers 200 once the event is emitted, and not before', async () => {
    const emitted: Mail[] = [];
    let store: (() => void) | undefined;
    const receive = eventEndpoint<Mail>({
      emit: (event) =>
        new Promise((resolve) => {
          store = () => {
            emitted.push(event);
            resolve();
          };
        }),
      toEvent,
    });
    let answered: Response | undefined;
    const answering = receive(post(BODY)).then((response) => {
      answered = response;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(answered).toBeUndefined();

    store?.();
    await answering;
    expect(answered?.status).toBe(EventEndpointStatus.Stored);
    expect(emitted).toEqual([
      {
        type: 'received',
        id: 'msg-77',
        payload: {
          from: 'billing@vendor.example',
        },
      },
    ]);
  });

  it('answers 503 when the event could not be stored, so the provider sends it again', async () => {
    const receive = eventEndpoint<Mail>({
      emit: async () => {
        throw new Error('inbox write failed');
      },
      toEvent,
    });
    expect((await receive(post(BODY))).status).toBe(EventEndpointStatus.NotStored);
  });

  it('answers 401 and emits nothing when verify refuses', async () => {
    const emitted: Mail[] = [];
    const receive = eventEndpoint<Mail>({
      emit: async (event) => {
        emitted.push(event);
      },
      verify: () => false,
      toEvent,
    });
    expect((await receive(post(BODY))).status).toBe(EventEndpointStatus.Unauthorized);
    expect(emitted).toEqual([]);
  });

  it('answers 401 when verify throws', async () => {
    const receive = eventEndpoint<Mail>({
      emit: async () => {},
      verify: () => {
        throw new Error('bad secret');
      },
      toEvent,
    });
    expect((await receive(post(BODY))).status).toBe(EventEndpointStatus.Unauthorized);
  });

  it('starts the harness before it emits, so a trigger is there to store the event', async () => {
    const order: string[] = [];
    const receive = eventEndpoint<Mail>({
      harness: {
        start: async () => {
          order.push('start');
        },
      },
      emit: async () => {
        order.push('emit');
      },
      toEvent,
    });
    expect((await receive(post(BODY))).status).toBe(EventEndpointStatus.Stored);
    expect(order).toEqual([
      'start',
      'emit',
    ]);
  });

  it('answers 503 when the harness cannot start', async () => {
    const receive = eventEndpoint<Mail>({
      harness: {
        start: async () => {
          throw new Error('storage is down');
        },
      },
      emit: async () => {},
      toEvent,
    });
    expect((await receive(post(BODY))).status).toBe(EventEndpointStatus.NotStored);
  });

  it('answers 400 for a body toEvent cannot read', async () => {
    const receive = eventEndpoint<Mail>({
      emit: async () => {},
      toEvent,
    });
    expect((await receive(post('not json'))).status).toBe(EventEndpointStatus.BadRequest);
  });

  it('answers 204 for a delivery that carries no event', async () => {
    const emitted: Mail[] = [];
    const receive = eventEndpoint<Mail>({
      emit: async (event) => {
        emitted.push(event);
      },
      toEvent,
    });
    expect((await receive(post('ping'))).status).toBe(EventEndpointStatus.Ignored);
    expect(emitted).toEqual([]);
  });

  it('answers 405 for anything but POST', async () => {
    const receive = eventEndpoint<Mail>({
      emit: async () => {},
      toEvent,
    });
    const response = await receive(new Request('https://worker.example/events'));
    expect(response.status).toBe(EventEndpointStatus.MethodNotAllowed);
  });
});

describe('standardWebhookVerifier', () => {
  const verify = standardWebhookVerifier({
    secret: SECRET,
  });

  it('refuses a secret that is not base64 when it is set up, not on every delivery', () => {
    expect(() =>
      standardWebhookVerifier({
        secret: 'whsec_not base64 at all!',
      }),
    ).toThrow('not base64');
  });

  it('accepts a delivery signed with the secret', async () => {
    expect(await verify(post(BODY, await signed(BODY)), BODY)).toBe(true);
  });

  it('accepts the secret without its prefix, and one good signature among several', async () => {
    const bare = standardWebhookVerifier({
      secret: SECRET.slice('whsec_'.length),
    });
    const headers = await signed(BODY);
    headers['webhook-signature'] = `v1,AAAA v2,ignored ${headers['webhook-signature']}`;
    expect(await bare(post(BODY, headers), BODY)).toBe(true);
  });

  it('refuses a body that was changed after signing', async () => {
    const headers = await signed(BODY);
    expect(await verify(post(`${BODY} `, headers), `${BODY} `)).toBe(false);
  });

  it('refuses a signature made with another secret', async () => {
    const headers = await signed(BODY, {
      secret: `whsec_${btoa('some other secret entirely')}`,
    });
    expect(await verify(post(BODY, headers), BODY)).toBe(false);
  });

  it('refuses a request with a header missing or a timestamp that is no number', async () => {
    const headers = await signed(BODY);
    const { 'webhook-id': _id, ...noId } = headers;
    expect(await verify(post(BODY, noId), BODY)).toBe(false);
    expect(
      await verify(
        post(BODY, {
          ...headers,
          'webhook-timestamp': 'yesterday',
        }),
        BODY,
      ),
    ).toBe(false);
    expect(
      await verify(
        post(BODY, {
          ...headers,
          'webhook-signature': 'v1,!!!not-base64!!!',
        }),
        BODY,
      ),
    ).toBe(false);
  });

  it('holds the timestamp to the tolerance: just inside passes, just outside does not', async () => {
    const now = 1e12;
    const strict = standardWebhookVerifier({
      secret: SECRET,
      toleranceMs: 6e4,
      now: () => now,
    });
    const at = async (ms: number): Promise<boolean> =>
      strict(
        post(
          BODY,
          await signed(BODY, {
            at: ms,
          }),
        ),
        BODY,
      );
    expect(await at(now - 59e3)).toBe(true);
    expect(await at(now - 6e4)).toBe(true);
    expect(await at(now - 61e3)).toBe(false);
    expect(await at(now + 61e3)).toBe(false);
  });
});

describe('a provider that delivers the same event twice', () => {
  it('starts one turn, and both deliveries are answered 200', async () => {
    const m = model('a');
    const inbox = defineSource({
      events: {
        received: z.object({
          from: z.string(),
        }),
      },
    });
    const harness = new AgentHarness({
      name: 'worker',
      params: {},
      agentGraph: callModel<ContextData, string, string>({
        id: 'agent',
        model: 'test/model',
      }),
      connections: {
        inbox,
      },
      triggers: [
        {
          id: 'vendor-mail',
          connection: 'inbox',
          event: 'received',
          input: '"Email from " & event.payload.from',
          thread: '"mail:" & event.id',
        },
      ],
      environment: {
        storage: {
          adapter: createInMemoryStorage(),
        },
      },
      _testCallModel: (request: CallModelRequest): Promise<LLMResponse> => m.call(request),
    });
    await harness.start();
    const receive = eventEndpoint<Mail>({
      emit: (event) => inbox.emit(event),
      verify: standardWebhookVerifier({
        secret: SECRET,
      }),
      toEvent,
    });

    const first = await receive(post(BODY, await signed(BODY)));
    const second = await receive(post(BODY, await signed(BODY)));
    expect(first.status).toBe(EventEndpointStatus.Stored);
    expect(second.status).toBe(EventEndpointStatus.Stored);

    const response = await harness.getAgentResponse({
      threadId: 'mail:msg-77',
    });
    expect(response.text).toBe('a-1');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(m.calls).toBe(1);
    await harness.close();
  });
});
