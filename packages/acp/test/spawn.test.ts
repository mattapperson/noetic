/**
 * A stdio MCP server started on the agent's machine, with Noetic still its
 * client: its stdio comes back over the machine's channel.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AcpMachineFactory, AcpTransport } from '@noetic-tools/types';
import type { AcpRunnerListener } from '../src/remote';
import { listenAcpRunner, webSocketMachine } from '../src/remote';
import { spawnOn } from '../src/spawn';
import { localMachine } from '../src/stdio';

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

function counting(machine: AcpMachineFactory): {
  machine: AcpMachineFactory;
  closed: () => number;
} {
  let closed = 0;
  return {
    machine: async (opts) => {
      const opened = await machine(opts);
      return {
        ...opened,
        close: async () => {
          closed += 1;
          await opened.close();
        },
      };
    },
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
    const { machine, closed } = counting(
      webSocketMachine({
        url: listener.url,
        token: TOKEN,
      }),
    );
    const server = await spawnOn(machine)({
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

  it('runs on this machine', async () => {
    const server = await spawnOn(localMachine())({
      command: process.execPath,
      args: [
        SERVER,
      ],
    });
    expect(JSON.stringify(await listTools(server))).toContain('read_workspace');
    await server.close();
  });

  it('releases the machine when the process cannot start', async () => {
    const { machine, closed } = counting(
      webSocketMachine({
        url: listener.url,
        token: TOKEN,
      }),
    );
    const failure = await spawnOn(machine)({
      command: 'docs-mcp',
      cwd: '/no/such/dir/on/the/runner',
    }).catch((e: unknown) => e);
    expect(String(failure)).toContain('does not exist');
    expect(closed()).toBe(1);
  });
});
