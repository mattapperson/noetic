/**
 * Every configured value of an `mcp()` server — header values, URL query
 * values and userinfo, stdio env values — is scrubbed from what the model
 * sees, even when the server echoes it back (spec 35 § Secrets).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { PassThrough, Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Spawn } from '@noetic-tools/types';
import { frameworkCast, REDACTED_TEXT } from '@noetic-tools/types';
import { z } from 'zod';
import { AgentHarness, callModel } from '../../core/src/index';
import { startFakeOpenRouter } from '../../core/test/_helpers';
import { mcp } from '../src/provider';
import { connectOptions, TestServer, textResult } from './_helpers';

//#region Fixtures

const HEADER = 'header-3f9a-secret';
const QUERY = 'query-77b1-secret';
const PASSWORD = 'pass-c0de-secret';
const ENV = 'ghp_env4e21secret';
const SECRETS = [
  HEADER,
  QUERY,
  PASSWORD,
  ENV,
];

/** A server with one `whoami` tool that answers with `text`. */
function whoami(text: () => string): TestServer {
  return new TestServer({
    tools: [
      {
        name: 'whoami',
        handler: () => textResult(text()),
      },
    ],
  });
}

let http: ReturnType<typeof Bun.serve>;
let url = '';

beforeAll(() => {
  http = Bun.serve({
    port: 0,
    async fetch(request) {
      const seen = new URL(request.url);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const echo = `key=${request.headers.get('x-api-key')} query=${seen.searchParams.get('api_key')}`;
      await whoami(() => echo)
        .build()
        .connect(transport);
      return transport.handleRequest(request);
    },
  });
  url = `http://localhost:${http.port}/mcp?api_key=${QUERY}&v=1`;
});

afterAll(() => {
  http.stop(true);
});

/** A `spawn` serving MCP in this process, whose `whoami` echoes `GITHUB_TOKEN`. */
const echoEnv: Spawn = async (command) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  await whoami(() => `token=${command.env?.GITHUB_TOKEN}`)
    .build()
    .connect(new StdioServerTransport(stdin, stdout));
  return {
    // node:stream's web types and the DOM lib's are the same streams, typed apart.
    writable: frameworkCast<WritableStream<Uint8Array>>(Writable.toWeb(stdin)),
    readable: frameworkCast<ReadableStream<Uint8Array>>(Readable.toWeb(stdout)),
    close: async () => {
      stdout.end();
    },
  };
};

function remote(): ReturnType<typeof mcp> {
  return mcp({
    name: 'remote',
    type: 'http',
    url,
    headers: [
      {
        name: 'X-Api-Key',
        value: HEADER,
      },
      {
        name: 'X-Mode',
        value: 'json',
      },
    ],
  });
}

function local(): ReturnType<typeof mcp> {
  return mcp({
    name: 'local',
    command: 'github-mcp',
    env: [
      {
        name: 'GITHUB_TOKEN',
        value: ENV,
      },
      {
        name: 'DEBUG',
        value: '1',
      },
      {
        name: 'PATH',
        value: '/usr/local/bin:/usr/bin',
      },
    ],
    spawn: echoEnv,
  });
}

/** Calls both `whoami` tools, then answers with what they returned. */
function reader(input: unknown[]): unknown[] {
  const outputs = input.flatMap((entry) => {
    const parsed = z
      .object({
        type: z.literal('function_call_output'),
        output: z.unknown(),
      })
      .safeParse(entry);
    return parsed.success
      ? [
          String(parsed.data.output),
        ]
      : [];
  });
  if (outputs.length === 0) {
    return [
      'remote_whoami',
      'local_whoami',
    ].map((name, i) => ({
      type: 'function_call',
      id: `fc_${i}`,
      call_id: `call_${i}`,
      name,
      arguments: '{}',
      status: 'completed',
    }));
  }
  return [
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: `read: ${outputs.join(' | ')}`,
          annotations: [],
        },
      ],
    },
  ];
}

//#endregion

describe('configured values are scrubbed', () => {
  it('registers header, query, userinfo and env values, but not short flags or paths', async () => {
    const redacted: string[] = [];
    const options = {
      ...connectOptions('scrub'),
      redact: (value: string) => {
        redacted.push(value);
      },
    };
    const withUser = mcp({
      type: 'http',
      url: `http://user:${PASSWORD}@127.0.0.1:1/mcp?api_key=${QUERY}&v=1`,
      headers: [
        {
          name: 'X-Api-Key',
          value: HEADER,
        },
        {
          name: 'Authorization',
          value: 'Bearer AUTHSECRET',
        },
      ],
      fetch: async () =>
        new Response('no', {
          status: 500,
        }),
    });
    await withUser.connect(options).catch(() => undefined);
    const [connection] = await local().connect(options);
    await connection?.release();
    expect(redacted).toEqual([
      HEADER,
      'Bearer AUTHSECRET',
      'AUTHSECRET',
      PASSWORD,
      QUERY,
      ENV,
    ]);
  });

  it('keeps echoed credentials out of what the model reads', async () => {
    const model = startFakeOpenRouter(reader);
    const harness = new AgentHarness({
      name: 'scrub',
      params: {},
      connections: [
        remote(),
        local(),
      ],
      agentGraph: callModel({
        id: 'whoami',
        model: 'test/model',
      }),
      callModelDefaults: {
        provider: 'openrouter',
        apiKey: 'sk-test',
        baseUrl: model.baseUrl,
      },
    });
    try {
      await harness.execute('Who am I?', {
        threadId: 't',
      });
      // The scripted model answers with every tool output it was given.
      const seen = (
        await harness.getAgentResponse({
          threadId: 't',
        })
      ).text;
      expect(seen).toContain(`key=${REDACTED_TEXT}`);
      expect(seen).toContain(`query=${REDACTED_TEXT}`);
      expect(seen).toContain(`token=${REDACTED_TEXT}`);
      for (const secret of SECRETS) {
        expect(seen).not.toContain(secret);
      }
    } finally {
      await harness.close();
      model.stop();
    }
  });
});
