/**
 * An agent's machine carries the tool bridge to the agent: the address it
 * reaches is the one the launch settings and `session/new` name, and the
 * machine is released with the connection.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { AgentHarness, execute, step, tool } from '@noetic-tools/core';
import type { AcpAgent, AcpMachine, AcpMachineFactory, SpawnCommand } from '@noetic-tools/types';
import { isNoeticConfigError } from '@noetic-tools/types';
import type * as acp from '@zed-industries/agent-client-protocol';
import { z } from 'zod';
import { gemini } from '../src/agents';
import { defineAcpAgent } from '../src/define';
import { localMachine } from '../src/stdio';
import { claudeToolWiring, codexToolWiring } from '../src/tool-wiring';
import { loopbackMachine } from '../src/transport-loopback';

const echo = tool({
  name: 'echo',
  description: 'Echo the text.',
  input: z.object({
    text: z.string(),
  }),
  output: z.string(),
  execute: async ({ text }) => text,
});

interface Seen {
  commands: SpawnCommand[];
  servers: acp.McpServer[];
  reached: string[];
  closed: number;
}

function seen(): Seen {
  return {
    commands: [],
    servers: [],
    reached: [],
    closed: 0,
  };
}

function quietAgent(
  log: Seen,
): (conn: acp.AgentSideConnection, command: SpawnCommand) => acp.Agent {
  return (_conn, command) => {
    log.commands.push(command);
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
        log.servers.push(...params.mcpServers);
        return {
          sessionId: 's-1',
        };
      },
      async authenticate() {},
      async cancel() {},
      async prompt() {
        return {
          stopReason: 'end_turn',
        };
      },
    };
  };
}

/** A loopback machine whose `reach` marks the address, as a remote one rewrites it. */
function markingMachine(log: Seen, fail = false): AcpMachineFactory {
  const inner = loopbackMachine(quietAgent(log));
  return async (opts): Promise<AcpMachine> => {
    const machine = await inner(opts);
    return {
      ...machine,
      async reach(bridge) {
        if (fail) {
          throw new Error('no route to the bridge');
        }
        const url = `${bridge.url}?via=machine`;
        log.reached.push(url);
        return {
          ...bridge,
          url,
        };
      },
      async close() {
        log.closed += 1;
        await machine.close();
      },
    };
  };
}

async function runWithTools(machine: AcpMachineFactory, wiring = claudeToolWiring): Promise<void> {
  await runAgent(
    defineAcpAgent({
      agentId: 'remote',
      command: {
        command: 'agent-acp',
        args: [
          '--acp',
        ],
      },
      machine,
      tools: wiring,
    }),
  );
}

async function runAgent(agent: AcpAgent): Promise<void> {
  const ctx = new AgentHarness({
    name: 'machine',
    params: {},
  }).createContext();
  await execute(
    step.acpAgent({
      id: 'remote',
      agent,
      prompt: 'go',
      tools: [
        echo,
      ],
    }),
    undefined,
    ctx,
  );
}

describe('AcpMachine', () => {
  it('names the reached address in session/new and launches the command there', async () => {
    const log = seen();
    await runWithTools(markingMachine(log));
    expect(log.reached).toHaveLength(1);
    const server = log.servers.find((s) => s.name === 'noetic');
    assert(server && 'type' in server && server.type === 'http');
    expect(server.url).toBe(log.reached[0]);
    expect(server.headers[0]?.value).toStartWith('Bearer ');
    const command = log.commands[0];
    assert(command);
    expect(command.command).toBe('agent-acp');
    expect(command.args).toEqual([
      '--acp',
    ]);
    expect(command.env?.MAX_MCP_OUTPUT_TOKENS).toBeDefined();
    expect(log.closed).toBe(1);
  });

  it('gives launch settings the reached address', async () => {
    const log = seen();
    await runWithTools(markingMachine(log), codexToolWiring);
    const config = log.commands[0]?.env?.CODEX_CONFIG;
    assert(config);
    expect(config).toContain('?via=machine');
    expect(log.servers).toHaveLength(0);
  });

  it('trusts the Gemini workspace only when asked, and refuses tools without it', async () => {
    const untrusted = seen();
    const refusal = await runAgent(
      gemini({
        machine: markingMachine(untrusted),
      }),
    ).catch((e: unknown) => e);
    assert(isNoeticConfigError(refusal));
    expect(refusal.code).toBe('ACP_AGENT_CANNOT_TAKE_TOOLS');
    expect(untrusted.commands).toHaveLength(0);
    const trusted = seen();
    await runAgent(
      gemini({
        machine: markingMachine(trusted),
        trustWorkspace: true,
      }),
    );
    expect(trusted.commands[0]?.env?.GEMINI_CLI_TRUST_WORKSPACE).toBe('true');
    expect(trusted.servers.map((server) => server.name)).toContain('noetic');
  });

  it('releases the machine and the bridge when reach fails', async () => {
    const log = seen();
    const failure = await runWithTools(markingMachine(log, true)).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('no route to the bridge');
    expect(log.commands).toHaveLength(0);
    expect(log.closed).toBe(1);
  });

  it('a loopback machine runs no processes', async () => {
    const machine = await loopbackMachine(quietAgent(seen()))({});
    const failure = await machine
      .spawn({
        command: 'docs-mcp',
      })
      .catch((e: unknown) => e);
    expect(String(failure)).toContain('docs-mcp');
  });
});

describe('localMachine', () => {
  it('reaches the bridge where it listens', async () => {
    const machine = await localMachine()({});
    const bridge = {
      serverName: 'noetic',
      url: 'http://127.0.0.1:9/mcp/x',
      headers: [],
    };
    expect(await machine.reach(bridge)).toBe(bridge);
    await machine.close();
  });

  it('spawns a process beside the agent and carries its stdio', async () => {
    const machine = await localMachine()({});
    const process = await machine.spawn({
      command: 'cat',
    });
    const writer = process.writable.getWriter();
    await writer.write(new TextEncoder().encode('ping\n'));
    const reader = process.readable.getReader();
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toBe('ping\n');
    reader.releaseLock();
    writer.releaseLock();
    await machine.close();
  });
});

describe('AcpAgent.spawn', () => {
  it("starts a process on the agent's own machine, and none for an attached agent", async () => {
    const spawned: SpawnCommand[] = [];
    const agent = defineAcpAgent({
      agentId: 'spawning',
      command: {
        command: 'agent',
      },
      machine: async (opts) => {
        const machine = await localMachine()(opts);
        return {
          ...machine,
          spawn: async (command) => {
            spawned.push(command);
            return await machine.spawn(command);
          },
        };
      },
    });
    assert(agent.spawn);
    const process = await agent.spawn({
      command: 'cat',
    });
    const writer = process.writable.getWriter();
    await writer.write(new TextEncoder().encode('pong\n'));
    const reader = process.readable.getReader();
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toBe('pong\n');
    reader.releaseLock();
    writer.releaseLock();
    await process.close();
    expect(spawned).toEqual([
      {
        command: 'cat',
      },
    ]);

    const attached = defineAcpAgent({
      agentId: 'attached',
      transport: async () => {
        throw new Error('not opened');
      },
    });
    expect(attached.spawn).toBeUndefined();
  });
});
