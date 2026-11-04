import { describe, expect, it } from 'bun:test';
import { PassThrough, Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Spawn, SpawnCommand } from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError } from '@noetic-tools/types';
import type { McpConfig } from '../src/config';
import { mcp } from '../src/provider';
import { connectOptions, TestServer, textResult } from './_helpers';

//#region Fixtures

function echoServer(): TestServer {
  return new TestServer({
    tools: [
      {
        name: 'echo',
        handler: (args) => textResult(`echo ${String(args.text)}`),
      },
    ],
  });
}

/**
 * A `spawn` that "starts" the server in this process: it serves MCP over stdio
 * on a pair of byte pipes, as a process on another machine would over its
 * stdin and stdout.
 */
function inProcessSpawn(server: TestServer): {
  readonly spawn: Spawn;
  readonly started: SpawnCommand[];
  readonly closed: () => number;
} {
  const started: SpawnCommand[] = [];
  let closed = 0;
  const spawn: Spawn = async (command) => {
    started.push(command);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    await server.build().connect(new StdioServerTransport(stdin, stdout));
    return {
      // node:stream's web types and the DOM lib's are the same streams, typed apart.
      writable: frameworkCast<WritableStream<Uint8Array>>(Writable.toWeb(stdin)),
      readable: frameworkCast<ReadableStream<Uint8Array>>(Readable.toWeb(stdout)),
      close: async () => {
        closed += 1;
        stdout.end();
      },
    };
  };
  return {
    spawn,
    started,
    closed: () => closed,
  };
}

//#endregion

describe('mcp({ name })', () => {
  it('names the provider', () => {
    expect(
      mcp({
        name: 'linear',
        type: 'http',
        url: 'https://mcp.example.com/mcp',
      }).name,
    ).toBe('linear');
    expect(
      mcp({
        command: 'npx',
        args: [
          'some-server',
        ],
      }).name,
    ).toBeUndefined();
  });

  it('an empty name is CONNECTION_INVALID', () => {
    let error: unknown;
    try {
      mcp({
        name: '',
        type: 'http',
        url: 'https://mcp.example.com/mcp',
      });
    } catch (e) {
      error = e;
    }
    expect(isNoeticConfigError(error) && error.code).toBe('CONNECTION_INVALID');
  });
});

describe('stdio over spawn', () => {
  it('runs a stdio server through the spawn the caller gives, and stops it on release', async () => {
    const fake = inProcessSpawn(echoServer());
    const provider = mcp({
      command: 'issues-mcp',
      args: [
        '--stdio',
      ],
      env: [
        {
          name: 'TOKEN',
          value: 'x',
        },
      ],
      spawn: fake.spawn,
    });
    const [connection] = await provider.connect(connectOptions('remote'));
    if (!connection) {
      throw new Error('no connection');
    }
    expect(fake.started).toEqual([
      {
        command: 'issues-mcp',
        args: [
          '--stdio',
        ],
        env: {
          TOKEN: 'x',
        },
      },
    ]);
    expect(Object.keys(connection.manifest.operations)).toEqual([
      'echo',
    ]);
    const result = await connection.call(
      'echo',
      {
        text: 'hi',
      },
      {
        signal: new AbortController().signal,
        idempotencyKey: 'k1',
      },
    );
    expect(JSON.stringify(result)).toContain('echo hi');
    await connection.release();
    expect(fake.closed()).toBe(1);
  });

  it('a spawn that is not a function is CONNECTION_INVALID', () => {
    let error: unknown;
    try {
      mcp(
        frameworkCast<McpConfig>({
          command: 'issues-mcp',
          spawn: 'ssh host',
        }),
      );
    } catch (e) {
      error = e;
    }
    expect(isNoeticConfigError(error) && error.code).toBe('CONNECTION_INVALID');
  });
});
