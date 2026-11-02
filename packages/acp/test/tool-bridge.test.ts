/**
 * Noetic tools served to an ACP agent over MCP, end to end: a real ACP agent
 * over the loopback transport calls the step's tools through the real HTTP MCP
 * server, and every outcome must match the same tools called by a model in a
 * `callModel` step.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ContextData } from '@noetic-tools/context';
import { AgentHarness, execute, step, tool, toolWithGenerator } from '@noetic-tools/core';
import type {
  AcpRequestPermissionRequest,
  AcpToolHost,
  ContextLayer,
  Item,
  LLMResponse,
  Step,
  Tool,
  ToolApprover,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import type * as acp from '@zed-industries/agent-client-protocol';
import { z } from 'zod';
import { customAcpAgent } from '../src/agents';
import { startToolBridge } from '../src/tool-bridge';
import { allowOnceOption, isBridgedToolCall } from '../src/tool-permissions';
import { codexToolWiring, opencodeToolWiring } from '../src/tool-wiring';
import { loopbackTransport } from '../src/transport-loopback';

//#region Tools under test

const echo = tool({
  name: 'echo',
  description: 'Echo the text.',
  input: z.object({
    text: z.string(),
  }),
  output: z.string(),
  execute: async ({ text }) => text,
});

const sum = tool({
  name: 'math/sum',
  description: 'Add two numbers.',
  input: z.object({
    a: z.number(),
    b: z.number(),
  }),
  output: z.object({
    total: z.number(),
  }),
  execute: async ({ a, b }) => ({
    total: a + b,
  }),
});

const boom = tool({
  name: 'boom',
  description: 'Always throws.',
  input: z.object({}),
  output: z.string(),
  execute: async () => {
    throw new Error('kaboom');
  },
});

const shout = tool({
  name: 'shout',
  description: 'Upper-case a bare string.',
  input: z.string(),
  output: z.string(),
  execute: async (text) => text.toUpperCase(),
});

const gated = tool({
  name: 'gated',
  description: 'Needs approval.',
  input: z.object({}),
  output: z.string(),
  needsApproval: true,
  execute: async () => 'ran',
});

const fenced = tool({
  name: 'fenced',
  description: 'Steered away by a layer.',
  input: z.object({}),
  output: z.string(),
  execute: async () => 'should not run',
});

const counted = toolWithGenerator({
  name: 'counted',
  description: 'Streams progress, then returns.',
  input: z.object({}),
  event: z.number(),
  output: z.string(),
  async *execute() {
    yield 1;
    yield 2;
    return 'counted to 2';
  },
});

const decorated = tool({
  name: 'decorated',
  description: 'Decorates its result item.',
  input: z.object({}),
  output: z.string(),
  execute: async () => 'plain',
  decorateResultItem: ({ baseItem }) => ({
    ...baseItem,
    output: `${baseItem.output} (decorated)`,
  }),
});

const TOOLS: Tool[] = [
  echo,
  sum,
  boom,
  shout,
  gated,
  fenced,
  counted,
  decorated,
];

/** Each call: the wire name, what a model sends, and what an MCP client sends. */
const CALLS: Array<{
  name: string;
  modelArgs: unknown;
  mcpArgs: Record<string, unknown>;
}> = [
  {
    name: 'echo',
    modelArgs: {
      text: 'hi',
    },
    mcpArgs: {
      text: 'hi',
    },
  },
  {
    name: 'math_sum',
    modelArgs: {
      a: 2,
      b: 3,
    },
    mcpArgs: {
      a: 2,
      b: 3,
    },
  },
  {
    name: 'boom',
    modelArgs: {},
    mcpArgs: {},
  },
  {
    name: 'echo',
    modelArgs: {
      text: 7,
    },
    mcpArgs: {
      text: 7,
    },
  },
  {
    name: 'shout',
    modelArgs: 'hey',
    mcpArgs: {
      value: 'hey',
    },
  },
  {
    name: 'gated',
    modelArgs: {},
    mcpArgs: {},
  },
  {
    name: 'fenced',
    modelArgs: {},
    mcpArgs: {},
  },
  {
    name: 'counted',
    modelArgs: {},
    mcpArgs: {},
  },
  {
    name: 'decorated',
    modelArgs: {},
    mcpArgs: {},
  },
];

//#endregion

//#region Shared gates

interface GateLog {
  approvals: string[];
  steered: string[];
}

function gates(log: GateLog): {
  approveToolCall: ToolApprover;
  contextLayers: ContextLayer[];
} {
  return {
    approveToolCall: ({ toolName }) => {
      log.approvals.push(toolName);
      return {
        action: 'deny',
        guidance: 'not today',
      };
    },
    contextLayers: [
      frameworkCast<ContextLayer>({
        id: 'fence',
        slot: 10,
        scope: 'execution',
        hooks: {
          beforeToolCall: async (params: { toolName: string }) => {
            log.steered.push(params.toolName);
            return {
              decision:
                params.toolName === 'fenced'
                  ? {
                      action: 'deny',
                      guidance: 'fenced off',
                    }
                  : {
                      action: 'allow',
                    },
            };
          },
        },
      }),
    ],
  };
}

function toolOutputs(items: ReadonlyArray<Item>): string[] {
  return items.flatMap((item) =>
    item.type === 'function_call_output'
      ? [
          item.output,
        ]
      : [],
  );
}

//#endregion

//#region Model path

/** Round 1 calls every tool; round 2 ends with a message. */
function scriptedModel(): unknown {
  let round = 0;
  const response = (output: unknown[]): LLMResponse =>
    frameworkCast<LLMResponse>({
      id: `resp-${round}`,
      status: 'completed',
      output,
      items: [],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
      },
    });
  return {
    callModel: () => ({
      async *getFullResponsesStream() {},
      getResponse: async () => {
        round += 1;
        if (round === 1) {
          return response(
            CALLS.map((call, index) => ({
              id: `fc-${index}`,
              status: 'completed',
              type: 'function_call',
              callId: `call-${index}`,
              name: call.name,
              arguments: JSON.stringify(call.modelArgs),
            })),
          );
        }
        return response([
          {
            id: 'msg',
            status: 'completed',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'done',
              },
            ],
          },
        ]);
      },
    }),
  };
}

async function runModelPath(log: GateLog): Promise<Item[]> {
  const harness = new AgentHarness({
    name: 'model-path',
    params: {},
    ...gates(log),
  });
  frameworkCast<{
    client: unknown;
  }>(harness).client = scriptedModel();
  const ctx = harness.createContext();
  const graph = frameworkCast<Step<ContextData, string, string>>({
    kind: 'callModel',
    id: 'act',
    model: 'test/model',
    tools: TOOLS,
  });
  await execute(graph, 'go', ctx);
  return [
    ...ctx.itemLog.items,
  ];
}

//#endregion

//#region ACP path

interface AgentLog {
  permissionAnswers: string[];
  mcpResults: Array<{
    text: string;
    isError: boolean;
  }>;
  listedNames: string[];
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = frameworkCast<
    Array<{
      type: string;
      text?: string;
    }>
  >(result.content);
  return content.map((part) => part.text ?? '').join('');
}

/**
 * An ACP agent shaped like Claude Code: for each call it announces a
 * `tool_call`, asks permission, then calls the tool over MCP with its own call
 * id in `_meta`.
 */
function claudeShapedAgent(log: AgentLog): (conn: acp.AgentSideConnection) => acp.Agent {
  return (conn) => {
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
          sessionId: 'claude-1',
        };
      },
      async authenticate() {},
      async cancel() {},
      async prompt(params) {
        const server = servers.find((s) => s.name === 'noetic');
        assert(server && 'type' in server && server.type === 'http');
        const client = new Client({
          name: 'claude-shaped',
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
        log.listedNames = (await client.listTools()).tools.map((t) => t.name);
        for (const [index, call] of CALLS.entries()) {
          const toolCallId = `toolu_${index}`;
          const title = `mcp__noetic__${call.name}`;
          await conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId,
              title,
              kind: 'other',
              status: 'pending',
              rawInput: call.mcpArgs,
            },
          });
          const permission = await conn.requestPermission({
            sessionId: params.sessionId,
            toolCall: {
              toolCallId,
              title,
              _meta: {
                claudeCode: {
                  mcpServer: {
                    name: 'noetic',
                  },
                },
              },
            },
            options: [
              {
                optionId: 'allow-once',
                name: 'Yes',
                kind: 'allow_once',
              },
              {
                optionId: 'reject',
                name: 'No',
                kind: 'reject_once',
              },
            ],
          });
          log.permissionAnswers.push(
            permission.outcome.outcome === 'selected' ? permission.outcome.optionId : 'cancelled',
          );
          const result = await client.callTool({
            name: call.name,
            arguments: call.mcpArgs,
            _meta: {
              'claudecode/toolUseId': toolCallId,
            },
          });
          log.mcpResults.push({
            text: textOf(result),
            isError: result.isError === true,
          });
          await conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: result.isError ? 'failed' : 'completed',
              content: [
                {
                  type: 'content',
                  content: {
                    type: 'text',
                    text: textOf(result),
                  },
                },
              ],
            },
          });
        }
        await client.close();
        await conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'done',
            },
          },
        });
        return {
          stopReason: 'end_turn',
        };
      },
    };
  };
}

async function runAcpPath(gateLog: GateLog, agentLog: AgentLog): Promise<Item[]> {
  const harness = new AgentHarness({
    name: 'acp-path',
    params: {},
    ...gates(gateLog),
  });
  const ctx = harness.createContext();
  const acpStep = step.acpAgent({
    id: 'delegate',
    agent: customAcpAgent({
      agentId: 'claude-shaped',
      transport: loopbackTransport(claudeShapedAgent(agentLog)),
      tools: true,
    }),
    prompt: 'go',
    tools: TOOLS,
  });
  await execute(acpStep, undefined, ctx);
  return [
    ...ctx.itemLog.items,
  ];
}

//#endregion

describe('Noetic tools in an ACP agent', () => {
  it('matches callModel on every outcome, gate, and result item', async () => {
    const modelGates: GateLog = {
      approvals: [],
      steered: [],
    };
    const acpGates: GateLog = {
      approvals: [],
      steered: [],
    };
    const agentLog: AgentLog = {
      permissionAnswers: [],
      mcpResults: [],
      listedNames: [],
    };

    const modelItems = await runModelPath(modelGates);
    const acpItems = await runAcpPath(acpGates, agentLog);

    const expected = toolOutputs(modelItems);
    expect(expected).toHaveLength(CALLS.length);
    expect(toolOutputs(acpItems)).toEqual(expected);
    expect(acpGates).toEqual(modelGates);
    expect(agentLog.listedNames).toEqual([
      'echo',
      'math_sum',
      'boom',
      'shout',
      'gated',
      'fenced',
      'counted',
      'decorated',
    ]);
    expect(agentLog.permissionAnswers).toEqual(CALLS.map(() => 'allow-once'));
    // The agent receives what the tool produced; the decorated item is the
    // host's record, exactly as in callModel.
    expect(agentLog.mcpResults.map((r) => r.text)).toEqual([
      'hi',
      '{"total":5}',
      'Error: kaboom',
      expect.stringContaining("Error: invalid arguments for tool 'echo':"),
      'HEY',
      'Tool call denied: not today',
      'Tool call denied: fenced off',
      'counted to 2',
      'plain',
    ]);
    expect(agentLog.mcpResults.map((r) => r.isError)).toEqual([
      false,
      false,
      true,
      true,
      false,
      true,
      true,
      false,
      false,
    ]);
    const acpCallIds = acpItems.flatMap((item) =>
      item.type === 'function_call'
        ? [
            item.callId,
          ]
        : [],
    );
    expect(acpCallIds).toEqual(CALLS.map((_, index) => `toolu_${index}`));
  }, 3e4);
});

describe('isBridgedToolCall', () => {
  const host: AcpToolHost = {
    serverName: 'noetic',
    tools: [
      {
        name: 'echo',
        description: 'Echo.',
        inputSchema: {
          type: 'object',
        },
      },
    ],
    call: async () => ({
      output: '',
      isError: false,
    }),
  };
  const request = (
    toolCall: AcpRequestPermissionRequest['toolCall'],
  ): AcpRequestPermissionRequest => ({
    sessionId: 's',
    toolCall,
    options: [],
  });

  it('recognizes each agent by the exact title it gives a listed tool', () => {
    for (const title of [
      'mcp__noetic__echo',
      'noetic_echo',
    ]) {
      expect(
        isBridgedToolCall(
          request({
            toolCallId: 't',
            title,
            kind: 'other',
          }),
          host,
          undefined,
        ),
      ).toBe(true);
    }
  });

  it('recognizes Codex through its announced tool call', () => {
    expect(
      isBridgedToolCall(
        request({
          toolCallId: 'exec-1',
        }),
        host,
        {
          toolCallId: 'exec-1',
          title: 'mcp.noetic.echo',
          kind: 'execute',
        },
      ),
    ).toBe(true);
  });

  it('refuses anything that is not exactly a listed tool', () => {
    const refused: Array<AcpRequestPermissionRequest['toolCall']> = [
      {
        toolCallId: 'shell',
        title: 'noetic_cleanup.sh && rm -rf ~',
        kind: 'execute',
      },
      {
        toolCallId: 'shell-exact',
        title: 'noetic_echo',
        kind: 'execute',
      },
      {
        toolCallId: 'args',
        title: 'deploy',
        rawInput: {
          server: 'noetic',
          tool: 'echo',
        },
      },
      {
        toolCallId: 'nested',
        title: 'mcp__noetic__x__deploy',
      },
      {
        toolCallId: 'unlisted',
        title: 'mcp__noetic__other',
      },
      {
        toolCallId: 'meta-only',
        title: 'Bash',
        _meta: {
          claudeCode: {
            mcpServer: {
              name: 'noetic',
            },
          },
        },
      },
    ];
    for (const call of refused) {
      expect(isBridgedToolCall(request(call), host, undefined)).toBe(false);
    }
  });

  it('prefers allow_once, then allow_always', () => {
    expect(
      allowOnceOption([
        {
          optionId: 'a',
          name: 'Always',
          kind: 'allow_always',
        },
        {
          optionId: 'o',
          name: 'Once',
          kind: 'allow_once',
        },
      ])?.optionId,
    ).toBe('o');
    expect(
      allowOnceOption([
        {
          optionId: 'a',
          name: 'Always',
          kind: 'allow_always',
        },
      ])?.optionId,
    ).toBe('a');
  });
});

describe('startToolBridge', () => {
  it('closes the server when the launch settings throw', async () => {
    let url: string | undefined;
    const failure = await startToolBridge({
      wiring: {
        declare: 'launch',
        launchEnv(launch) {
          url = launch.bridge.url;
          throw new TypeError('bad config');
        },
      },
      getHost: () => undefined,
      serverName: 'noetic',
      tools: [],
      mcpServers: [],
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TypeError);
    assert(url);
    const reached = await fetch(url, {
      method: 'POST',
    }).then(
      () => true,
      () => false,
    );
    expect(reached).toBe(false);
  });

  it('reports a malformed agent config as a TypeError', () => {
    expect(() =>
      codexToolWiring.launchEnv?.({
        bridge: {
          serverName: 'noetic',
          url: 'http://127.0.0.1:1/x',
          headers: [],
        },
        tools: [],
        mcpServers: [],
        env: {
          CODEX_CONFIG: '{not json',
        },
      }),
    ).toThrow(TypeError);
  });
});

describe('agent tool wiring', () => {
  const bridge = {
    serverName: 'noetic',
    url: 'http://127.0.0.1:1/mcp/x',
    headers: [
      {
        name: 'Authorization',
        value: 'Bearer t',
      },
    ],
  };

  it('declares every MCP server for Codex at launch, keeping the user config', () => {
    const env = codexToolWiring.launchEnv?.({
      bridge,
      tools: [
        {
          name: 'echo',
          description: 'Echo.',
          inputSchema: {
            type: 'object',
          },
        },
      ],
      mcpServers: [
        {
          name: 'github',
          type: 'http',
          url: 'https://gh.example/mcp',
          headers: [],
        },
      ],
      env: {
        CODEX_CONFIG: JSON.stringify({
          model: 'x',
          mcp_servers: {
            existing: {
              command: 'e',
            },
          },
        }),
      },
    });
    assert(env?.CODEX_CONFIG);
    const config = JSON.parse(env.CODEX_CONFIG);
    expect(codexToolWiring.declare).toBe('launch');
    expect(config.shell_environment_policy.exclude).toEqual([
      'CODEX_CONFIG',
    ]);
    expect(config.model).toBe('x');
    expect(Object.keys(config.mcp_servers).sort()).toEqual([
      'existing',
      'github',
      'noetic',
    ]);
    expect(config.mcp_servers.noetic).toMatchObject({
      url: bridge.url,
      http_headers: {
        Authorization: 'Bearer t',
      },
      omit_tools_from: [
        'code_mode',
        'deferred',
      ],
      default_tools_approval_mode: 'approve',
      tools: {
        echo: {
          output_token_limit: 1e9,
        },
      },
    });
  });

  it('lifts opencode output limits, keeping the user config', () => {
    const env = opencodeToolWiring.launchEnv?.({
      bridge,
      tools: [],
      mcpServers: [],
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          model: 'y',
        }),
      },
    });
    assert(env?.OPENCODE_CONFIG_CONTENT);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({
      model: 'y',
      tool_output: {
        max_lines: 1e9,
        max_bytes: 1e9,
      },
    });
  });
});
