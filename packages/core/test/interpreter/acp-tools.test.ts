/**
 * Bridged tools on an ACP step: the agent's calls (made here straight through
 * `host.tools`, as the MCP server would) run the `callModel` pipeline and land
 * in the item log in place of the agent's own account of each call.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  AcpAgent,
  AcpAgentConnection,
  AcpClientHost,
  AcpSession,
  AcpToolCall,
  AcpTurnResult,
  ContextLayer,
  FunctionCallItem,
  Item,
  ToolApprover,
} from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';
import { step } from '../../src/builders/step-builders';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { mergeBridgedItems } from '../../src/interpreter/acp-tools';
import { execute } from '../../src/interpreter/execute';
import { makeMessage } from '../_helpers';

//#region Fixtures

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

interface Planned {
  name: string;
  args: unknown;
  /** Sent in the MCP request, as Claude Code and Codex do. */
  agentCallId?: string;
  /** Announced as an ACP `tool_call` first, as every agent does; opencode sends no id over MCP. */
  announce?: {
    toolCallId: string;
    title: string;
  };
}

interface AgentRun {
  host?: AcpClientHost;
  results: Array<{
    output: string;
    isError: boolean;
  }>;
  calls: AcpToolCall[];
}

/**
 * An agent that, during its turn, makes each planned call through the tool
 * host and reports it back as an ACP tool call item, the way a real agent's
 * `tool_call` updates become items.
 */
function toolCallingAgent(
  planned: Planned[] | ((turn: number) => Planned[]),
  run: AgentRun,
  servesTools = true,
): AcpAgent {
  let turn = 0;
  return {
    specificationVersion: 'acp-v1',
    agentId: 'fake-tools',
    servesTools,
    async connect(connect): Promise<AcpAgentConnection> {
      run.host = connect.host;
      const session: AcpSession = {
        sessionId: 's-1',
        availableCommands: [],
        async prompt(): Promise<AcpTurnResult> {
          const tools = connect.host.tools;
          assert(tools);
          const items: Item[] = [
            makeMessage('assistant', 'done'),
          ];
          const plans = typeof planned === 'function' ? planned(turn) : planned;
          turn += 1;
          for (const [index, plan] of plans.entries()) {
            const toolCallId = plan.agentCallId ?? plan.announce?.toolCallId ?? `acp-${index}`;
            if (plan.announce) {
              connect.host.onSessionUpdate({
                sessionId: 's-1',
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: plan.announce.toolCallId,
                  title: plan.announce.title,
                },
              });
            }
            const call: AcpToolCall = {
              name: plan.name,
              args: plan.args,
              agentCallId: plan.agentCallId,
              signal: new AbortController().signal,
            };
            run.calls.push(call);
            run.results.push(await tools.call(call));
            items.push(
              frameworkCast<FunctionCallItem>({
                id: toolCallId,
                type: 'function_call',
                status: 'completed',
                callId: toolCallId,
                name: `mcp__noetic__${plan.name}`,
                arguments: JSON.stringify(plan.args),
              }),
              frameworkCast<Item>({
                id: `${toolCallId}-out`,
                type: 'function_call_output',
                status: 'completed',
                callId: toolCallId,
                output: 'agent-side rendering',
              }),
            );
          }
          return {
            stopReason: 'end_turn',
            items,
            text: 'done',
          };
        },
        async cancel() {},
        async setMode() {},
        async setModel() {},
      };
      return {
        agentCapabilities: {},
        authMethods: [],
        protocolVersion: 1,
        async authenticate() {},
        async newSession() {
          return session;
        },
        async loadSession() {
          return session;
        },
        async close() {},
      };
    },
  };
}

function newRun(): AgentRun {
  return {
    results: [],
    calls: [],
  };
}

function harnessCtx(opts: { approveToolCall?: ToolApprover; contextLayers?: ContextLayer[] } = {}) {
  const harness = new AgentHarness({
    name: 'test',
    params: {},
    ...opts,
  });
  return harness.createContext();
}

function outputs(items: ReadonlyArray<Item>): string[] {
  return items.flatMap((item) =>
    item.type === 'function_call_output'
      ? [
          item.output,
        ]
      : [],
  );
}

//#endregion

describe('ACP bridged tools', () => {
  it('lists tools with wire names, object roots, and titles', async () => {
    const run = newRun();
    const ctx = harnessCtx();
    await execute(
      step.acpAgent({
        id: 'list',
        agent: toolCallingAgent([], run),
        prompt: 'go',
        tools: [
          echo,
          sum,
          shout,
        ],
      }),
      undefined,
      ctx,
    );
    const tools = run.host?.tools;
    assert(tools);
    expect(tools.serverName).toBe('noetic');
    expect(tools.tools.map((t) => t.name)).toEqual([
      'echo',
      'math_sum',
      'shout',
    ]);
    const shoutListing = tools.tools[2];
    assert(shoutListing);
    expect(shoutListing.inputSchema).toEqual({
      type: 'object',
      properties: {
        value: {
          type: 'string',
        },
      },
      required: [
        'value',
      ],
      additionalProperties: false,
    });
  });

  it('answers with the exact strings the callModel path produces', async () => {
    const run = newRun();
    const ctx = harnessCtx();
    await execute(
      step.acpAgent({
        id: 'calls',
        agent: toolCallingAgent(
          [
            {
              name: 'echo',
              args: {
                text: 'hi',
              },
            },
            {
              name: 'math_sum',
              args: {
                a: 2,
                b: 3,
              },
            },
            {
              name: 'boom',
              args: {},
            },
            {
              name: 'echo',
              args: {
                text: 7,
              },
            },
            {
              name: 'shout',
              args: {
                value: 'hey',
              },
            },
            {
              name: 'missing',
              args: {},
            },
          ],
          run,
        ),
        prompt: 'go',
        tools: [
          echo,
          sum,
          boom,
          shout,
        ],
      }),
      undefined,
      ctx,
    );
    expect(run.results.map((r) => r.output)).toEqual([
      'hi',
      '{"total":5}',
      'Error: kaboom',
      expect.stringContaining("Error: invalid arguments for tool 'echo':"),
      'HEY',
      "Error: unknown tool 'missing'",
    ]);
    expect(run.results.map((r) => r.isError)).toEqual([
      false,
      false,
      true,
      true,
      false,
      true,
    ]);
    expect(outputs(ctx.itemLog.items)).toEqual(run.results.map((r) => r.output));
  });

  it('replaces the agent account of a call, keyed by the agent call id', async () => {
    const run = newRun();
    const ctx = harnessCtx();
    await execute(
      step.acpAgent({
        id: 'keyed',
        agent: toolCallingAgent(
          [
            {
              name: 'echo',
              args: {
                text: 'hi',
              },
              agentCallId: 'toolu_1',
            },
          ],
          run,
        ),
        prompt: 'go',
        tools: [
          echo,
        ],
      }),
      undefined,
      ctx,
    );
    const calls = ctx.itemLog.items.filter((item) => item.type === 'function_call');
    expect(calls).toHaveLength(1);
    const [call] = calls;
    assert(call && call.type === 'function_call');
    expect(call.callId).toBe('toolu_1');
    expect(call.name).toBe('echo');
    expect(outputs(ctx.itemLog.items)).toEqual([
      'hi',
    ]);
  });

  it('runs the approver for needsApproval tools and honours a denial', async () => {
    const run = newRun();
    const asked: string[] = [];
    const ctx = harnessCtx({
      approveToolCall: ({ toolName }) => {
        asked.push(toolName);
        return {
          action: 'deny',
          guidance: 'not today',
        };
      },
    });
    await execute(
      step.acpAgent({
        id: 'gated',
        agent: toolCallingAgent(
          [
            {
              name: 'gated',
              args: {},
            },
          ],
          run,
        ),
        prompt: 'go',
        tools: [
          gated,
        ],
      }),
      undefined,
      ctx,
    );
    expect(asked).toEqual([
      'gated',
    ]);
    expect(run.results).toEqual([
      {
        output: 'Tool call denied: not today',
        isError: true,
      },
    ]);
  });

  it('runs calls one at a time even when the agent sends them together', async () => {
    let running = 0;
    let peak = 0;
    const slow = tool({
      name: 'slow',
      description: 'Takes a moment.',
      input: z.object({}),
      output: z.string(),
      execute: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running -= 1;
        return 'ok';
      },
    });
    const run = newRun();
    const ctx = harnessCtx();
    const agent: AcpAgent = {
      ...toolCallingAgent([], run),
      async connect(connect) {
        const connection = await toolCallingAgent([], run).connect(connect);
        const tools = connect.host.tools;
        assert(tools);
        return {
          ...connection,
          async newSession(opts) {
            const session = await connection.newSession(opts);
            return {
              ...session,
              async prompt(prompt) {
                const call = (): Promise<unknown> =>
                  tools.call({
                    name: 'slow',
                    args: {},
                    signal: new AbortController().signal,
                  });
                await Promise.all([
                  call(),
                  call(),
                  call(),
                ]);
                return await session.prompt(prompt);
              },
            };
          },
        };
      },
    };
    await execute(
      step.acpAgent({
        id: 'parallel',
        agent,
        prompt: 'go',
        tools: [
          slow,
        ],
      }),
      undefined,
      ctx,
    );
    expect(peak).toBe(1);
    expect(outputs(ctx.itemLog.items)).toEqual([
      'ok',
      'ok',
      'ok',
    ]);
  });
});

describe('ACP bridged tools, edge cases', () => {
  it('gives a call without an MCP id the id the agent announced it under', async () => {
    const run = newRun();
    const seen: Array<string | undefined> = [];
    const ctx = harnessCtx({
      approveToolCall: ({ callId }) => {
        seen.push(callId);
        return {
          action: 'allow',
        };
      },
    });
    await execute(
      step.acpAgent({
        id: 'announced',
        agent: toolCallingAgent(
          [
            {
              name: 'gated',
              args: {},
              announce: {
                toolCallId: 'oc_1',
                title: 'noetic_gated',
              },
            },
          ],
          run,
        ),
        prompt: 'go',
        tools: [
          gated,
        ],
      }),
      undefined,
      ctx,
    );
    expect(seen).toEqual([
      'oc_1',
    ]);
    const calls = ctx.itemLog.items.filter((item) => item.type === 'function_call');
    expect(calls.map((item) => (item.type === 'function_call' ? item.callId : ''))).toEqual([
      'oc_1',
    ]);
  });

  it('fails the step when the tool pipeline itself throws', async () => {
    const broken = tool({
      name: 'broken',
      description: 'Decorates its result into an invalid item.',
      input: z.object({}),
      output: z.string(),
      execute: async () => 'ran',
      decorateResultItem: () =>
        frameworkCast<Item>({
          type: 'not-an-item',
        }),
    });
    const run = newRun();
    const ctx = harnessCtx();
    const failure = await execute(
      step.acpAgent({
        id: 'broken',
        agent: toolCallingAgent(
          [
            {
              name: 'broken',
              args: {},
            },
          ],
          run,
        ),
        prompt: 'go',
        tools: [
          broken,
        ],
      }),
      undefined,
      ctx,
    ).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(run.results[0]?.isError).toBe(true);
    expect(outputs(ctx.itemLog.items)).toEqual([]);
  });

  it('does not start a call once the step is aborted', async () => {
    let ran = false;
    const marker = tool({
      name: 'marker',
      description: 'Records that it ran.',
      input: z.object({}),
      output: z.string(),
      execute: async () => {
        ran = true;
        return 'ran';
      },
    });
    const run = newRun();
    const ctx = harnessCtx();
    const agent = toolCallingAgent(
      [
        {
          name: 'marker',
          args: {},
        },
      ],
      run,
    );
    const aborting: AcpAgent = {
      ...agent,
      async connect(connect) {
        const connection = await agent.connect(connect);
        return {
          ...connection,
          async newSession(opts) {
            const session = await connection.newSession(opts);
            return {
              ...session,
              async prompt(prompt) {
                ctx.abort('stop');
                return await session.prompt(prompt);
              },
            };
          },
        };
      },
    };
    await execute(
      step.acpAgent({
        id: 'aborted',
        agent: aborting,
        prompt: 'go',
        tools: [
          marker,
        ],
      }),
      undefined,
      ctx,
    ).catch(() => undefined);
    expect(ran).toBe(false);
    expect(run.results).toEqual([
      {
        output: 'Error: the step was cancelled before this tool call ran.',
        isError: true,
      },
    ]);
  });

  it('answers as unknown tools on a reused session whose step gives none', async () => {
    const run = newRun();
    const ctx = harnessCtx();
    const agent = toolCallingAgent(
      (turn) =>
        turn === 0
          ? []
          : [
              {
                name: 'echo',
                args: {
                  text: 'hi',
                },
              },
            ],
      run,
    );
    const session = {
      reuse: 'shared',
      keepAlive: 'run' as const,
    };
    await execute(
      step.acpAgent({
        id: 'first',
        agent,
        prompt: 'go',
        tools: [
          echo,
        ],
        session,
      }),
      undefined,
      ctx,
    );
    await execute(
      step.acpAgent({
        id: 'second',
        agent,
        prompt: 'go',
        session,
      }),
      undefined,
      ctx,
    );
    expect(run.results).toEqual([
      {
        output: "Error: unknown tool 'echo'",
        isError: true,
      },
    ]);
  });

  it('lists a union of objects unwrapped and a nullable object wrapped', async () => {
    const union = tool({
      name: 'pick',
      description: 'Takes one of two shapes.',
      input: z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('a'),
        }),
        z.object({
          kind: z.literal('b'),
        }),
      ]),
      output: z.string(),
      execute: async (input) => input.kind,
    });
    const nullable = tool({
      name: 'maybe',
      description: 'Takes an object or null.',
      input: z
        .object({
          x: z.number(),
        })
        .nullable(),
      output: z.string(),
      execute: async () => 'ok',
    });
    const run = newRun();
    await execute(
      step.acpAgent({
        id: 'schemas',
        agent: toolCallingAgent(
          [
            {
              name: 'pick',
              args: {
                kind: 'b',
              },
            },
            {
              name: 'maybe',
              args: {
                value: null,
              },
            },
          ],
          run,
        ),
        prompt: 'go',
        tools: [
          union,
          nullable,
        ],
      }),
      undefined,
      harnessCtx(),
    );
    const [pickListing, maybeListing] = run.host?.tools?.tools ?? [];
    assert(pickListing && maybeListing);
    expect(pickListing.inputSchema.properties).toBeUndefined();
    expect(Object.keys(maybeListing.inputSchema.properties ?? {})).toEqual([
      'value',
    ]);
    expect(run.results.map((r) => r.output)).toEqual([
      'b',
      'ok',
    ]);
  });
});

describe('ACP bridged tool configuration errors', () => {
  it('rejects tools for an agent that cannot serve them when the step is built', () => {
    try {
      step.acpAgent({
        id: 'pi',
        agent: toolCallingAgent([], newRun(), false),
        prompt: 'go',
        tools: [
          echo,
        ],
      });
      throw new Error('expected a config error');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('ACP_TOOLS_UNSUPPORTED');
    }
  });

  it('rejects a server tool', () => {
    try {
      step.acpAgent({
        id: 'server',
        agent: toolCallingAgent([], newRun()),
        prompt: 'go',
        tools: [
          {
            type: 'openrouter:web_search',
          },
        ],
      });
      throw new Error('expected a config error');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('ACP_SERVER_TOOL');
    }
  });

  it('rejects tools whose wire names collide', () => {
    const named = (name: string) =>
      tool({
        name,
        description: 'Echo the text.',
        input: z.object({}),
        output: z.string(),
        execute: async () => 'ok',
      });
    const slashed = named('a/b');
    const underscored = named('a_b');
    try {
      step.acpAgent({
        id: 'collide',
        agent: toolCallingAgent([], newRun()),
        prompt: 'go',
        tools: [
          slashed,
          underscored,
        ],
      });
      throw new Error('expected a config error');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('ACP_TOOL_NAME_COLLISION');
    }
  });

  it('rejects a user MCP server named like the tool server, when built and when run', async () => {
    for (const name of [
      'noetic',
      'noetic_x',
      'noetic__x',
    ]) {
      try {
        step.acpAgent({
          id: 'clash',
          agent: toolCallingAgent([], newRun()),
          prompt: 'go',
          tools: [
            echo,
          ],
          mcpServers: [
            {
              name,
              command: 'x',
              args: [],
              env: [],
            },
          ],
        });
        throw new Error('expected a config error');
      } catch (e) {
        assert(isNoeticConfigError(e));
        expect(e.code).toBe('ACP_TOOL_SERVER_NAME_CONFLICT');
      }
    }
    const lazy = step.acpAgent({
      id: 'clash-lazy',
      agent: toolCallingAgent([], newRun()),
      prompt: 'go',
      tools: [
        echo,
      ],
      mcpServers: () => [
        {
          name: 'noetic',
          command: 'x',
          args: [],
          env: [],
        },
      ],
    });
    const failure = await execute(lazy, undefined, harnessCtx()).catch((e: unknown) => e);
    assert(isNoeticConfigError(failure));
    expect(failure.code).toBe('ACP_TOOL_SERVER_NAME_CONFLICT');
  });

  it('allows a server whose name only starts with the same letters', () => {
    expect(() =>
      step.acpAgent({
        id: 'docs',
        agent: toolCallingAgent([], newRun()),
        prompt: 'go',
        tools: [
          echo,
        ],
        mcpServers: [
          {
            name: 'noetic-docs',
            command: 'x',
            args: [],
            env: [],
          },
        ],
      }),
    ).not.toThrow();
  });

  it('treats the same tool given twice as one tool', async () => {
    const run = newRun();
    await execute(
      step.acpAgent({
        id: 'twice',
        agent: toolCallingAgent([], run),
        prompt: 'go',
        tools: [
          echo,
          echo,
        ],
      }),
      undefined,
      harnessCtx(),
    );
    expect(run.host?.tools?.tools.map((t) => t.name)).toEqual([
      'echo',
    ]);
  });
});

describe('mergeBridgedItems', () => {
  const callItem = (callId: string, name: string): FunctionCallItem =>
    frameworkCast<FunctionCallItem>({
      id: callId,
      type: 'function_call',
      status: 'completed',
      callId,
      name,
      arguments: '{}',
    });
  const outputItem = (callId: string, output: string): Item =>
    frameworkCast<Item>({
      id: `${callId}-out`,
      type: 'function_call_output',
      status: 'completed',
      callId,
      output,
    });
  const bridged = (wireName: string, callId: string, output: string) => ({
    wireName,
    callItem: callItem(callId, wireName),
    outputItem: outputItem(callId, output),
  });
  const callIds = (items: ReadonlyArray<Item>): string[] =>
    items.flatMap((item) =>
      item.type === 'function_call'
        ? [
            item.callId,
          ]
        : [],
    );

  it('replaces the agent pair in place by exact title, keeping the bridge id', () => {
    const merged = mergeBridgedItems(
      [
        callItem('oc-1', 'noetic_echo'),
        outputItem('oc-1', 'agent text'),
      ],
      [
        bridged('echo', 'gen-1', 'bridge text'),
        bridged('echo', 'gen-2', 'second'),
      ],
    );
    expect(callIds(merged)).toEqual([
      'gen-1',
      'gen-2',
    ]);
    expect(outputs(merged)).toEqual([
      'bridge text',
      'second',
    ]);
  });

  it('never pairs a tool with another whose name merely ends the same way', () => {
    const merged = mergeBridgedItems(
      [
        callItem('a1', 'mcp__noetic__cache_get'),
        outputItem('a1', 'agent cache'),
        callItem('a2', 'mcp__noetic__get'),
        outputItem('a2', 'agent get'),
      ],
      [
        bridged('get', 'b-get', 'GET'),
        bridged('cache_get', 'b-cache', 'CACHE'),
      ],
    );
    expect(callIds(merged)).toEqual([
      'b-cache',
      'b-get',
    ]);
    expect(outputs(merged)).toEqual([
      'CACHE',
      'GET',
    ]);
  });

  it('ignores a title on another server that contains the bridge name', () => {
    const merged = mergeBridgedItems(
      [
        callItem('x', 'mcp__noetic-docs__echo'),
      ],
      [
        bridged('echo', 'b-1', 'ok'),
      ],
    );
    expect(callIds(merged)).toEqual([
      'x',
      'b-1',
    ]);
  });
});
