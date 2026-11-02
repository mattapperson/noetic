/**
 * The MCP client against real servers: a stdio subprocess and a streamable
 * HTTP endpoint, each listing and calling one tool.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { Server } from '@modelcontextprotocol/server';
import type { McpSession } from '../src/mcp-client';
import { callMcpTool, closeSessions, connectMcpServer } from '../src/mcp-client';
import type { McpServerConfig } from '../src/mcp-config';
import { resolveMcpServer } from '../src/mcp-config';

const FIXTURE = join(import.meta.dir, 'fixtures', 'echo-mcp-server.ts');
const sessions: McpSession[] = [];
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await closeSessions(sessions.splice(0));
  for (const http of servers.splice(0)) {
    http.closeAllConnections();
    http.close();
  }
});

async function connect(config: McpServerConfig): Promise<McpSession> {
  const vars = {
    pluginRoot: import.meta.dir,
    pluginData: join(tmpdir(), `agent-plugins-${randomUUID()}`),
  };
  const resolved = await resolveMcpServer({
    key: 'p/echo',
    config,
    vars,
  });
  if (!resolved.ok) {
    throw new Error('fixture should resolve');
  }
  const connected = await connectMcpServer({
    server: resolved.server,
    ...vars,
  });
  if (!connected.ok) {
    throw new Error(connected.detail);
  }
  sessions.push(connected.session);
  return connected.session;
}

async function serveEchoOverHttp(): Promise<string> {
  const transports = new Map<string, NodeStreamableHTTPServerTransport>();
  const http = createServer(async (req, res) => {
    const id = req.headers['mcp-session-id'];
    let transport = typeof id === 'string' ? transports.get(id) : undefined;
    if (!transport) {
      const created = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (sessionId) => {
          transports.set(sessionId, created);
        },
      });
      const server = new Server(
        {
          name: 'echo',
          version: '1.0.0',
        },
        {
          capabilities: {
            tools: {},
          },
        },
      );
      server.setRequestHandler('tools/list', async () => ({
        tools: [
          {
            name: 'echo',
            description: 'Echo the text.',
            inputSchema: {
              type: 'object',
            },
          },
        ],
      }));
      server.setRequestHandler('tools/call', async (request) => ({
        content: [
          {
            type: 'text',
            text: `echo:${String(request.params.arguments?.text)}`,
          },
        ],
      }));
      await server.connect(created);
      transport = created;
    }
    await transport.handleRequest(req, res);
  });
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (address === null || typeof address === 'string') {
    throw new Error('no port');
  }
  return `http://127.0.0.1:${address.port}/mcp`;
}

describe('MCP client against live servers', () => {
  it('lists and calls a tool over stdio', async () => {
    const session = await connect({
      type: 'stdio',
      command: process.execPath,
      args: [
        FIXTURE,
      ],
    });
    expect(session.tools.map((tool) => tool.name)).toEqual([
      'echo',
    ]);
    const result = await callMcpTool({
      session,
      tool: 'echo',
      args: {
        text: 'hi',
      },
    });
    expect(result).toEqual({
      ok: true,
      content: [
        {
          type: 'text',
          text: 'echo:hi',
        },
      ],
    });
  }, 2e4);

  it('lists and calls a tool over streamable HTTP', async () => {
    const session = await connect({
      type: 'streamable-http',
      url: await serveEchoOverHttp(),
    });
    expect(session.tools.map((tool) => tool.name)).toEqual([
      'echo',
    ]);
    const result = await callMcpTool({
      session,
      tool: 'echo',
      args: {
        text: 'there',
      },
    });
    expect(result.ok).toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'echo:there',
      },
    ]);
  }, 2e4);
});
