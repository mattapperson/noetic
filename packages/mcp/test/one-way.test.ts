/**
 * The way to give an agent an MCP server, run as written (spec 35 § Attaching
 * connections): `mcp()` in ACP's `McpServer` shape, listed in a step's
 * `tools`, in the harness's `connections`, or picked by name with
 * `connectionTools('linear', { ops })` — and each one's JSON equivalent, which
 * must give the model the same tools and the same results. Only the fields
 * every step and harness needs (`id`, `model`, `name`, `params`, the provider)
 * are added around the snippets. The server is a real streamable-HTTP MCP server in this
 * process, and the model a scripted OpenRouter Responses API.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpAllowlist, Step } from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';
import type { ContextData } from '../../core/src/index';
import {
  AgentHarness,
  callModel,
  connectionTools,
  parseAndRunWorkflow,
  runCode,
  tool,
} from '../../core/src/index';
import type { FakeOpenRouter } from '../../core/test/_helpers';
import { startFakeOpenRouter } from '../../core/test/_helpers';
import { mcp } from '../src/provider';
import { textResult } from './_helpers';

//#region Fixtures

const token = 'tok-one-way-5d2b';
let LINEAR_MCP = '';
let http: ReturnType<typeof Bun.serve>;

function issueServer(): Server {
  const server = new Server(
    {
      name: 'linear',
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

beforeAll(() => {
  http = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.headers.get('authorization') !== `Bearer ${token}`) {
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
  LINEAR_MCP = `http://localhost:${http.port}/mcp`;
});

afterAll(() => {
  http.stop(true);
});

const search = tool({
  name: 'search',
  description: 'Searches the docs.',
  input: z.object({
    query: z.string(),
  }),
  output: z.string(),
  execute: async () => 'no docs',
});

/** A document's view of the server: ACP's shape, with a `$secret` bearer header. */
function documentServer(): unknown {
  return {
    name: 'linear',
    type: 'http',
    url: LINEAR_MCP,
    headers: [
      {
        name: 'Authorization',
        value: {
          $secret: 'linear.token',
        },
      },
    ],
  };
}

function allowlist(): McpAllowlist {
  return {
    urls: [
      {
        url: 'http://localhost:*/mcp',
        secrets: {
          'linear.token': 'Authorization',
        },
      },
    ],
    provider: mcp,
  };
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
  if (outputs.length > 0) {
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

type AgentGraph = Step<ContextData, string, string>;

interface Observed {
  readonly tools: ReadonlyArray<string>;
  readonly toolChoice: unknown;
  readonly answer: string;
  readonly leaked: boolean;
}

/** Runs one turn of `agentGraph` on a harness built by `build`, and reports what the model saw. */
async function observe(
  build: (agentGraph: AgentGraph, model: FakeOpenRouter) => AgentHarness,
  agentGraph: (harness: () => AgentHarness) => AgentGraph,
): Promise<Observed> {
  const model = startFakeOpenRouter(reader);
  let built: AgentHarness | undefined;
  const harness = build(
    agentGraph(() => {
      assert(built);
      return built;
    }),
    model,
  );
  built = harness;
  try {
    await harness.execute('What is wrong with ENG-1?', {
      threadId: 't',
    });
    const response = await harness.getAgentResponse({
      threadId: 't',
    });
    return {
      tools: model.rounds[0]?.tools ?? [],
      toolChoice: model.rounds[0]?.toolChoice,
      answer: response.text,
      leaked: JSON.stringify(model.rounds).includes(token),
    };
  } finally {
    await harness.close();
    model.stop();
  }
}

/** The fields every harness needs, around the snippet's own. */
function harnessFields(model: FakeOpenRouter): {
  readonly name: string;
  readonly params: Record<string, unknown>;
  readonly tools: [
    typeof search,
  ];
  readonly environment: ConstructorParameters<typeof AgentHarness>[0]['environment'];
  readonly callModelDefaults: ConstructorParameters<typeof AgentHarness>[0]['callModelDefaults'];
} {
  return {
    name: 'one-way',
    params: {},
    tools: [
      search,
    ],
    environment: {
      secrets: {
        async resolve() {
          return `Bearer ${token}`;
        },
      },
    },
    callModelDefaults: {
      provider: 'openrouter',
      apiKey: 'sk-test',
      baseUrl: model.baseUrl,
    },
  };
}

/** A host step that runs `json` from inside the turn, as a document a step hydrates. */
function runsDocument(json: unknown): (harness: () => AgentHarness) => AgentGraph {
  return (harness) =>
    frameworkCast<AgentGraph>(
      runCode({
        id: 'host',
        execute: (input: string, ctx) =>
          parseAndRunWorkflow({
            json,
            harness: harness(),
            ctx,
            input,
            tools: [
              search,
            ],
            mcp: allowlist(),
          }),
      }),
    );
}

function callModelNode(tools?: unknown[]): unknown {
  return {
    kind: 'callModel',
    id: 'triage',
    model: 'test/model',
    instructions: '',
    ...(tools
      ? {
          tools,
        }
      : {}),
  };
}

//#endregion

describe('the one way to give an agent an MCP server', () => {
  it("callModel({ tools: [mcp(…)] }), and a node's { mcp } tools entry", async () => {
    const typescript = await observe(
      (agentGraph, model) =>
        new AgentHarness({
          ...harnessFields(model),
          agentGraph,
        }),
      () =>
        frameworkCast<AgentGraph>(
          callModel({
            id: 'triage',
            model: 'test/model',
            tools: [
              mcp({
                name: 'linear',
                type: 'http',
                url: LINEAR_MCP,
                headers: [
                  {
                    name: 'Authorization',
                    value: `Bearer ${token}`,
                  },
                ],
              }),
            ],
          }),
        ),
    );
    expect(typescript.tools).toContain('linear_get_issue');
    expect(typescript.tools).toContain('linear_close_issue');
    expect(typescript.answer).toContain('issue ENG-1: login is broken');
    expect(typescript.leaked).toBe(false);
    const json = await observe(
      (agentGraph, model) =>
        new AgentHarness({
          ...harnessFields(model),
          agentGraph,
        }),
      runsDocument({
        version: 1,
        root: callModelNode([
          {
            mcp: documentServer(),
          },
        ]),
      }),
    );
    expect(json).toEqual(typescript);
  });

  it("new AgentHarness({ connections: [mcp(…)] }), and a document's { mcp } connections entry", async () => {
    const typescript = await observe(
      (agentGraph, model) =>
        new AgentHarness({
          ...harnessFields(model),
          agentGraph,
          connections: [
            mcp({
              name: 'linear',
              type: 'http',
              url: LINEAR_MCP,
              headers: [
                {
                  name: 'Authorization',
                  value: `Bearer ${token}`,
                },
              ],
            }),
          ],
        }),
      () =>
        frameworkCast<AgentGraph>(
          callModel({
            id: 'triage',
            model: 'test/model',
          }),
        ),
    );
    expect(typescript.tools).toContain('linear_get_issue');
    expect(typescript.tools).toContain('search');
    expect(typescript.answer).toContain('issue ENG-1: login is broken');
    expect(typescript.leaked).toBe(false);
    const json = await observe(
      (agentGraph, model) =>
        new AgentHarness({
          ...harnessFields(model),
          agentGraph,
        }),
      runsDocument({
        version: 1,
        connections: {
          linear: {
            mcp: documentServer(),
          },
        },
        root: callModelNode(),
      }),
    );
    expect(json).toEqual(typescript);
  });

  it("callModel({ tools: [connectionTools('linear', { ops }), search] }), and a node's { connection, ops } pick", async () => {
    const linear = mcp({
      name: 'linear',
      type: 'http',
      url: LINEAR_MCP,
      headers: [
        {
          name: 'Authorization',
          value: `Bearer ${token}`,
        },
      ],
    });
    const typescript = await observe(
      (agentGraph, model) =>
        new AgentHarness({
          ...harnessFields(model),
          agentGraph,
          connections: [
            linear,
          ],
        }),
      () =>
        frameworkCast<AgentGraph>(
          callModel({
            id: 'triage',
            model: 'test/model',
            tools: [
              connectionTools('linear', {
                ops: [
                  'get_*',
                ],
              }),
              search,
            ],
          }),
        ),
    );
    expect(JSON.stringify(typescript.toolChoice)).toContain('linear_get_issue');
    expect(JSON.stringify(typescript.toolChoice)).toContain('search');
    expect(JSON.stringify(typescript.toolChoice)).not.toContain('linear_close_issue');
    expect(typescript.answer).toContain('issue ENG-1: login is broken');
    const json = await observe(
      (agentGraph, model) =>
        new AgentHarness({
          ...harnessFields(model),
          agentGraph,
          connections: [
            linear,
          ],
        }),
      runsDocument({
        version: 1,
        root: callModelNode([
          {
            connection: 'linear',
            ops: [
              'get_*',
            ],
          },
          {
            type: 'search',
          },
        ]),
      }),
    );
    expect(json).toEqual(typescript);
  });

  it("connectionTools('linear') with no connection named 'linear' is CONNECTION_UNKNOWN when the turn starts", async () => {
    const model = startFakeOpenRouter(reader);
    const harness = new AgentHarness({
      ...harnessFields(model),
      agentGraph: callModel({
        id: 'triage',
        model: 'test/model',
        tools: [
          connectionTools('linear'),
          search,
        ],
      }),
    });
    try {
      const failure = await harness
        .execute('What is wrong with ENG-1?', {
          threadId: 't',
        })
        .then(() =>
          harness.getAgentResponse({
            threadId: 't',
          }),
        )
        .catch((e: unknown) => e);
      assert(isNoeticConfigError(failure));
      expect(failure.code).toBe('CONNECTION_UNKNOWN');
      expect(model.rounds).toHaveLength(0);
    } finally {
      await harness.close();
      model.stop();
    }
  });

  it('connectionTools with a malformed name is CONNECTION_INVALID', () => {
    let failure: unknown;
    try {
      connectionTools('1linear');
    } catch (e) {
      failure = e;
    }
    assert(isNoeticConfigError(failure));
    expect(failure.code).toBe('CONNECTION_INVALID');
  });

  it('mcp() refuses auth together with an Authorization header with CONNECTION_INVALID', () => {
    let failure: unknown;
    try {
      mcp({
        name: 'linear',
        type: 'http',
        url: LINEAR_MCP,
        headers: [
          {
            name: 'Authorization',
            value: `Bearer ${token}`,
          },
        ],
        auth: {
          kind: 'bearer',
          token,
        },
      });
    } catch (e) {
      failure = e;
    }
    assert(isNoeticConfigError(failure));
    expect(failure.code).toBe('CONNECTION_INVALID');
  });
});
