/**
 * The remote runner, end to end: a real ACP agent process started by the
 * runner calls a bridged tool through the runner's loopback port, over a
 * WebSocket and over stdio, and gets the result a `callModel` model would.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHarness, execute, step, tool } from '@noetic-tools/core';
import type { AcpMachineFactory, Item } from '@noetic-tools/types';
import { isNoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';
import { codex, customAcpAgent } from '../src/agents';
import { defineAcpAgent } from '../src/define';
import type { AcpRunnerListener } from '../src/remote';
import { commandMachine, listenAcpRunner, webSocketMachine } from '../src/remote';
import { claudeToolWiring } from '../src/tool-wiring';

const FIXTURE = join(import.meta.dir, 'fixtures', 'tool-agent.ts');
const BIN = join(import.meta.dir, '..', 'src', 'bin.ts');
const TOKEN = 'runner-test-token-0123456789';

const echo = tool({
  name: 'echo',
  description: 'Echo the text.',
  input: z.object({
    text: z.string(),
  }),
  output: z.string(),
  execute: async ({ text }) => `echo: ${text}`,
});

interface Seen {
  url: string;
  names: string[];
  result: string;
  env: string | null;
}

async function runAgent(machine: AcpMachineFactory): Promise<{
  seen: Seen;
  items: Item[];
}> {
  const ctx = new AgentHarness({
    name: 'runner',
    params: {},
  }).createContext();
  const out = await execute(
    step.acpAgent({
      id: 'remote',
      agent: defineAcpAgent({
        agentId: 'tool-agent',
        command: {
          command: process.execPath,
          args: [
            FIXTURE,
          ],
          env: {
            NOETIC_TOOL_AGENT_MARK: 'launched-remotely',
          },
        },
        machine,
        tools: claudeToolWiring,
      }),
      prompt: 'call echo',
      tools: [
        echo,
      ],
    }),
    undefined,
    ctx,
  );
  return {
    seen: JSON.parse(String(out)),
    items: [
      ...ctx.itemLog.items,
    ],
  };
}

function outputs(items: Item[]): string[] {
  return items.flatMap((item) =>
    item.type === 'function_call_output'
      ? [
          item.output,
        ]
      : [],
  );
}

describe('remote runner over WebSocket', () => {
  let listener: AcpRunnerListener;
  beforeAll(async () => {
    listener = await listenAcpRunner({
      token: TOKEN,
    });
  });
  afterAll(async () => {
    await listener.close();
  });

  it('serves the bridge on the runner, and the call matches callModel', async () => {
    const { seen, items } = await runAgent(
      webSocketMachine({
        url: listener.url,
        token: TOKEN,
      }),
    );
    expect(seen.names).toEqual([
      'echo',
    ]);
    expect(seen.result).toBe('echo: over the runner');
    expect(seen.env).toBe('launched-remotely');
    expect(new URL(seen.url).hostname).toBe('127.0.0.1');
    expect(outputs(items)).toEqual([
      'echo: over the runner',
    ]);
  });

  it('refuses a wrong token', async () => {
    const failure = await webSocketMachine({
      url: listener.url,
      token: 'wrong-token-wrong-token',
    })({}).catch((e: unknown) => e);
    expect(String(failure)).toContain('refused the connection');
  });

  it('refuses a plain ws:// URL off the loopback interface', () => {
    expect(() =>
      webSocketMachine({
        url: 'ws://build-host.example:7000',
        token: TOKEN,
      }),
    ).toThrow(TypeError);
  });
});

describe('remote runner rules', () => {
  it('will not listen off the loopback interface without TLS', async () => {
    const failure = await listenAcpRunner({
      host: '0.0.0.0',
      token: TOKEN,
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TypeError);
  });

  it('starts only allowed commands', async () => {
    const listener = await listenAcpRunner({
      token: TOKEN,
      allow: [
        {
          command: 'npx',
          args: [
            '-y',
            '@agentclientprotocol/codex-acp',
          ],
        },
      ],
    });
    try {
      const machine = await webSocketMachine({
        url: listener.url,
        token: TOKEN,
      })({});
      const failure = await machine
        .launch({
          command: 'sh',
          args: [
            '-c',
            'echo hi',
          ],
        })
        .catch((e: unknown) => e);
      expect(String(failure)).toContain('does not start');
      await machine.close();
    } finally {
      await listener.close();
    }
  });

  it('serves over TLS with the bearer token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-tls-'));
    const cert = join(dir, 'cert.pem');
    const key = join(dir, 'key.pem');
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
    ]);
    const listener = await listenAcpRunner({
      host: 'localhost',
      token: TOKEN,
      tls: {
        cert: readFileSync(cert, 'utf8'),
        key: readFileSync(key, 'utf8'),
      },
    });
    try {
      expect(listener.url).toStartWith('wss://');
      const { seen } = await runAgent(
        webSocketMachine({
          url: listener.url,
          token: TOKEN,
          ca: readFileSync(cert, 'utf8'),
        }),
      );
      expect(seen.result).toBe('echo: over the runner');
    } finally {
      await listener.close();
    }
  });
});

describe('remote runner over stdio', () => {
  it('runs through a command that starts the runner, as ssh would', async () => {
    const { seen, items } = await runAgent(
      commandMachine({
        command: process.execPath,
        args: [
          BIN,
          'serve',
          '--stdio',
        ],
      }),
    );
    expect(seen.result).toBe('echo: over the runner');
    expect(outputs(items)).toEqual([
      'echo: over the runner',
    ]);
  });
});

describe('attached transports', () => {
  const attach = async (): Promise<never> => {
    throw new Error('unused');
  };
  const codeFor = (agent: ReturnType<typeof codex>): string | undefined => {
    try {
      step.acpAgent({
        id: 'attached',
        agent,
        prompt: 'go',
        tools: [
          echo,
        ],
      });
      return undefined;
    } catch (e) {
      assert(isNoeticConfigError(e));
      return e.code;
    }
  };

  it('ACP_TRANSPORT_CANNOT_LAUNCH when the wiring has launch settings', () => {
    expect(
      codeFor(
        codex({
          transport: attach,
        }),
      ),
    ).toBe('ACP_TRANSPORT_CANNOT_LAUNCH');
  });

  it('ACP_TRANSPORT_CANNOT_REACH when it has none', () => {
    expect(
      codeFor(
        customAcpAgent({
          agentId: 'attached',
          transport: attach,
        }),
      ),
    ).toBe('ACP_TRANSPORT_CANNOT_REACH');
  });

  it('a preset on a machine takes tools', () => {
    expect(
      codeFor(
        codex({
          machine: webSocketMachine({
            url: 'ws://127.0.0.1:1',
            token: TOKEN,
          }),
        }),
      ),
    ).toBeUndefined();
  });
});
