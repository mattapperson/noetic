/**
 * One `mcp()` server attached at every level — the harness (record and list),
 * the turn and a step — must give the model the same tool names, the same
 * results, the same events and the same spans (spec 35 § Attaching
 * connections). The server is a real streamable-HTTP MCP server in this
 * process, and the model is a scripted OpenRouter Responses API.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ConnectionEntries, ExecuteOptions, StepToolEntry } from '@noetic-tools/types';
import { z } from 'zod';
import { AgentHarness, callModel, InMemoryExporter } from '../../core/src/index';
import type { FakeOpenRouter } from '../../core/test/_helpers';
import { startFakeOpenRouter } from '../../core/test/_helpers';
import type { McpProvider } from '../src/provider';
import { mcp } from '../src/provider';
import { textResult } from './_helpers';

//#region Fixtures

const TOKEN = 'tok-matrix-3f9a';

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
        annotations: {
          readOnlyHint: true,
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

function linear(): McpProvider {
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

type Level = 'harness record' | 'harness list' | 'turn' | 'step';

interface Observed {
  readonly answer: string;
  readonly toolsOffered: ReadonlyArray<ReadonlyArray<string>>;
  readonly toolChoices: ReadonlyArray<unknown>;
  readonly modelInput: string;
  readonly events: ReadonlyArray<string>;
  readonly spans: ReadonlyArray<string>;
  readonly leaked: boolean;
}

/** Ids and times differ run to run; everything else must match. */
function normalize(text: string): string {
  return text
    .replace(
      /"(id|callId|call_id|spanId|traceId|parentSpanId|executionId|turnId|messageId|threadId|instance)":"[^"]*"/g,
      '"$1":"*"',
    )
    .replace(
      /"(time|timestamp|startTime|endTime|duration|durationMs|startedAt|endedAt|latencyMs|completedAt|createdAt|created_at|completed_at)":[^,}]*/g,
      '"$1":*',
    )
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
}

async function observe(level: Level, restricted: boolean): Promise<Observed> {
  const server: FakeOpenRouter = startFakeOpenRouter(reader);
  const entry = linear();
  const tools: StepToolEntry[] | undefined =
    restricted || level === 'step'
      ? [
          entry,
        ]
      : undefined;
  const harnessConnections: ConnectionEntries | undefined =
    level === 'harness record'
      ? {
          linear: entry,
        }
      : level === 'harness list'
        ? [
            entry,
          ]
        : undefined;
  const exporter = new InMemoryExporter();
  const harness = new AgentHarness({
    name: 'matrix',
    params: {},
    ...(harnessConnections
      ? {
          connections: harnessConnections,
        }
      : {}),
    agentGraph: callModel({
      id: 'triage',
      model: 'test/model',
      ...(tools
        ? {
            tools,
          }
        : {}),
    }),
    callModelDefaults: {
      provider: 'openrouter',
      apiKey: 'sk-test',
      baseUrl: server.baseUrl,
    },
    traceExporter: exporter,
  });
  const options: ExecuteOptions =
    level === 'turn'
      ? {
          threadId: 't',
          connections: [
            entry,
          ],
        }
      : {
          threadId: 't',
        };
  const events: string[] = [];
  const stream = harness.getFullStream({
    threadId: 't',
  });
  const reading = (async (): Promise<void> => {
    for await (const event of stream) {
      events.push(normalize(JSON.stringify(event)));
    }
  })();
  try {
    await harness.execute('What is wrong with ENG-1?', options);
    const response = await harness.getAgentResponse({
      threadId: 't',
    });
    await Bun.sleep(20);
    const everything = JSON.stringify({
      events,
      rounds: server.rounds,
      spans: exporter.spans,
    });
    return {
      answer: response.text,
      toolsOffered: server.rounds.map((round) => round.tools),
      toolChoices: server.rounds.map((round) => round.toolChoice),
      modelInput: normalize(JSON.stringify(server.rounds.map((round) => round.input))),
      // Connection state events tell where a connection lives: a turn or
      // step entry also reports `closed` when the turn ends.
      events: events.filter((event) => !event.includes('connection_changed')),
      spans: exporter.spans
        .map((span) =>
          normalize(
            JSON.stringify({
              name: span.name,
              attributes: Object.fromEntries(span.attributes),
              events: span.events.map((event) => ({
                name: event.name,
                attributes: event.attributes,
              })),
            }),
          ),
        )
        .sort(),
      leaked: everything.includes(TOKEN),
    };
  } finally {
    await harness.close();
    server.stop();
    void reading;
  }
}

//#endregion

describe('one mcp() server at every level', () => {
  it('gives byte-identical tool names, results, events and spans for callModel', async () => {
    const levels: Level[] = [
      'harness record',
      'harness list',
      'turn',
      'step',
    ];
    const seen = new Map<Level, Observed>();
    for (const level of levels) {
      seen.set(level, await observe(level, true));
    }
    const base = seen.get('harness record');
    expect(base?.answer).toContain('issue ENG-1: login is broken');
    expect(base?.toolsOffered[0]).toEqual([
      'linear_get_issue',
      'linear_close_issue',
    ]);
    expect(base?.leaked).toBe(false);
    expect(base?.events.some((event) => event.includes('tool_call_completed'))).toBe(true);
    expect(base?.spans.some((span) => span.includes('"tool.call"'))).toBe(true);
    for (const level of levels) {
      expect(seen.get(level)).toEqual(base);
    }
  });

  it('an unrestricted step sees the same tools from a harness and a turn entry', async () => {
    const harness = await observe('harness list', false);
    const turn = await observe('turn', false);
    expect(turn).toEqual(harness);
    expect(turn.toolChoices[0]).toBeUndefined();
  });
});
