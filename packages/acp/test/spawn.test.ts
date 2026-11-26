/**
 * A stdio MCP server started where the agent runs, with Noetic still its
 * client: its stdio comes back over the link's channel.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AcpTransport, SubprocessAdapter } from '@noetic-tools/types';
import type { AgentSubprocessAdapter } from '../src/agent-subprocess';
import { agentSubprocess } from '../src/agent-subprocess';
import type { AcpRunnerListener } from '../src/remote';
import { listenAcpRunner, webSocketSubprocess } from '../src/remote';
import { spawnOn } from '../src/spawn';
import { localSubprocess } from '../src/stdio';

const SERVER = join(import.meta.dir, 'fixtures', 'stdio-mcp-server.ts');
const TOKEN = 'spawn-test-token-0123456789';

async function listTools(server: AcpTransport): Promise<unknown> {
  const writer = server.writable.getWriter();
  await writer.write(
    new TextEncoder().encode(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      })}\n`,
    ),
  );
  writer.releaseLock();
  const reader = server.readable.getReader();
  let text = '';
  while (!text.includes('\n')) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    text += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  return JSON.parse(text);
}

function counting(inner: AgentSubprocessAdapter): {
  adapter: SubprocessAdapter;
  closed: () => number;
} {
  let closed = 0;
  return {
    adapter: agentSubprocess('counting', async (opts) => {
      const link = await inner.open(opts);
      return {
        ...link,
        close: async () => {
          closed += 1;
          await link.close();
        },
      };
    }),
    closed: () => closed,
  };
}

describe('spawnOn', () => {
  let listener: AcpRunnerListener;
  beforeAll(async () => {
    listener = await listenAcpRunner({
      token: TOKEN,
    });
  });
  afterAll(async () => {
    await listener.close();
  });

  it('carries a stdio MCP server started through the runner', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'agent-workspace-')));
    const { adapter, closed } = counting(
      webSocketSubprocess({
        url: listener.url,
        token: TOKEN,
      }),
    );
    const server = await spawnOn(adapter)({
      command: process.execPath,
      args: [
        SERVER,
      ],
      cwd: workspace,
    });
    const reply = await listTools(server);
    expect(reply).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          {
            name: 'read_workspace',
            description: `Reads ${workspace}`,
            inputSchema: {
              type: 'object',
            },
          },
        ],
      },
    });
    await server.close();
    expect(closed()).toBe(1);
  });

  it('runs as a local process', async () => {
    const server = await spawnOn(localSubprocess())({
      command: process.execPath,
      args: [
        SERVER,
      ],
    });
    expect(JSON.stringify(await listTools(server))).toContain('read_workspace');
    await server.close();
  });

  it('closes the link when the process cannot start', async () => {
    const { adapter, closed } = counting(
      webSocketSubprocess({
        url: listener.url,
        token: TOKEN,
      }),
    );
    const failure = await spawnOn(adapter)({
      command: 'docs-mcp',
      cwd: '/no/such/dir/on/the/runner',
    }).catch((e: unknown) => e);
    expect(String(failure)).toContain('does not exist');
    expect(closed()).toBe(1);
  });
});
