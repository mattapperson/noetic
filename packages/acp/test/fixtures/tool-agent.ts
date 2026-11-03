/**
 * Child-process fixture: an ACP agent over this process's stdio that, on each
 * prompt, calls the `echo` tool on the `noetic` MCP server it was given and
 * answers with what it saw — the server URL, the listed tools, the result.
 */

import { Readable, Writable } from 'node:stream';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { frameworkCast } from '@noetic-tools/types';
import type * as acp from '@zed-industries/agent-client-protocol';
import { AgentSideConnection, ndJsonStream } from '@zed-industries/agent-client-protocol';

async function callEcho(server: acp.McpServer): Promise<string> {
  if (!('type' in server) || server.type !== 'http') {
    return 'no http server';
  }
  const client = new Client({
    name: 'tool-agent',
    version: '0.0.0',
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: {
        headers: Object.fromEntries(
          server.headers.map((h) => [
            h.name,
            h.value,
          ]),
        ),
      },
    }),
  );
  const names = (await client.listTools()).tools.map((t) => t.name);
  const result = await client.callTool({
    name: 'echo',
    arguments: {
      text: 'over the runner',
    },
  });
  await client.close();
  const parts = frameworkCast<
    Array<{
      text?: string;
    }>
  >(result.content);
  return JSON.stringify({
    url: server.url,
    names,
    result: parts.map((p) => p.text ?? '').join(''),
    env: process.env.NOETIC_TOOL_AGENT_MARK ?? null,
  });
}

new AgentSideConnection(
  (conn) => {
    let servers: acp.McpServer[] = [];
    return {
      async initialize() {
        return {
          protocolVersion: 1,
          agentCapabilities: {
            mcpCapabilities: {
              http: true,
            },
          },
        };
      },
      async newSession(params) {
        servers = params.mcpServers;
        return {
          sessionId: 'tool-agent-1',
        };
      },
      async authenticate() {},
      async cancel() {},
      async prompt(params) {
        const server = servers.find((s) => s.name === 'noetic');
        const text = server ? await callEcho(server) : 'no noetic server';
        await conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text,
            },
          },
        });
        return {
          stopReason: 'end_turn',
        };
      },
    };
  },
  ndJsonStream(
    frameworkCast<WritableStream<Uint8Array>>(Writable.toWeb(process.stdout)),
    frameworkCast<ReadableStream<Uint8Array>>(Readable.toWeb(process.stdin)),
  ),
);
