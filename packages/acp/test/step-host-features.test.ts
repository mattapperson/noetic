/**
 * The host features end to end: a `step.acpAgent` on the `claudeCode()`
 * preset, run by a harness, against an in-process agent over the real
 * JSON-RPC wire (spec 27 § Session settings, § Elicitation, § Subagents,
 * § What the session runs with).
 */

import { describe, expect, it } from 'bun:test';
import type * as acp from '@agentclientprotocol/sdk';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import { AgentHarness, execute, step } from '@noetic-tools/core';
import type { AcpSubagentEvent, ContextData } from '@noetic-tools/types';
import { isNoeticConfigError } from '@noetic-tools/types';
import { claudeCode } from '../src/agents';
import { loopbackMachine } from '../src/transport-loopback';

//#region Agent

interface AgentLog {
  initialize: acp.InitializeRequest[];
  newSession: acp.NewSessionRequest[];
  elicited: acp.CreateElicitationResponse[];
}

interface AgentScript {
  capabilities?: acp.AgentCapabilities;
  /** Run during the prompt turn, before the answer. */
  turn?: (conn: AgentSideConnection, sessionId: string) => Promise<void>;
}

function agentFor(log: AgentLog, script: AgentScript = {}) {
  return (conn: AgentSideConnection): acp.Agent => ({
    async initialize(params) {
      log.initialize.push(params);
      return {
        protocolVersion: params.protocolVersion,
        agentCapabilities: script.capabilities ?? {},
      };
    },
    async newSession(params) {
      log.newSession.push(params);
      return {
        sessionId: 'primary',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            category: 'model',
            currentValue: 'opus',
            options: [
              {
                value: 'opus',
                name: 'Opus',
              },
            ],
          },
        ],
      };
    },
    async authenticate() {
      return {};
    },
    async prompt(params) {
      await script.turn?.(conn, params.sessionId);
      await conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'final answer',
          },
        },
      });
      return {
        stopReason: 'end_turn',
        usage: {
          inputTokens: 7,
          outputTokens: 2,
          totalTokens: 9,
        },
        _meta: {
          quota: {
            token_count: {
              inputTokens: 7,
              outputTokens: 2,
            },
          },
        },
      };
    },
    async cancel() {
      return;
    },
  });
}

function emptyLog(): AgentLog {
  return {
    initialize: [],
    newSession: [],
    elicited: [],
  };
}

function agent(log: AgentLog, script?: AgentScript) {
  return claudeCode({
    machine: loopbackMachine(agentFor(log, script)),
  });
}

interface Captured {
  type: string;
  data: Record<string, unknown>;
}

async function run(
  acpStep: ReturnType<typeof step.acpAgent<ContextData, unknown, string>>,
): Promise<{
  output: string;
  events: Captured[];
}> {
  const harness = new AgentHarness({
    name: 'host-features',
    params: {},
  });
  const ctx = harness.createContext();
  const events: Captured[] = [];
  Reflect.set(ctx, '_broadcaster', {
    emit(event: Captured) {
      events.push(event);
    },
  });
  const output = await execute(acpStep, undefined, ctx);
  return {
    output,
    events,
  };
}

//#endregion

describe('step.acpAgent host features', () => {
  it('sends sessionMeta and the system prompt (claude fallback) on session/new', async () => {
    const log = emptyLog();
    await run(
      step.acpAgent<ContextData, unknown, string>({
        id: 'meta',
        agent: agent(log),
        prompt: 'go',
        tools: [],
        sessionMeta: (): Record<string, unknown> => ({
          claudeCode: {
            options: {
              settingSources: [],
              strictMcpConfig: true,
            },
          },
        }),
        systemPrompt: 'Trusted host rules.',
      }),
    );
    expect(log.newSession[0]?._meta).toEqual({
      systemPrompt: {
        append: 'Trusted host rules.',
      },
      claudeCode: {
        options: {
          settingSources: [],
          strictMcpConfig: true,
        },
      },
    });
    expect(log.newSession[0]?.systemPrompt).toBeUndefined();
  });

  it('sends the protocol systemPrompt to an agent that advertises it', async () => {
    const log = emptyLog();
    await run(
      step.acpAgent<ContextData, unknown, string>({
        id: 'native-prompt',
        agent: agent(log, {
          capabilities: {
            sessionCapabilities: {
              systemPrompt: {},
            },
          },
        }),
        prompt: 'go',
        tools: [],
        systemPrompt: {
          text: 'Trusted host rules.',
        },
      }),
    );
    expect(log.newSession[0]?.systemPrompt).toEqual({
      mode: 'append',
      content: [
        {
          type: 'text',
          text: 'Trusted host rules.',
        },
      ],
    });
    expect(log.newSession[0]?._meta).toBeUndefined();
  });

  it('answers elicitations through onElicitation, with the step context', async () => {
    const log = emptyLog();
    const asked: Array<{
      message: string;
      stepId: string;
      hasCtx: boolean;
    }> = [];
    await run(
      step.acpAgent<ContextData, unknown, string>({
        id: 'ask',
        agent: agent(log, {
          turn: async (conn, sessionId) => {
            log.elicited.push(
              await conn.createElicitation({
                mode: 'form',
                sessionId,
                message: 'Pick one',
                requestedSchema: {
                  type: 'object',
                  properties: {
                    choice: {
                      type: 'string',
                    },
                  },
                },
              }),
            );
          },
        }),
        prompt: 'go',
        tools: [],
        onElicitation: async (request, ctx, info) => {
          asked.push({
            message: request.message,
            stepId: info.stepId,
            hasCtx: typeof ctx.threadId === 'string',
          });
          return {
            action: 'accept',
            content: {
              choice: 'b',
            },
          };
        },
      }),
    );
    expect(log.initialize[0]?.clientCapabilities?.elicitation).toEqual({
      form: {},
    });
    expect(asked).toEqual([
      {
        message: 'Pick one',
        stepId: 'ask',
        hasCtx: true,
      },
    ]);
    expect(log.elicited).toEqual([
      {
        action: 'accept',
        content: {
          choice: 'b',
        },
      },
    ]);
  });

  it("routes a subagent's updates to onSubagentUpdate and keeps them out of the output", async () => {
    const log = emptyLog();
    const seen: AcpSubagentEvent[] = [];
    const { output, events } = await run(
      step.acpAgent<ContextData, unknown, string>({
        id: 'sub',
        agent: agent(log, {
          turn: async (conn, sessionId) => {
            await conn.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: 'subagent_update',
                sessionId: 'child',
                title: 'Explore',
              },
            });
            await conn.sessionUpdate({
              sessionId: 'child',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: 'SUBAGENT TEXT',
                },
              },
            });
          },
        }),
        prompt: 'go',
        tools: [],
        onSubagentUpdate: (event) => {
          seen.push(event);
        },
      }),
    );
    expect(log.initialize[0]?.clientCapabilities?.subagents).toEqual({});
    expect(output).toBe('final answer');
    expect(
      seen.map((e) => [
        e.sessionId,
        e.update.sessionUpdate,
      ]),
    ).toEqual([
      [
        'child',
        'subagent_update',
      ],
      [
        'child',
        'agent_message_chunk',
      ],
    ]);
    expect(JSON.stringify(events)).not.toContain('SUBAGENT TEXT');
  });

  it('puts the config options, reported usage and response _meta on response.completed', async () => {
    const log = emptyLog();
    const { events } = await run(
      step.acpAgent<ContextData, unknown, string>({
        id: 'usage',
        agent: agent(log),
        prompt: 'go',
        tools: [],
      }),
    );
    const completed = events.find((e) => e.type === 'response.completed');
    expect(completed?.data.reportedUsage).toEqual({
      inputTokens: 7,
      outputTokens: 2,
      totalTokens: 9,
    });
    expect(completed?.data.responseMeta).toEqual({
      quota: {
        token_count: {
          inputTokens: 7,
          outputTokens: 2,
        },
      },
    });
    expect(JSON.stringify(completed?.data.configOptions)).toContain('"currentValue":"opus"');
  });

  it('a step reusing a session with a different system prompt fails as a conflict', async () => {
    const log = emptyLog();
    const harness = new AgentHarness({
      name: 'reuse',
      params: {},
    });
    const ctx = harness.createContext();
    const shared = agent(log);
    const first = step.acpAgent<ContextData, unknown, string>({
      id: 'first',
      agent: shared,
      prompt: 'go',
      tools: [],
      systemPrompt: 'A',
      session: {
        reuse: 'k',
        keepAlive: 'run',
      },
    });
    const second = step.acpAgent<ContextData, unknown, string>({
      id: 'second',
      agent: shared,
      prompt: 'go',
      tools: [],
      systemPrompt: 'B',
      session: {
        reuse: 'k',
        keepAlive: 'run',
      },
    });
    await execute(first, undefined, ctx);
    const error = await execute(second, undefined, ctx).catch((e: unknown) => e);
    await harness.closeAcpSessions();
    if (!isNoeticConfigError(error)) {
      throw new Error(`expected a config error, got ${String(error)}`);
    }
    expect(error.code).toBe('ACP_SESSION_SETTING_CONFLICT');
    expect(error.message).toContain('systemPrompt');
  });
});
