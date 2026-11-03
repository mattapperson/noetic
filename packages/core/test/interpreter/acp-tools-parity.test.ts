/**
 * An ACP step's tools and layers behave as a `callModel` step's: the same
 * tool set by default, layer recall in front of every turn, every started
 * call recorded, and nested runs that leave the outer turn alone.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  AcpAgent,
  AcpAgentConnection,
  AcpClientHost,
  AcpPromptOptions,
  AcpSession,
  AcpToolResult,
  AcpTurnResult,
  ContextLayer,
  Item,
} from '@noetic-tools/types';
import { createMessage, frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { acpAgentTool } from '../../src/builders/acp-agent-tool';
import { runCode, step } from '../../src/builders/step-builders';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { execute } from '../../src/interpreter/execute';
import { makeMessage } from '../_helpers';

//#region Fixtures

interface Turn {
  host: AcpClientHost;
  prompt: AcpPromptOptions;
  call: (name: string, args?: unknown) => Promise<AcpToolResult>;
}

interface AgentLog {
  prompts: string[];
  tools: string[][];
  results: AcpToolResult[];
  closes: number;
}

/** An agent whose turn is scripted by `play`, which can call the served tools. */
function scriptedAgent(
  play: (turn: Turn) => Promise<void>,
  log: AgentLog,
  servesTools = true,
): AcpAgent {
  return {
    specificationVersion: 'acp-v1',
    agentId: 'scripted',
    servesTools,
    async connect(connect): Promise<AcpAgentConnection> {
      const session: AcpSession = {
        sessionId: 's-1',
        availableCommands: [],
        async prompt(prompt): Promise<AcpTurnResult> {
          log.prompts.push(
            prompt.content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
          );
          log.tools.push(connect.host.tools?.tools.map((t) => t.name) ?? []);
          await play({
            host: connect.host,
            prompt,
            call: async (name, args = {}) => {
              const tools = connect.host.tools;
              assert(tools);
              const result = await tools.call({
                name,
                args,
                signal: new AbortController().signal,
              });
              log.results.push(result);
              return result;
            },
          });
          return {
            stopReason: 'end_turn',
            items: [
              makeMessage('assistant', 'done'),
            ],
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
        async close() {
          log.closes += 1;
        },
      };
    },
  };
}

function newLog(): AgentLog {
  return {
    prompts: [],
    tools: [],
    results: [],
    closes: 0,
  };
}

const echo = tool({
  name: 'echo',
  description: 'Echo the text.',
  input: z.object({
    text: z.string(),
  }),
  output: z.string(),
  execute: async ({ text }) => text,
});

const silent = tool({
  name: 'silent',
  description: 'Returns nothing.',
  input: z.object({}),
  output: z.void(),
  execute: async () => undefined,
});

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

describe('ACP tool set, as on callModel', () => {
  it('serves every tool the run offers when the step gives none', async () => {
    const log = newLog();
    const harness = new AgentHarness({
      name: 't',
      params: {},
      tools: [
        echo,
      ],
    });
    const acpStep = step.acpAgent({
      id: 'all',
      agent: scriptedAgent(async () => {}, log),
      prompt: 'go',
    });
    await harness.run(acpStep, undefined, harness.createContext());
    expect(log.tools).toEqual([
      [
        'echo',
      ],
    ]);
  });

  it('gives an agent that cannot take tools none, rather than failing, when none were asked for', async () => {
    const log = newLog();
    const harness = new AgentHarness({
      name: 't',
      params: {},
      tools: [
        echo,
      ],
    });
    const acpStep = step.acpAgent({
      id: 'pi-like',
      agent: scriptedAgent(async () => {}, log, false),
      prompt: 'go',
    });
    await harness.run(acpStep, undefined, harness.createContext());
    expect(log.tools).toEqual([
      [],
    ]);
  });

  it('never serves the acpAgentTool that runs the step itself', async () => {
    const log = newLog();
    const delegate = acpAgentTool({
      agent: scriptedAgent(async () => {}, log),
      name: 'delegate',
    });
    const harness = new AgentHarness({
      name: 't',
      params: {},
      tools: [
        delegate,
        echo,
      ],
    });
    const ctx = harness.createContext();
    await harness.run(
      step.acpAgent({
        id: 'outer',
        agent: scriptedAgent(async (turn) => {
          await turn.call('delegate', {
            prompt: 'inner',
          });
        }, log),
        prompt: 'go',
      }),
      undefined,
      ctx,
    );
    expect(log.tools[0]).toEqual([
      'delegate',
      'echo',
    ]);
    expect(log.tools[1]).toEqual([
      'echo',
    ]);
  });
});

describe('ACP tool calls, as on callModel', () => {
  it('sends a tool with no result as an empty string', async () => {
    const log = newLog();
    const ctx = new AgentHarness({
      name: 't',
      params: {},
    }).createContext();
    await execute(
      step.acpAgent({
        id: 'void',
        agent: scriptedAgent(async (turn) => {
          await turn.call('silent');
        }, log),
        prompt: 'go',
        tools: [
          silent,
        ],
      }),
      undefined,
      ctx,
    );
    expect(log.results).toEqual([
      {
        output: '',
        isError: false,
      },
    ]);
    expect(outputs(ctx.itemLog.items)).toEqual([
      '',
    ]);
  });

  it('runs no queued call once a call pipeline has failed', async () => {
    let sideRan = false;
    const broken = tool({
      name: 'broken',
      description: 'Its result item fails validation.',
      input: z.object({}),
      output: z.string(),
      execute: async () => 'ran',
      decorateResultItem: () =>
        frameworkCast<Item>({
          type: 'not-an-item',
        }),
    });
    const side = tool({
      name: 'side',
      description: 'Has a side effect.',
      input: z.object({}),
      output: z.string(),
      execute: async () => {
        sideRan = true;
        return 'side';
      },
    });
    const log = newLog();
    const failure = await execute(
      step.acpAgent({
        id: 'fail-fast',
        agent: scriptedAgent(async (turn) => {
          await Promise.all([
            turn.call('broken'),
            turn.call('side'),
          ]);
        }, log),
        prompt: 'go',
        tools: [
          broken,
          side,
        ],
      }),
      undefined,
      new AgentHarness({
        name: 't',
        params: {},
      }).createContext(),
    ).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(sideRan).toBe(false);
  });

  it('records a call still running when the agent ends its turn', async () => {
    const slow = tool({
      name: 'slow',
      description: 'Takes a moment.',
      input: z.object({}),
      output: z.string(),
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return 'late';
      },
    });
    const log = newLog();
    const ctx = new AgentHarness({
      name: 't',
      params: {},
    }).createContext();
    await execute(
      step.acpAgent({
        id: 'late',
        agent: scriptedAgent(async (turn) => {
          void turn.call('slow');
          await new Promise((resolve) => setTimeout(resolve, 5));
        }, log),
        prompt: 'go',
        tools: [
          slow,
        ],
      }),
      undefined,
      ctx,
    );
    expect(outputs(ctx.itemLog.items)).toEqual([
      'late',
    ]);
  });

  it('lets a tool run a step on its context without ending the outer turn', async () => {
    const nested = tool({
      name: 'nested',
      description: 'Runs a step on its own context.',
      input: z.object({}),
      output: z.string(),
      execute: async (_args, toolCtx) =>
        await toolCtx.harness.run(
          runCode({
            id: 'inner',
            execute: async () => 'inner-ok',
          }),
          undefined,
          toolCtx.ctx,
        ),
    });
    const log = newLog();
    let closesDuringTurn = -1;
    const ctx = new AgentHarness({
      name: 't',
      params: {},
    }).createContext();
    await execute(
      step.acpAgent({
        id: 'outer',
        agent: scriptedAgent(async (turn) => {
          await turn.call('nested');
          await turn.call('nested');
          closesDuringTurn = log.closes;
        }, log),
        prompt: 'go',
        tools: [
          nested,
        ],
      }),
      undefined,
      ctx,
    );
    expect(closesDuringTurn).toBe(0);
    expect(outputs(ctx.itemLog.items)).toEqual([
      'inner-ok',
      'inner-ok',
    ]);
  });
});

describe('ACP context layers, as on callModel', () => {
  it('puts the layers recall in front of the prompt and stores the turn', async () => {
    const stored: LLMResponseLike[] = [];
    type LLMResponseLike = {
      items: ReadonlyArray<Item>;
    };
    const notes = frameworkCast<ContextLayer>({
      id: 'notes',
      slot: 100,
      scope: 'thread',
      hooks: {
        async recall() {
          return {
            items: [
              createMessage('SECRET: pelican', 'developer'),
            ],
            tokenCount: 4,
          };
        },
        async store(params: { response: LLMResponseLike }) {
          stored.push(params.response);
          return null;
        },
      },
    });
    const log = newLog();
    const harness = new AgentHarness({
      name: 't',
      params: {},
      contextLayers: [
        notes,
      ],
    });
    await harness.run(
      step.acpAgent({
        id: 'layered',
        agent: scriptedAgent(async () => {}, log),
        prompt: 'what is the secret?',
        tools: [],
      }),
      undefined,
      harness.createContext(),
    );
    const [prompt] = log.prompts;
    assert(prompt);
    expect(prompt).toContain('<context>\nSECRET: pelican\n</context>');
    expect(prompt.indexOf('SECRET')).toBeLessThan(prompt.indexOf('what is the secret?'));
    expect(stored).toHaveLength(1);
  });
});
