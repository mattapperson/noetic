/**
 * Connections served to an ACP agent through the tool bridge (spec 27 § Tools):
 * entries and picks an `acpAgent` step lists connect at turn start and reach
 * the agent by their harness names; with no `tools` the agent gets the whole
 * set; a pick by name reaches a harness connection, and one naming no
 * connection fails before the agent starts; and a session kept past its step
 * holds the turn's connections until it closes.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ConnectionProvider } from '@noetic-tools/types';
import { isNoeticConfigError } from '@noetic-tools/types';
import { step } from '../../src/builders/step-builders';
import { createInMemoryConnection } from '../../src/connections/in-memory-connection';
import { connectionTools } from '../../src/connections/model-tools';
import { AgentHarness } from '../../src/harness/agent-harness';
import type { AgentRun } from '../_helpers';
import { newRun, toolCallingAgent } from '../_helpers';

//#region Fixtures

/** A named in-memory phone with two operations, counting releases of its connection. */
function phone(name = 'phone'): {
  readonly provider: ConnectionProvider;
  readonly released: () => number;
} {
  let released = 0;
  const inner = createInMemoryConnection({
    name,
    operations: {
      ping: {
        inputSchema: {
          type: 'object',
        },
        run: () => 'pong',
      },
      reboot: {
        inputSchema: {
          type: 'object',
        },
        run: () => 'rebooted',
      },
    },
  });
  return {
    released: () => released,
    provider: {
      name,
      connect: async (opts) =>
        (await inner.connect(opts)).map((connection) =>
          Object.assign(Object.create(connection), {
            release: async () => {
              released += 1;
              await connection.release();
            },
          }),
        ),
    },
  };
}

function served(run: AgentRun): string[] {
  return (run.host?.tools?.tools ?? []).map((tool) => tool.name);
}

//#endregion

describe('ACP connection tools', () => {
  it('serves a step entry by its harness names, and runs the call through it', async () => {
    const run = newRun();
    const { provider } = phone();
    const harness = new AgentHarness({
      name: 't',
      params: {},
    });
    const ctx = harness.createContext();
    await harness.run(
      step.acpAgent({
        id: 'agent',
        agent: toolCallingAgent(
          [
            {
              name: 'phone_ping',
              args: {},
              agentCallId: 'call_1',
            },
          ],
          run,
        ),
        prompt: 'go',
        tools: [
          provider,
        ],
      }),
      undefined,
      ctx,
    );
    expect(served(run)).toEqual([
      'phone_ping',
      'phone_reboot',
    ]);
    expect(run.results).toEqual([
      {
        output: 'pong',
        isError: false,
      },
    ]);
    expect(ctx.itemLog.items.some((item) => item.type === 'function_call_output')).toBe(true);
  });

  it('serves a pick as the harness names of the ops it matches', async () => {
    const run = newRun();
    const { provider } = phone();
    const harness = new AgentHarness({
      name: 't',
      params: {},
    });
    await harness.run(
      step.acpAgent({
        id: 'agent',
        agent: toolCallingAgent([], run),
        prompt: 'go',
        tools: [
          connectionTools(provider, {
            ops: [
              'ping',
            ],
          }),
        ],
      }),
      undefined,
      harness.createContext(),
    );
    expect(served(run)).toEqual([
      'phone_ping',
    ]);
  });

  it('with no tools, serves the whole set, connection tools included', async () => {
    const run = newRun();
    const { provider } = phone();
    const harness = new AgentHarness({
      name: 't',
      params: {},
      connections: [
        provider,
      ],
    });
    await harness.run(
      step.acpAgent({
        id: 'agent',
        agent: toolCallingAgent([], run),
        prompt: 'go',
      }),
      undefined,
      harness.createContext(),
    );
    expect(served(run)).toEqual([
      'phone_ping',
      'phone_reboot',
    ]);
  });

  it('serves a merged tool cut to the picked connection, and refuses any other target', async () => {
    const run = newRun();
    const harness = new AgentHarness({
      name: 't',
      params: {},
      connections: {
        a: {
          provider: phone('a').provider,
          expose: 'call',
        },
        secretdb: {
          provider: phone('secretdb').provider,
          expose: 'call',
        },
      },
    });
    await harness.run(
      step.acpAgent({
        id: 'agent',
        agent: toolCallingAgent(
          [
            {
              name: 'call',
              args: {
                target: 'secretdb',
                op: 'reboot',
              },
              agentCallId: 'call_1',
            },
            {
              name: 'call',
              args: {
                target: 'a',
                op: 'ping',
              },
              agentCallId: 'call_2',
            },
          ],
          run,
        ),
        prompt: 'go',
        tools: [
          connectionTools('a'),
        ],
      }),
      undefined,
      harness.createContext(),
    );
    expect(served(run)).toEqual([
      'ops',
      'call',
    ]);
    const call = run.host?.tools?.tools.find((tool) => tool.name === 'call');
    expect(call?.inputSchema).toMatchObject({
      properties: {
        target: {
          enum: [
            'a',
          ],
        },
      },
    });
    expect(run.results[0]?.isError).toBe(true);
    expect(run.results[0]?.output).not.toContain('rebooted');
    expect(run.results[1]).toEqual({
      output: 'pong',
      isError: false,
    });
  });

  it('serves a pick by name of a harness connection', async () => {
    const run = newRun();
    const { provider } = phone();
    const harness = new AgentHarness({
      name: 't',
      params: {},
      connections: [
        provider,
      ],
    });
    await harness.run(
      step.acpAgent({
        id: 'agent',
        agent: toolCallingAgent([], run),
        prompt: 'go',
        tools: [
          connectionTools('phone', {
            ops: [
              'ping',
            ],
          }),
        ],
      }),
      undefined,
      harness.createContext(),
    );
    expect(served(run)).toEqual([
      'phone_ping',
    ]);
  });

  it('refuses a pick naming no connection with CONNECTION_UNKNOWN before the agent starts', async () => {
    const run = newRun();
    const harness = new AgentHarness({
      name: 't',
      params: {},
    });
    const failure = await harness
      .run(
        step.acpAgent({
          id: 'agent',
          agent: toolCallingAgent([], run),
          prompt: 'go',
          tools: [
            connectionTools('docs'),
          ],
        }),
        undefined,
        harness.createContext(),
      )
      .catch((e: unknown) => e);
    assert(isNoeticConfigError(failure));
    expect(failure.code).toBe('CONNECTION_UNKNOWN');
    expect(failure.message).toContain("'docs'");
    expect(run.host).toBeUndefined();
  });

  it('a keepAlive session holds its step entries past the run, and releases them when it closes', async () => {
    const run = newRun();
    const { provider, released } = phone();
    const harness = new AgentHarness({
      name: 't',
      params: {},
    });
    await harness.run(
      step.acpAgent({
        id: 'agent',
        agent: toolCallingAgent([], run),
        prompt: 'go',
        tools: [
          provider,
        ],
        session: {
          keepAlive: 'harness',
        },
      }),
      undefined,
      harness.createContext(),
    );
    expect(served(run)).toEqual([
      'phone_ping',
      'phone_reboot',
    ]);
    expect(released()).toBe(0);
    await harness.closeAcpSessions();
    await Promise.resolve();
    expect(released()).toBe(1);
  });

  it('a step-scoped session releases its step entries with the run', async () => {
    const run = newRun();
    const { provider, released } = phone();
    const harness = new AgentHarness({
      name: 't',
      params: {},
    });
    await harness.run(
      step.acpAgent({
        id: 'agent',
        agent: toolCallingAgent([], run),
        prompt: 'go',
        tools: [
          provider,
        ],
      }),
      undefined,
      harness.createContext(),
    );
    expect(released()).toBe(1);
  });
});
