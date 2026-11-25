/**
 * The keeper's bridge port outlives the host that serves the bridge: a request
 * the agent sends while no host is attached waits, and goes to the next host's
 * bridge at the same address — so the agent's MCP settings stay valid.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { attachKeeper, startKeeper } from '../src/keeper/client';

const POSIX = process.platform !== 'win32';

async function bridge(name: string): Promise<{
  server: Server;
  url: string;
  seen: string[];
}> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
    res.writeHead(200, {
      'content-type': 'text/plain',
    });
    res.end(name);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    server,
    url: `http://127.0.0.1:${address.port}/mcp/abc`,
    seen,
  };
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

describe.skipIf(!POSIX)('the keeper bridge port', () => {
  it('holds a request while no bridge is attached and serves it from the next host', async () => {
    const first = await bridge('first');
    const link = await startKeeper('bridge-test', {
      whenHostExits: 'keep',
      detachedTimeoutMs: 0,
    });
    assert(link);
    // An agent for the keeper to keep: one that just waits.
    await link.launch({
      command: process.execPath,
      args: [
        '-e',
        'setInterval(() => {}, 1000)',
      ],
      env: {
        PATH: process.env.PATH,
      },
    });
    const url = await link.reach('/mcp/abc', first.url);
    expect(new URL(url).pathname).toBe('/mcp/abc');

    const live = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer t',
      },
      body: '{}',
    });
    expect(await live.text()).toBe('first');
    expect(first.seen).toEqual([
      'POST /mcp/abc Bearer t',
    ]);

    // The host goes away, and its bridge with it.
    link.detach();
    await close(first.server);
    await Bun.sleep(100);
    const waiting = fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer t',
      },
      body: '{}',
    });
    await Bun.sleep(150);

    // A new host reattaches and serves the bridge again at the same path.
    const second = await bridge('second');
    const next = await attachKeeper('bridge-test', link.handle, 'keep');
    try {
      expect(await next.reach('/mcp/abc', second.url)).toBe(url);
      const answered = await waiting;
      expect(answered.status).toBe(200);
      expect(await answered.text()).toBe('second');
      expect(second.seen).toEqual([
        'POST /mcp/abc Bearer t',
      ]);
    } finally {
      await next.stop();
      await close(second.server);
    }
  }, 20e3);

  it('refuses a connection with the wrong token', async () => {
    const link = await startKeeper('token-test', {
      whenHostExits: 'stop',
      detachedTimeoutMs: 0,
    });
    assert(link);
    try {
      const error = await attachKeeper(
        'token-test',
        {
          ...link.handle,
          token: 'x'.repeat(72),
        },
        'keep',
      ).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(String(error)).toContain('keeper');
    } finally {
      await link.stop();
    }
  });

  it('stops a kept agent no host reattached to within detachedTimeoutMs', async () => {
    const link = await startKeeper('timeout-test', {
      whenHostExits: 'keep',
      detachedTimeoutMs: 200,
    });
    assert(link);
    await link.launch({
      command: process.execPath,
      args: [
        '-e',
        'setInterval(() => {}, 1000)',
      ],
      env: {
        PATH: process.env.PATH,
      },
    });
    link.detach();
    await Bun.sleep(800);
    const error = await attachKeeper('timeout-test', link.handle, 'keep').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(String(error)).toContain('no longer running');
  });
});
