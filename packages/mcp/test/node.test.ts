import { afterEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AcpToolCall, AcpToolHost } from '@noetic-tools/types';
import type { HttpToolServer } from '../src/node';
import { serveToolsOverHttp } from '../src/node';
import { agentCallIdOf } from '../src/server';

const servers: HttpToolServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

function echoHost(calls: AcpToolCall[] = []): AcpToolHost {
  return {
    serverName: 'noetic',
    tools: [
      {
        name: 'echo',
        description: 'Echo the text.',
        inputSchema: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
            },
          },
        },
        title: 'Echo',
      },
    ],
    async call(call) {
      calls.push(call);
      if (call.name === 'fail') {
        return {
          output: 'Error: nope',
          isError: true,
        };
      }
      return {
        output: JSON.stringify(call.args),
        isError: false,
      };
    },
  };
}

async function start(host: AcpToolHost | undefined): Promise<HttpToolServer> {
  const server = await serveToolsOverHttp(() => host);
  servers.push(server);
  return server;
}

async function connect(server: HttpToolServer): Promise<Client> {
  const client = new Client({
    name: 'test',
    version: '0.0.0',
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${server.token}`,
        },
      },
    }),
  );
  clients.push(client);
  return client;
}

describe('serveToolsOverHttp', () => {
  it('lists host tools with the always-load and result-size hints', async () => {
    const client = await connect(await start(echoHost()));
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    const [listed] = tools;
    assert(listed);
    expect(listed.name).toBe('echo');
    expect(listed.title).toBe('Echo');
    expect(listed.inputSchema.type).toBe('object');
    expect(listed._meta?.['anthropic/alwaysLoad']).toBe(true);
    expect(listed._meta?.['anthropic/maxResultSizeChars']).toBe(1e9);
  });

  it('forwards a call with the agent call id and returns the exact output', async () => {
    const calls: AcpToolCall[] = [];
    const client = await connect(await start(echoHost(calls)));
    const result = await client.callTool({
      name: 'echo',
      arguments: {
        text: 'hi',
      },
      _meta: {
        'claudecode/toolUseId': 'toolu_1',
      },
    });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: '{"text":"hi"}',
      },
    ]);
    const [call] = calls;
    assert(call);
    expect(call.agentCallId).toBe('toolu_1');
  });

  it('marks an error result as isError', async () => {
    const client = await connect(await start(echoHost()));
    const result = await client.callTool({
      name: 'fail',
      arguments: {},
    });
    expect(result.isError).toBe(true);
  });

  it('answers as an unknown tool when no host is bound', async () => {
    const client = await connect(await start(undefined));
    const result = await client.callTool({
      name: 'echo',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: "Error: unknown tool 'echo'",
      },
    ]);
  });

  it('refuses a request without the bearer token', async () => {
    const server = await start(echoHost());
    const res = await fetch(server.url, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('refuses a request from a web origin', async () => {
    const server = await start(echoHost());
    const res = await fetch(server.url, {
      method: 'POST',
      body: '{}',
      headers: {
        Authorization: `Bearer ${server.token}`,
        Origin: 'https://evil.example',
      },
    });
    expect(res.status).toBe(403);
  });

  it('refuses a request naming another host', async () => {
    const server = await start(echoHost());
    const res = await fetch(server.url, {
      method: 'POST',
      body: '{}',
      headers: {
        Authorization: `Bearer ${server.token}`,
        Host: 'evil.example',
      },
    });
    expect(res.status).toBe(403);
  });

  it('opens sessions only by POST and refuses unknown session ids', async () => {
    const server = await start(echoHost());
    const headers = {
      Authorization: `Bearer ${server.token}`,
    };
    const get = await fetch(server.url, {
      headers,
    });
    expect(get.status).toBe(405);
    const unknown = await fetch(server.url, {
      method: 'POST',
      body: '{}',
      headers: {
        ...headers,
        'mcp-session-id': 'nope',
      },
    });
    expect(unknown.status).toBe(404);
  });

  it('accepts its path with a query string', async () => {
    const server = await start(echoHost());
    const client = await connect({
      ...server,
      url: `${server.url}?probe=1`,
    });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
  });

  it('refuses any other path', async () => {
    const server = await start(echoHost());
    const res = await fetch(new URL('/mcp/other', server.url), {
      method: 'POST',
      body: '{}',
      headers: {
        Authorization: `Bearer ${server.token}`,
      },
    });
    expect(res.status).toBe(404);
  });
});

describe('agentCallIdOf', () => {
  it('reads Claude and Codex call ids and ignores everything else', () => {
    expect(
      agentCallIdOf({
        'claudecode/toolUseId': 'toolu_1',
      }),
    ).toBe('toolu_1');
    expect(
      agentCallIdOf({
        callId: 'exec-1',
      }),
    ).toBe('exec-1');
    expect(
      agentCallIdOf({
        progressToken: 2,
      }),
    ).toBeUndefined();
    expect(agentCallIdOf(undefined)).toBeUndefined();
  });
});
