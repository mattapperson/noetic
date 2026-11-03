/**
 * One `mcp()` server, attached every way a host or a document can attach it,
 * served to every consumer: a `callModel` step's model and an ACP agent that
 * reaches it through noetic's tool bridge (spec 27 § Tools, spec 35 §
 * Attaching connections). Each pairing must show the consumer the same tool
 * names, give the same result items, and record the same tool events and
 * spans — the idempotency key the server echoes included, which must be
 * `<execution>:tool:<callId>` on both paths.
 *
 * Attachment: the harness (record and list), the turn, a TypeScript step, a
 * step's `connectionTools('linear')` pick by name, a JSON node's inline
 * `{ "mcp" }` entry and `{ "connection" }` pick, and the document's own
 * `connections` entry.
 *
 * The server is a real streamable-HTTP MCP server in this process, the model
 * a scripted OpenRouter Responses API, and the ACP agent a real ACP peer over
 * the loopback transport that calls the bridge with an MCP client, as Claude
 * Code does.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type {
  AcpAgent,
  AcpMcpServer,
  ConnectionEntries,
  ExecuteOptions,
  McpAllowlist,
  Step,
  StepToolEntry,
  WorkflowMcpServer,
  WorkflowToolEntry,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { defineAcpAgent } from '../../acp/src/define';
import { claudeToolWiring } from '../../acp/src/tool-wiring';
import { loopbackMachine } from '../../acp/src/transport-loopback';
import type { ContextData } from '../../core/src/index';
import {
  AgentHarness,
  callModel,
  connectionTools,
  InMemoryExporter,
  parseAndRunWorkflow,
  runCode,
  step,
} from '../../core/src/index';
import type { FakeOpenRouter } from '../../core/test/_helpers';
import { startFakeOpenRouter } from '../../core/test/_helpers';
import { mcp } from '../src/provider';
import { textResult } from './_helpers';

//#region Fixtures

const TOKEN = 'tok-consumers-7c1e';
const PROMPT = 'What is wrong with ENG-1?';
const KEY_META = 'tools.noetic/idempotency-key';

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
    textResult(
      `issue ${String(request.params.arguments?.id)}: login is broken (key ${String(request.params._meta?.[KEY_META])})`,
    ),
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

function linear() {
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

/** A document's view of the server: its URL and a `$secret` bearer header, granted by the host. */
const ALLOWLIST: McpAllowlist = {
  urls: [
    {
      url: 'http://localhost:*/*',
      secrets: {
        'linear.token': 'Authorization',
      },
    },
  ],
  provider: mcp,
};

/** Calls `linear_get_issue` once with call id `call_1`, then answers with what it read. */
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

/** What a Claude-shaped ACP agent saw: the tools the bridge listed. */
interface AgentLog {
  listed: string[];
}

/**
 * An ACP agent shaped like Claude Code: it reaches the bridge with an MCP
 * client, announces its call as an ACP `tool_call`, and calls
 * `linear_get_issue` with its own call id `call_1` in `_meta`.
 */
function claudeShaped(log: AgentLog): AcpAgent {
  return defineAcpAgent({
    agentId: 'claude-shaped',
    command: {
      command: 'claude-shaped',
    },
    tools: claudeToolWiring,
    machine: loopbackMachine((conn) => {
      let servers: ReadonlyArray<AcpMcpServer> = [];
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
            sessionId: 'claude-1',
          };
        },
        async authenticate() {
          return {};
        },
        async cancel() {},
        async prompt(params) {
          const bridge = servers.find((server) => server.name === 'noetic');
          if (!bridge || !('url' in bridge)) {
            throw new Error('no tool bridge in session/new');
          }
          const client = new Client({
            name: 'claude-shaped',
            version: '0.0.0',
          });
          await client.connect(
            new StreamableHTTPClientTransport(new URL(bridge.url), {
              requestInit: {
                headers: Object.fromEntries(
                  bridge.headers.map((header) => [
                    header.name,
                    header.value,
                  ]),
                ),
              },
            }),
          );
          log.listed = (await client.listTools()).tools.map((tool) => tool.name);
          await conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'call_1',
              title: 'mcp__noetic__linear_get_issue',
              kind: 'other',
              status: 'pending',
            },
          });
          const result = await client.callTool({
            name: 'linear_get_issue',
            arguments: {
              id: 'ENG-1',
            },
            _meta: {
              'claudecode/toolUseId': 'call_1',
            },
          });
          const text = frameworkCast<
            Array<{
              text?: string;
            }>
          >(result.content)
            .map((part) => part.text ?? '')
            .join('');
          await client.close();
          await conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `read: ${text}`,
              },
            },
          });
          return {
            stopReason: 'end_turn',
          };
        },
      };
    }),
  });
}

type Attachment =
  | 'harness record'
  | 'harness list'
  | 'turn'
  | 'step'
  | 'pick by name'
  | 'json inline'
  | 'json connection'
  | 'json document';
type Consumer = 'callModel' | 'acp';

/** What one pairing showed: everything a consumer could tell apart. */
interface Observed {
  readonly answer: string;
  readonly toolNames: ReadonlyArray<string>;
  readonly results: ReadonlyArray<string>;
  readonly toolEvents: ReadonlyArray<string>;
  readonly toolSpans: ReadonlyArray<string>;
  readonly leaked: boolean;
}

/** Ids and times differ run to run; everything else must match. */
function normalize(text: string): string {
  return text
    .replace(
      /"(id|spanId|traceId|parentSpanId|executionId|turnId|messageId|threadId|instance)":"[^"]*"/g,
      '"$1":"*"',
    )
    .replace(
      /"(time|timestamp|startTime|endTime|duration|durationMs|startedAt|endedAt|latencyMs|completedAt|createdAt|created_at|completed_at)":[^,}]*/g,
      '"$1":*',
    )
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
}

const TOOL_EVENT =
  /:(tool_call_started|tool_call_completed|tool_round_started|tool_round_completed)$/;

const ToolEventSchema = z.object({
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
});

/** A tool event without the harness-name prefix of its type. */
function toolEventOf(event: unknown): string | undefined {
  const parsed = ToolEventSchema.safeParse(event);
  const kind = parsed.success ? TOOL_EVENT.exec(parsed.data.type)?.[1] : undefined;
  if (!parsed.success || !kind) {
    return undefined;
  }
  return normalize(
    JSON.stringify({
      kind,
      ...parsed.data.data,
    }),
  );
}

/** The server as a document writes it: ACP's shape, with a `$secret` bearer header. */
function documentServer(): WorkflowMcpServer {
  return {
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
  };
}

function entryFor(attachment: Attachment): ReadonlyArray<WorkflowToolEntry> {
  return attachment === 'json inline'
    ? [
        {
          mcp: documentServer(),
        },
      ]
    : [
        {
          connection: 'linear',
        },
      ];
}

/** The graph a pairing runs: the consumer step itself, or a host step that runs it from a document. */
function graphFor(
  pairing: {
    readonly attachment: Attachment;
    readonly consumer: Consumer;
    readonly entry: ReturnType<typeof linear>;
  },
  log: AgentLog,
  harness: () => AgentHarness,
): Step<ContextData, string, string> {
  const { attachment, consumer, entry } = pairing;
  const agent = claudeShaped(log);
  const tools: StepToolEntry[] = [
    attachment === 'pick by name' ? connectionTools('linear') : entry,
  ];
  if (
    attachment === 'json inline' ||
    attachment === 'json connection' ||
    attachment === 'json document'
  ) {
    const node =
      consumer === 'callModel'
        ? {
            kind: 'callModel',
            id: 'triage',
            model: 'test/model',
            instructions: '',
            tools: entryFor(attachment),
          }
        : {
            kind: 'acp-agent',
            id: 'triage',
            agent: 'claude-shaped',
            prompt: PROMPT,
            tools: entryFor(attachment),
          };
    return frameworkCast<Step<ContextData, string, string>>(
      runCode({
        id: 'host',
        execute: (_input: string, ctx) =>
          parseAndRunWorkflow({
            json: {
              version: 1,
              ...(attachment === 'json document'
                ? {
                    connections: {
                      linear: {
                        mcp: documentServer(),
                      },
                    },
                  }
                : {}),
              root: node,
            },
            harness: harness(),
            ctx,
            tools: [],
            mcp: ALLOWLIST,
            acpAgents: new Map([
              [
                'claude-shaped',
                agent,
              ],
            ]),
          }),
      }),
    );
  }
  if (consumer === 'callModel') {
    return frameworkCast<Step<ContextData, string, string>>(
      callModel({
        id: 'triage',
        model: 'test/model',
        tools,
      }),
    );
  }
  return frameworkCast<Step<ContextData, string, string>>(
    step.acpAgent({
      id: 'triage',
      agent,
      prompt: PROMPT,
      tools,
    }),
  );
}

async function observe(attachment: Attachment, consumer: Consumer): Promise<Observed> {
  const model: FakeOpenRouter = startFakeOpenRouter(reader);
  const log: AgentLog = {
    listed: [],
  };
  const entry = linear();
  const harnessConnections: ConnectionEntries | undefined =
    attachment === 'harness record'
      ? {
          linear: entry,
        }
      : attachment === 'harness list' ||
          attachment === 'pick by name' ||
          attachment === 'json connection'
        ? [
            entry,
          ]
        : undefined;
  const exporter = new InMemoryExporter();
  let built: AgentHarness | undefined;
  const harness: AgentHarness = new AgentHarness({
    name: 'consumers',
    params: {},
    ...(harnessConnections
      ? {
          connections: harnessConnections,
        }
      : {}),
    agentGraph: graphFor(
      {
        attachment,
        consumer,
        entry,
      },
      log,
      () => {
        if (!built) {
          throw new Error('harness not built');
        }
        return built;
      },
    ),
    environment: {
      secrets: {
        async resolve() {
          return `Bearer ${TOKEN}`;
        },
      },
    },
    callModelDefaults: {
      provider: 'openrouter',
      apiKey: 'sk-test',
      baseUrl: model.baseUrl,
    },
    traceExporter: exporter,
  });
  built = harness;
  const options: ExecuteOptions =
    attachment === 'turn'
      ? {
          threadId: 't',
          connections: [
            entry,
          ],
        }
      : {
          threadId: 't',
        };
  const events: unknown[] = [];
  const stream = harness.getFullStream({
    threadId: 't',
  });
  const reading = (async (): Promise<void> => {
    for await (const event of stream) {
      events.push(event);
    }
  })();
  try {
    await harness.execute(PROMPT, options);
    const response = await harness.getAgentResponse({
      threadId: 't',
    });
    await Bun.sleep(20);
    const results = response.items.flatMap((item) =>
      item.type === 'function_call_output'
        ? [
            normalize(String(item.output)),
          ]
        : [],
    );
    return {
      answer: normalize(response.text),
      toolNames: consumer === 'acp' ? log.listed : (model.rounds[0]?.tools ?? []),
      results,
      toolEvents: events.flatMap((event) => {
        const tool = toolEventOf(event);
        return tool
          ? [
              tool,
            ]
          : [];
      }),
      toolSpans: exporter.spans
        .filter((span) => span.name === 'tool.call')
        .map((span) =>
          normalize(
            JSON.stringify({
              name: span.name,
              // Attributes are a map; the order they were set in is not part of the span.
              attributes: Object.fromEntries(
                [
                  ...span.attributes,
                ].sort(([a], [b]) => a.localeCompare(b)),
              ),
            }),
          ),
        ),
      leaked: JSON.stringify({
        events,
        spans: exporter.spans,
      }).includes(TOKEN),
    };
  } finally {
    await harness.close();
    model.stop();
    void reading;
  }
}

//#endregion

describe('one mcp() server, every attachment, every consumer', () => {
  it('gives callModel and an ACP agent the same tool names, results, events and spans', async () => {
    const attachments: Attachment[] = [
      'harness record',
      'harness list',
      'turn',
      'step',
      'pick by name',
      'json inline',
      'json connection',
      'json document',
    ];
    const consumers: Consumer[] = [
      'callModel',
      'acp',
    ];
    const seen: Array<{
      readonly attachment: Attachment;
      readonly consumer: Consumer;
      readonly observed: Observed;
    }> = [];
    for (const attachment of attachments) {
      for (const consumer of consumers) {
        seen.push({
          attachment,
          consumer,
          observed: await observe(attachment, consumer),
        });
      }
    }
    const base = seen[0]?.observed;
    expect(base?.toolNames).toEqual([
      'linear_get_issue',
      'linear_close_issue',
    ]);
    expect(base?.results).toEqual([
      JSON.stringify({
        content: [
          {
            type: 'text',
            text: 'issue ENG-1: login is broken (key <uuid>:tool:call_1)',
          },
        ],
      }),
    ]);
    expect(base?.answer).toContain('issue ENG-1: login is broken');
    expect(base?.toolEvents.length).toBeGreaterThan(0);
    expect(base?.toolSpans.length).toBe(1);
    expect(base?.leaked).toBe(false);
    for (const { attachment, consumer, observed } of seen) {
      expect({
        attachment,
        consumer,
        observed,
      }).toEqual({
        attachment,
        consumer,
        observed: base,
      });
    }
  }, 60_000);
});
