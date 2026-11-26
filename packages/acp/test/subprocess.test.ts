/**
 * An agent's subprocess adapter carries the tool bridge to the agent: the
 * address its link reaches is the one the launch settings and `session/new`
 * name, and the link closes with the connection.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type * as acp from '@agentclientprotocol/sdk';
import { AgentHarness, execute, step, tool } from '@noetic-tools/core';
import type { AcpAgent, SpawnCommand, SubprocessAdapter } from '@noetic-tools/types';
import { isNoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';
import { agentSubprocess } from '../src/agent-subprocess';
import { gemini } from '../src/agents';
import { defineAcpAgent } from '../src/define';
import { localSubprocess } from '../src/stdio';
import { claudeToolWiring, codexToolWiring } from '../src/tool-wiring';
import { loopbackSubprocess } from '../src/transport-loopback';

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

/** A loopback adapter whose `reach` marks the address, as a remote one rewrites it. */
function marking(log: Seen, fail = false): SubprocessAdapter {
  const inner = loopbackSubprocess(quietAgent(log));
  return agentSubprocess('marking', async (opts) => {
    const link = await inner.open(opts);
    return {
      ...link,
      async reach(bridge) {
        if (fail) {
          throw new Error('no route to the bridge');
        }
        const url = `${bridge.url}?via=link`;
        log.reached.push(url);
        return {
          ...bridge,
          url,
        };
      },
      async close() {
        log.closed += 1;
        await link.close();
      },
    };
  });
}

async function runWithTools(
  subprocess: SubprocessAdapter,
  wiring = claudeToolWiring,
): Promise<void> {
  await runAgent(
    defineAcpAgent({
      agentId: 'remote',
      command: {
        command: 'agent-acp',
        args: [
          '--acp',
        ],
      },
      subprocess,
      tools: wiring,
    }),
  );
}

async function runAgent(agent: AcpAgent): Promise<void> {
  const ctx = new AgentHarness({
    name: 'subprocess',
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

describe('an agent subprocess adapter', () => {
  it('names the reached address in session/new and launches the command there', async () => {
    const log = seen();
    await runWithTools(marking(log));
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
    await runWithTools(marking(log), codexToolWiring);
    const config = log.commands[0]?.env?.CODEX_CONFIG;
    assert(config);
    expect(config).toContain('?via=link');
    expect(log.servers).toHaveLength(0);
  });

  it('trusts the Gemini workspace only when asked, and refuses tools without it', async () => {
    const untrusted = seen();
    const refusal = await runAgent(
      gemini({
        subprocess: marking(untrusted),
      }),
    ).catch((e: unknown) => e);
    assert(isNoeticConfigError(refusal));
    expect(refusal.code).toBe('ACP_AGENT_CANNOT_TAKE_TOOLS');
    expect(untrusted.commands).toHaveLength(0);
    const trusted = seen();
    await runAgent(
      gemini({
        subprocess: marking(trusted),
        trustWorkspace: true,
      }),
    );
    expect(trusted.commands[0]?.env?.GEMINI_CLI_TRUST_WORKSPACE).toBe('true');
    expect(trusted.servers.map((server) => server.name)).toContain('noetic');
  });

  it('closes the link and the bridge when reach fails', async () => {
    const log = seen();
    const failure = await runWithTools(marking(log, true)).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('no route to the bridge');
    expect(log.commands).toHaveLength(0);
    expect(log.closed).toBe(1);
  });

  it('loopbackSubprocess() runs no processes', async () => {
    const link = await loopbackSubprocess(quietAgent(seen())).open({});
    const failure = await link
      .spawn({
        command: 'docs-mcp',
      })
      .catch((e: unknown) => e);
    expect(String(failure)).toContain('docs-mcp');
  });

  it('refuses a step subprocess and holds no handles', async () => {
    const adapter = localSubprocess();
    const refusal = await adapter
      .spawn({
        command: 'true',
      })
      .catch((e: unknown) => e);
    assert(isNoeticConfigError(refusal));
    expect(refusal.code).toBe('ACP_SUBPROCESS_RUNS_NO_STEPS');
    expect(refusal.message).toContain('runs no step subprocesses');
    expect(await adapter.get('h-1')).toBeNull();
    expect(await adapter.reattach('h-1')).toBeNull();
    expect(await adapter.listLive()).toEqual([]);
    expect(await adapter.stop('h-1')).toEqual({
      kind: 'not_found',
      handleId: 'h-1',
    });
    expect(await adapter.pause('h-1')).toEqual({
      kind: 'not_found',
      handleId: 'h-1',
    });
  });

  it('refuses an agent whose adapter has no open', async () => {
    const { open: _open, ...closed } = localSubprocess();
    const refusal = await runWithTools(closed).catch((e: unknown) => e);
    assert(isNoeticConfigError(refusal));
    expect(refusal.code).toBe('ACP_SUBPROCESS_CANNOT_OPEN');
  });
});

describe('localSubprocess', () => {
  it('without a keeper, reaches the bridge where it listens', async () => {
    const link = await localSubprocess('local', {
      keeper: false,
    }).open({});
    const bridge = {
      serverName: 'noetic',
      url: 'http://127.0.0.1:9/mcp/x',
      headers: [],
    };
    expect(await link.reach(bridge)).toBe(bridge);
    await link.close();
  });

  it("with its keeper, reaches the bridge on the keeper's own port, same path and headers", async () => {
    const link = await localSubprocess().open({});
    const bridge = {
      serverName: 'noetic',
      url: 'http://127.0.0.1:9/mcp/x',
      headers: [
        {
          name: 'Authorization',
          value: 'Bearer t',
        },
      ],
    };
    const reached = await link.reach(bridge);
    const url = new URL(reached.url);
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).not.toBe('9');
    expect(url.pathname).toBe('/mcp/x');
    expect(reached.headers).toEqual(bridge.headers);
    await link.close();
  });

  it('spawns a process beside the agent and carries its stdio', async () => {
    const link = await localSubprocess().open({});
    const process = await link.spawn({
      command: 'cat',
    });
    const writer = process.writable.getWriter();
    await writer.write(new TextEncoder().encode('ping\n'));
    const reader = process.readable.getReader();
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toBe('ping\n');
    reader.releaseLock();
    writer.releaseLock();
    await link.close();
  });
});

describe('AcpAgent.spawn', () => {
  it("starts a process through the agent's own adapter, and none for an attached agent", async () => {
    const spawned: SpawnCommand[] = [];
    const agent = defineAcpAgent({
      agentId: 'spawning',
      command: {
        command: 'agent',
      },
      subprocess: agentSubprocess('recording', async (opts) => {
        const link = await localSubprocess().open(opts);
        return {
          ...link,
          spawn: async (command) => {
            spawned.push(command);
            return await link.spawn(command);
          },
        };
      }),
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
