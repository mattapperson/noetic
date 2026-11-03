/**
 * One MCP server given to a model from TypeScript (`tools: [mcp(…)]`) and from
 * a JSON document (an inline `{ "mcp" }` entry, or `{ "connection" }` naming a
 * harness connection) must give the model the same tool names and the same
 * results (spec 26 § Tools). The document runs through `parseAndRunWorkflow`
 * from a step, after the turn's tool set is built. The server is a real
 * streamable-HTTP MCP server in this process.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpAllowlist } from '@noetic-tools/types';
import { z } from 'zod';
import { AgentHarness, callModel, parseAndRunWorkflow, runCode } from '../../core/src/index';
import type { FakeOpenRouter } from '../../core/test/_helpers';
import { startFakeOpenRouter } from '../../core/test/_helpers';
import { mcp } from '../src/provider';
import { textResult } from './_helpers';

//#region Fixtures

const TOKEN = 'tok-json-7c1e';
const INSTRUCTIONS = 'Triage the issue.';

function issueServer(): Server {
  const server = new Server(
    {
      name: 'issues',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_issue',
        description: 'Reads one issue.',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
            },
          },
          required: [
            'id',
          ],
        },
      },
      {
        name: 'close_issue',
        description: 'Closes one issue.',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
            },
          },
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    textResult(`issue ${String(request.params.arguments?.id)}: login is broken`),
  );
  return server;
}

let http: ReturnType<typeof Bun.serve>;
let url = '';

beforeAll(() => {
  http = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.headers.get('authorization') !== `Bearer ${TOKEN}`) {
        return new Response('unauthorized', {
          status: 401,
        });
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await issueServer().connect(transport);
      return transport.handleRequest(request);
    },
  });
  url = `http://localhost:${http.port}/mcp`;
});

afterAll(() => {
  http.stop(true);
});

function linear(): ReturnType<typeof mcp> {
  return mcp({
    name: 'linear',
    type: 'http',
    url,
    headers: [
      {
        name: 'Authorization',
        value: `Bearer ${TOKEN}`,
      },
    ],
  });
}

/** Calls `linear_get_issue` once, then answers with what it read. */
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
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'linear_get_issue',
        arguments: JSON.stringify({
          id: 'ENG-1',
        }),
        status: 'completed',
      },
    ];
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

type Route = 'typescript' | 'json inline' | 'json connection';

interface Observed {
  readonly toolsOffered: ReadonlyArray<ReadonlyArray<string>>;
  readonly toolChoices: ReadonlyArray<unknown>;
  readonly results: ReadonlyArray<string>;
  readonly leaked: boolean;
}

const ALLOWLIST = (): McpAllowlist => ({
  urls: [
    {
      url: 'http://localhost:*/mcp',
      secrets: {
        'linear.token': 'Authorization',
      },
    },
  ],
  provider: mcp,
});

function documentFor(route: Exclude<Route, 'typescript'>): unknown {
  const entry =
    route === 'json inline'
      ? {
          mcp: {
            name: 'linear',
            type: 'http',
            url,
            headers: [
              {
                name: 'Authorization',
                value: {
                  $secret: 'linear.token',
                },
              },
            ],
          },
        }
      : {
          connection: 'linear',
        };
  return {
    version: 1,
    root: {
      kind: 'callModel',
      id: 'triage',
      model: 'test/model',
      instructions: INSTRUCTIONS,
      tools: [
        entry,
      ],
    },
  };
}

type AgentGraph = NonNullable<ConstructorParameters<typeof AgentHarness>[0]['agentGraph']>;

function graphFor(route: Route, harness: () => AgentHarness): AgentGraph {
  if (route === 'typescript') {
    return callModel({
      id: 'triage',
      model: 'test/model',
      instructions: INSTRUCTIONS,
      tools: [
        linear(),
      ],
    });
  }
  return runCode({
    id: 'run-document',
    execute: (input: string, ctx) =>
      parseAndRunWorkflow({
        json: documentFor(route),
        harness: harness(),
        ctx,
        tools: [],
        input,
        mcp: ALLOWLIST(),
      }),
  });
}

/** The tool outputs the model was sent, in order. */
function resultsOf(server: FakeOpenRouter): string[] {
  return server.rounds.flatMap((round) =>
    round.input.flatMap((entry) => {
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
    }),
  );
}

async function observe(route: Route): Promise<Observed> {
  const server: FakeOpenRouter = startFakeOpenRouter(reader);
  const harness: AgentHarness = new AgentHarness({
    name: 'json-tools',
    params: {},
    ...(route === 'json connection'
      ? {
          connections: [
            linear(),
          ],
        }
      : {}),
    environment: {
      secrets: {
        async resolve() {
          return `Bearer ${TOKEN}`;
        },
      },
    },
    agentGraph: graphFor(route, () => harness),
    callModelDefaults: {
      provider: 'openrouter',
      apiKey: 'sk-test',
      baseUrl: server.baseUrl,
    },
  });
  try {
    await harness.execute('What is wrong with ENG-1?', {
      threadId: 't',
    });
    await harness.getAgentResponse({
      threadId: 't',
    });
    return {
      toolsOffered: server.rounds.map((round) => round.tools),
      toolChoices: server.rounds.map((round) => round.toolChoice),
      results: resultsOf(server),
      leaked: JSON.stringify(server.rounds).includes(TOKEN),
    };
  } finally {
    await harness.close();
    server.stop();
  }
}

//#endregion

describe('one MCP server from TypeScript and from JSON', () => {
  it('gives identical tool names and results', async () => {
    const typescript = await observe('typescript');
    expect(typescript.toolsOffered[0]).toEqual([
      'linear_get_issue',
      'linear_close_issue',
    ]);
    expect(typescript.results).toHaveLength(1);
    expect(typescript.results[0]).toContain('issue ENG-1: login is broken');
    expect(typescript.leaked).toBe(false);
    for (const route of [
      'json inline',
      'json connection',
    ] satisfies Route[]) {
      expect(await observe(route)).toEqual(typescript);
    }
  });
});
