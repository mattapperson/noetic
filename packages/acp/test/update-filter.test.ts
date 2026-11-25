import { describe, expect, it } from 'bun:test';
import type { AcpSessionNotification } from '@noetic-tools/types';
import { divertNewerUpdates, newerSessionUpdate } from '../src/update-filter';

const newer = JSON.stringify({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: 's1',
    update: {
      sessionUpdate: 'future_variant',
    },
  },
});
const known = JSON.stringify({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: 's1',
    update: {
      sessionUpdate: 'usage_update',
      used: 1,
      size: 2,
    },
  },
});

describe('newerSessionUpdate', () => {
  it('picks out only a session/update notification with an unknown variant', () => {
    expect(newerSessionUpdate(newer)?.sessionId).toBe('s1');
    expect(newerSessionUpdate(known)).toBeUndefined();
    expect(newerSessionUpdate('not json "session/update"')).toBeUndefined();
    expect(
      newerSessionUpdate(
        JSON.stringify({
          id: 1,
          method: 'session/update',
          params: {},
        }),
      ),
    ).toBeUndefined();
    expect(
      newerSessionUpdate(
        JSON.stringify({
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'future_variant',
            },
          },
        }),
      ),
    ).toBeUndefined();
    expect(newerSessionUpdate('{"method":"session/prompt"}')).toBeUndefined();
  });
});

describe('divertNewerUpdates', () => {
  it('passes other lines through byte-identical, across chunk boundaries and a tail', async () => {
    const encoder = new TextEncoder();
    const text = `${known}\n${newer}\n${known}`;
    const middle = Math.floor(text.length / 2);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text.slice(0, middle)));
        controller.enqueue(encoder.encode(text.slice(middle)));
        controller.close();
      },
    });
    const diverted: AcpSessionNotification[] = [];
    const out = await new Response(
      divertNewerUpdates(source, (notification) => diverted.push(notification)),
    ).text();

    expect(out).toBe(`${known}\n${known}`);
    expect(diverted).toHaveLength(1);
  });

  it('diverts a newer update arriving as the unterminated tail', async () => {
    const diverted: AcpSessionNotification[] = [];
    const out = await new Response(
      divertNewerUpdates(new Response(newer).body ?? new ReadableStream(), (n) => diverted.push(n)),
    ).text();
    expect(out).toBe('');
    expect(diverted).toHaveLength(1);
  });
});
