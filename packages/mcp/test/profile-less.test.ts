import { afterEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { Connection } from '@noetic-tools/types';
import { isNoeticError } from '@noetic-tools/types';
import { mcp } from '../src/provider';
import { connectOptions, structured, TestServer, textResult, waitFor } from './_helpers';

const PNG_BASE64 = btoa('not really a png');

function server(): TestServer {
  return new TestServer({
    tools: [
      {
        name: 'echo',
        description: 'Echo the text back.',
        inputSchema: {
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
        handler: (args) => textResult(String(args.text)),
      },
      {
        name: 'snap',
        handler: () => ({
          content: [
            {
              type: 'image',
              data: PNG_BASE64,
              mimeType: 'image/png',
            },
          ],
        }),
      },
      {
        name: 'shape',
        handler: () =>
          structured({
            ok: true,
          }),
      },
      {
        name: 'broken',
        handler: () => ({
          isError: true,
          content: [
            {
              type: 'text',
              text: 'it broke',
            },
          ],
        }),
      },
      {
        name: 'throws',
        handler: () => {
          throw new Error('kaboom');
        },
      },
    ],
  });
}

const opened: Connection[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.release()));
});

async function connect(fixture: TestServer, name = 'tools'): Promise<Connection> {
  const [connection] = await fixture.provider().connect(connectOptions(name));
  assert(connection !== undefined);
  opened.push(connection);
  return connection;
}

const callOpts = {
  signal: new AbortController().signal,
  idempotencyKey: 'run-1:step-1',
};

describe('a server with no profile declaration', () => {
  it('becomes a profile-less connection whose tools pass through as operations', async () => {
    const connection = await connect(server());
    expect(Object.keys(connection.manifest.operations)).toEqual([
      'echo',
      'snap',
      'shape',
      'broken',
      'throws',
    ]);
    expect(connection.manifest.operations.echo?.description).toBe('Echo the text back.');
    expect(connection.manifest.operations.echo?.inputSchema).toMatchObject({
      required: [
        'text',
      ],
    });
    expect(connection.manifest.profiles).toEqual({});
    expect(connection.manifest.resources).toEqual({});
    expect(connection.manifest.events).toEqual({});
    expect(connection.manifest.senses).toEqual({});
    expect(connection.reset).toBeUndefined();
  });

  it('takes the MCP session as its identity', async () => {
    const fixture = server();
    const a = await connect(fixture);
    const b = await connect(fixture);
    expect(a.identity.surface).toBe('mcp');
    expect(a.identity.instance.length).toBeGreaterThan(0);
    expect(a.identity.instance).not.toBe(b.identity.instance);
  });

  it('returns content and stores binary blocks as blobs', async () => {
    const connection = await connect(server());
    const echoed = await connection.call(
      'echo',
      {
        text: 'hi',
      },
      callOpts,
    );
    expect(echoed).toEqual({
      status: 'ok',
      output: {
        content: [
          {
            type: 'text',
            text: 'hi',
          },
        ],
      },
    });
    const snapped = await connection.call('snap', {}, callOpts);
    assert(snapped.status === 'ok');
    expect(snapped.output).toMatchObject({
      content: [
        {
          $blob: {
            mimeType: 'image/png',
            bytes: 'not really a png'.length,
          },
        },
      ],
    });
    const shaped = await connection.call('shape', {}, callOpts);
    expect(shaped).toEqual({
      status: 'ok',
      output: {
        ok: true,
      },
    });
  });

  it('sends the idempotency key in _meta', async () => {
    const fixture = server();
    const connection = await connect(fixture);
    await connection.call(
      'echo',
      {
        text: 'x',
      },
      callOpts,
    );
    expect(fixture.calls.at(-1)?.meta['tools.noetic/idempotency-key']).toBe('run-1:step-1');
    expect(fixture.calls.at(-1)?.meta['tools.noetic/confirmed']).toBeUndefined();
  });

  it('maps an unstructured tool error to unavailable, keeping the text', async () => {
    const connection = await connect(server());
    const outcome = await connection.call('broken', {}, callOpts);
    assert(outcome.status === 'error');
    expect(outcome.error.code).toBe('unavailable');
    expect(outcome.error.message).toBe('it broke');
  });

  it('maps a handler exception to a refusal rather than throwing', async () => {
    const connection = await connect(server());
    const outcome = await connection.call('throws', {}, callOpts);
    assert(outcome.status === 'error');
    expect(outcome.error.message).toContain('kaboom');
  });

  it('refuses an unknown operation as undeclared without reaching the server', async () => {
    const fixture = server();
    const connection = await connect(fixture);
    const before = fixture.calls.length;
    const outcome = await connection.call('nope', {}, callOpts);
    assert(outcome.status === 'error');
    expect(outcome.error.code).toBe('undeclared');
    expect(fixture.calls.length).toBe(before);
  });

  it('refuses non-object arguments as malformed', async () => {
    const connection = await connect(server());
    const outcome = await connection.call('echo', 'hi', callOpts);
    assert(outcome.status === 'error');
    expect(outcome.error.code).toBe('malformed');
  });

  it('has no reads: reading fails with connection_failed (undeclared)', async () => {
    const connection = await connect(server());
    try {
      await connection.read('anything', {
        signal: new AbortController().signal,
      });
      throw new Error('expected a throw');
    } catch (error) {
      assert(isNoeticError(error));
      expect(error.noeticError.kind).toBe('connection_failed');
      assert(error.noeticError.kind === 'connection_failed');
      expect(error.noeticError.error.code).toBe('undeclared');
    }
  });

  it('has no events: listening terminates at once', async () => {
    const connection = await connect(server());
    const stream = connection.listen({
      event: 'x',
      signal: new AbortController().signal,
    });
    const messages = [];
    for await (const message of stream) {
      messages.push(message);
    }
    expect(messages).toEqual([
      {
        type: 'terminated',
        reason: "'x' is not an event of this connection",
      },
    ]);
    await expect(stream.ready).rejects.toThrow();
  });

  it('reports a closed session as unavailable and resolves closed', async () => {
    const fixture = server();
    const connection = await connect(fixture);
    await fixture.servers[0]?.close();
    const closed = await connection.closed;
    expect(closed.reason.length).toBeGreaterThan(0);
    const outcome = await connection.call(
      'echo',
      {
        text: 'x',
      },
      callOpts,
    );
    assert(outcome.status === 'error');
    expect(outcome.error.code).toBe('unavailable');
  });

  it('re-lists tools on list_changed and tells listeners the manifest changed', async () => {
    const fixture = server();
    const connection = await connect(fixture);
    const changes: string[] = [];
    connection.onChange((change) => changes.push(change));
    fixture.tools = [
      ...fixture.tools,
      {
        name: 'added',
        handler: () => textResult('new'),
      },
    ];
    await fixture.notifyAll('notifications/tools/list_changed');
    await waitFor(() => changes.includes('manifest'));
    expect(Object.keys(connection.manifest.operations)).toContain('added');
  });

  it('release is idempotent and resolves closed', async () => {
    const connection = await connect(server());
    opened.pop();
    await connection.release();
    await connection.release();
    expect((await connection.closed).reason).toBe('released');
  });
});

describe('connect failures', () => {
  it('rejects with connection_unavailable when the transport cannot start', async () => {
    const provider = mcp({
      transport: () => {
        throw new Error('no such server');
      },
    });
    try {
      await provider.connect(connectOptions('broken'));
      throw new Error('expected a throw');
    } catch (error) {
      assert(isNoeticError(error));
      expect(error.noeticError.kind).toBe('connection_unavailable');
      assert(error.noeticError.kind === 'connection_unavailable');
      expect(error.noeticError.connection).toBe('broken');
      expect(error.noeticError.reason).toContain('no such server');
    }
  });

  it('rejects with connection_unavailable when the handshake times out', async () => {
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const provider = mcp(
      {
        transport: () => InMemoryTransport.createLinkedPair()[0],
      },
      {
        timeoutMs: 50,
      },
    );
    try {
      await provider.connect(connectOptions('silent'));
      throw new Error('expected a throw');
    } catch (error) {
      assert(isNoeticError(error));
      expect(error.noeticError.kind).toBe('connection_unavailable');
    }
  });
});
