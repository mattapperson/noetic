/**
 * `localMachine({ wrap, onStderr })`: a host starts the agent from its own
 * argv (a sandbox wrapper) with exactly its own environment, and reads the
 * agent's stderr — through a keeper or without one (spec 27 § A wrapped
 * launch). Real processes, no mocks.
 */

import { describe, expect, it } from 'bun:test';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnCommand, ToolBridgeAddress } from '@noetic-tools/types';
import type { LocalAgentCommand, LocalWrapInfo } from '../src/stdio';
import { localMachine } from '../src/stdio';

const FIXTURE = join(import.meta.dir, 'fixtures', 'wrapped-agent.ts');

interface Report {
  args: string[];
  cwd: string;
  env: string[];
  only?: string;
}

function reportOf(stderr: string): Report {
  const line = stderr.split('\n').find((l) => l.startsWith('{'));
  if (!line) {
    throw new Error(`no report in stderr: ${stderr}`);
  }
  return JSON.parse(line);
}

const PING = '{"jsonrpc":"2.0","method":"ping/echo","params":{}}';

/** Write `line` and read until a full line comes back. */
async function echo(
  transport: {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  },
  line: string,
): Promise<string> {
  const writer = transport.writable.getWriter();
  await writer.write(new TextEncoder().encode(`${line}\n`));
  writer.releaseLock();
  const reader = transport.readable.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('\n')) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    text += decoder.decode(chunk.value, {
      stream: true,
    });
  }
  reader.releaseLock();
  return text;
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting');
}

describe.each([
  [
    'without a keeper',
    false,
  ],
  [
    'through its keeper',
    true,
  ],
])('localMachine wrap, %s', (_label, keeper) => {
  it('runs the wrapped argv with exactly its env and cwd, and hands stderr to the host', async () => {
    let stderr = '';
    const seen: Array<{
      command: LocalAgentCommand;
      info: LocalWrapInfo;
    }> = [];
    const cwd = realpathSync(tmpdir());
    const machine = await localMachine('wrapped', {
      keeper,
      onStderr: (chunk) => {
        stderr += chunk;
      },
      wrap: (command, info): SpawnCommand => {
        seen.push({
          command,
          info,
        });
        return {
          command: process.execPath,
          args: [
            FIXTURE,
            'sandboxed',
            command.command,
            ...(command.args ?? []),
          ],
          env: {
            WRAP_ONLY: command.env.PRESET_FLAG ?? 'missing',
            PATH: command.env.PATH ?? '',
          },
          cwd,
        };
      },
    })({});
    const bridge: ToolBridgeAddress = {
      serverName: 'noetic',
      url: 'http://127.0.0.1:9/mcp/x',
      headers: [],
    };
    const reached = await machine.reach(bridge);
    const transport = await machine.launch({
      command: 'claude-agent-acp',
      args: [
        '--flag',
      ],
      env: {
        PRESET_FLAG: 'on',
      },
    });

    // The wrapper saw the complete environment and the address it handed out.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.command.env.PRESET_FLAG).toBe('on');
    expect(seen[0]?.command.env.PATH).toBe(process.env.PATH ?? '');
    expect(seen[0]?.info.bridges).toEqual([
      reached,
    ]);
    // And what the agent sets apart, without this process's environment.
    expect(seen[0]?.info.agentEnv).toEqual({
      PRESET_FLAG: 'on',
    });

    await waitFor(() => stderr.includes('\n'));
    const report = reportOf(stderr);
    expect(report.args).toEqual([
      'sandboxed',
      'claude-agent-acp',
      '--flag',
    ]);
    expect(report.only).toBe('on');
    expect(report.cwd).toBe(cwd);
    // Nothing of this process's environment came back in.
    expect(report.env.includes('HOME')).toBe(false);

    // And it is the agent's stream: an ACP line goes there and back.
    expect(await echo(transport, PING)).toContain(PING);
    await machine.close();
  });
});

describe('localMachine without wrap', () => {
  it('runs the command as given, on the complete environment', async () => {
    let stderr = '';
    const machine = await localMachine('plain', {
      keeper: false,
      onStderr: (chunk) => {
        stderr += chunk;
      },
    })({});
    const transport = await machine.launch({
      command: process.execPath,
      args: [
        FIXTURE,
      ],
      env: {
        WRAP_ONLY: 'given',
      },
    });
    await waitFor(() => stderr.includes('\n'));
    const report = reportOf(stderr);
    expect(report.only).toBe('given');
    expect(report.env.includes('PATH')).toBe(true);
    await transport.close();
    await machine.close();
  });
});

describe('localMachine onLaunch', () => {
  it('reports the agent it starts itself, and its exit once it is stopped', async () => {
    const spawned: Array<{
      pid: number;
      exited: Promise<void>;
    }> = [];
    const machine = await localMachine('tracked', {
      keeper: false,
      onStderr: () => undefined,
      onLaunch: (agent) => {
        spawned.push(agent);
      },
    })({});
    const transport = await machine.launch({
      command: process.execPath,
      args: [
        FIXTURE,
      ],
    });
    expect(spawned).toHaveLength(1);
    const agent = spawned[0];
    if (!agent) {
      throw new Error('no agent reported');
    }
    // The process is alive until the transport stops it.
    expect(() => process.kill(agent.pid, 0)).not.toThrow();
    await transport.close();
    await agent.exited;
    expect(() => process.kill(agent.pid, 0)).toThrow();

    // An MCP server beside it is not the agent.
    const server = await machine.spawn({
      command: process.execPath,
      args: [
        FIXTURE,
      ],
    });
    expect(spawned).toHaveLength(1);
    await server.close();
    await machine.close();
  });

  it("reports nothing for a kept agent, which is its keeper's child", async () => {
    const spawned: number[] = [];
    const machine = await localMachine('kept', {
      onStderr: () => undefined,
      onLaunch: (agent) => {
        spawned.push(agent.pid);
      },
    })({});
    const transport = await machine.launch({
      command: process.execPath,
      args: [
        FIXTURE,
      ],
    });
    expect(await echo(transport, PING)).toContain(PING);
    expect(spawned).toEqual([]);
    await machine.close();
  });
});

describe('localMachine onLaunch that throws', () => {
  it('treats a rejected promise as a throw', async () => {
    let pid: number | undefined;
    const machine = await localMachine('rejects', {
      keeper: false,
      onStderr: () => undefined,
      onLaunch: async (agent) => {
        pid = agent.pid;
        await Promise.resolve();
        throw new Error('registry is down');
      },
    })({});
    await expect(
      machine.launch({
        command: process.execPath,
        args: [
          FIXTURE,
        ],
      }),
    ).rejects.toThrow('onLaunch');
    expect(() => process.kill(pid ?? 0, 0)).toThrow();
    await machine.close();
  });

  it('stops the agent and fails the launch, leaving nothing running', async () => {
    let pid: number | undefined;
    const machine = await localMachine('throws', {
      keeper: false,
      onStderr: () => undefined,
      onLaunch: (agent) => {
        pid = agent.pid;
        throw new Error('registry is full');
      },
    })({});
    const launching = machine.launch({
      command: process.execPath,
      args: [
        FIXTURE,
      ],
    });
    await expect(launching).rejects.toThrow('onLaunch');
    expect(pid).toBeDefined();
    expect(() => process.kill(pid ?? 0, 0)).toThrow();
    await machine.close();
  });
});
