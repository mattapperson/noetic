/**
 * The host features end to end: a `step.acpAgent` on the `claudeCode()`
 * preset, run by a harness, against an in-process agent over the real
 * JSON-RPC wire (spec 27 § Session settings, § Elicitation, § Subagents,
 * § What the session runs with).
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type * as acp from '@agentclientprotocol/sdk';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import { RequestError } from '@agentclientprotocol/sdk';
import { AgentHarness, execute, step } from '@noetic-tools/core';
import type { AgentScope, ContextData, HeldCall, HeldCallHandler } from '@noetic-tools/types';
import { isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import { claudeCode } from '../src/agents';
import { defineAcpAgent } from '../src/define';
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
  /** `session/new` rejects with this. */
  rejectNewSession?: unknown;
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
      if (script.rejectNewSession !== undefined) {
        throw script.rejectNewSession;
      }
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

function agent(log: AgentLog, script?: AgentScript, sessionMeta?: Record<string, unknown>) {
  return claudeCode({
    machine: loopbackMachine(agentFor(log, script)),
    ...(sessionMeta
      ? {
          sessionMeta,
        }
      : {}),
  });
}

interface Captured {
  type: string;
  data: Record<string, unknown>;
  scope?: AgentScope;
}

async function run(
  acpStep: ReturnType<typeof step.acpAgent<ContextData, unknown, string>>,
  onHeld?: HeldCallHandler,
): Promise<{
  output: string;
  events: Captured[];
}> {
  const harness = new AgentHarness({
    name: 'host-features',
    params: {},
    ...(onHeld
      ? {
          onHeld,
        }
      : {}),
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

describe('an agent step, as a host sees it', () => {
  it("sends instructions through claudeCode()'s extension and the adapter's sessionMeta", async () => {
    const log = emptyLog();
    await run(
      step.acpAgent<ContextData, unknown, string>({
        id: 'meta',
        agent: agent(log, undefined, {
          claudeCode: {
            options: {
              settingSources: [],
              strictMcpConfig: true,
            },
          },
        }),
        prompt: 'go',
        tools: [],
        instructions: () => 'Trusted host rules.',
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
        id: 'native',
        agent: agent(log, {
          capabilities: {
            sessionCapabilities: {
              systemPrompt: {},
            },
          },
        }),
        prompt: 'go',
        tools: [],
        instructions: 'Trusted host rules.',
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

  it("holds the agent's question for a person, like any held call", async () => {
    const log = emptyLog();
    const held: HeldCall[] = [];
    const { output, events } = await run(
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
                      enum: [
                        'a',
                        'b',
                      ],
                    },
                  },
                  required: [
                    'choice',
                  ],
                },
              }),
            );
          },
        }),
        prompt: 'go',
        tools: [],
      }),
      (call) => {
        held.push(call);
        return {
          output: {
            choice: 'b',
          },
        };
      },
    );
    expect(output).toBe('final answer');
    expect(log.initialize[0]?.clientCapabilities?.elicitation).toEqual({
      form: {},
    });
    expect(held).toHaveLength(1);
    expect(held[0]?.reason).toBe('question');
    expect(held[0]?.question?.message).toBe('Pick one');
    expect(log.elicited).toEqual([
      {
        action: 'accept',
        content: {
          choice: 'b',
        },
      },
    ]);
    // The host sees a held call and its settlement: nothing agent-specific.
    expect(events.some((e) => e.type === 'host-features:tool_call_held')).toBe(true);
    expect(events.some((e) => e.type === 'host-features:tool_call_settled')).toBe(true);
  });

  it("shows a subagent as a nested agent: its output scoped, never the step's", async () => {
    const log = emptyLog();
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
                description: 'Look around',
                state: {
                  state: 'running',
                },
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
            await conn.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: 'subagent_update',
                sessionId: 'child',
                state: {
                  state: 'idle',
                  stopReason: 'end_turn',
                },
              },
            });
          },
        }),
        prompt: 'go',
        tools: [],
      }),
    );
    expect(log.initialize[0]?.clientCapabilities?.subagents).toEqual({});
    expect(output).toBe('final answer');
    const scoped = events.filter((e) => e.scope !== undefined);
    const scope = scoped[0]?.scope;
    assert(scope);
    expect(scope.title).toBe('Explore');
    expect(scope.parentId).toBeUndefined();
    expect(scoped.every((e) => e.scope?.id === scope.id)).toBe(true);
    // The subagent's text is its own output...
    const childText = scoped
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => e.data.delta);
    expect(childText).toEqual([
      'SUBAGENT TEXT',
    ]);
    // ...and never the step's.
    const rootText = events
      .filter((e) => e.scope === undefined && e.type === 'response.output_text.delta')
      .map((e) => e.data.delta)
      .join('');
    expect(rootText).toBe('final answer');
    // Its life: started, its status, completed when the turn ends.
    const life = scoped
      .filter((e) => /:agent_(started|status|completed)$/.test(e.type))
      .map((e) => [
        e.type.split(':')[1],
        e.data.status ?? e.data.title,
      ]);
    expect(life).toEqual([
      [
        'agent_started',
        'Explore',
      ],
      [
        'agent_status',
        'running',
      ],
      [
        'agent_status',
        'idle',
      ],
      [
        'agent_completed',
        'completed',
      ],
    ]);
  });

  it("fails with a Noetic error carrying the agent's own message", async () => {
    const log = emptyLog();
    const error = await run(
      step.acpAgent<ContextData, unknown, string>({
        id: 'auth',
        agent: agent(log, {
          rejectNewSession: RequestError.authRequired(),
        }),
        prompt: 'go',
        tools: [],
      }),
    ).catch((e: unknown) => e);
    assert(isNoeticError(error));
    expect(error.noeticError.kind).toBe('step_failed');
    expect(String(error.message)).toContain('Authentication required');
  });

  it('an agent that cannot take instructions fails with AGENT_CAPABILITY_MISSING', async () => {
    const error = await run(
      step.acpAgent<ContextData, unknown, string>({
        id: 'no-instructions',
        agent: defineAcpAgent({
          agentId: 'plain',
          command: {
            command: 'plain',
          },
          machine: loopbackMachine(agentFor(emptyLog())),
        }),
        prompt: 'go',
        tools: [],
        instructions: 'rules',
      }),
    ).catch((e: unknown) => e);
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('AGENT_CAPABILITY_MISSING');
  });
});
