/**
 * pi takes Noetic tools as native pi tools: the wiring starts pi through the
 * `noetic-pi` launcher, which adds the `pi-noetic-tools` extension, and the
 * extension registers each bridged tool unchanged and forwards its calls.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AcpToolHost } from '@noetic-tools/types';
import { serveToolsOverHttp } from '../src/mcp/node';
import noeticTools from '../src/pi/extension';
import { piToolWiring } from '../src/tool-wiring';

const BRIDGE = {
  serverName: 'noetic',
  url: 'http://127.0.0.1:9/mcp/abc',
  headers: [
    {
      name: 'Authorization',
      value: 'Bearer t0ken',
    },
  ],
};

const SCHEMA = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: 'What to echo.',
    },
  },
  required: [
    'text',
  ],
  additionalProperties: false,
};

const BIG = 'y'.repeat(3e5);

function host(): AcpToolHost {
  return {
    serverName: 'noetic',
    tools: [
      {
        name: 'echo',
        description: 'Echo the text.',
        inputSchema: SCHEMA,
      },
      {
        name: 'big',
        title: 'Big',
        description: 'A long result.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
    call: async (call) => {
      if (call.name === 'big') {
        return {
          output: BIG,
          isError: false,
        };
      }
      return {
        output: `Error: no ${JSON.stringify(call.args)}`,
        isError: true,
      };
    },
  };
}

interface Registered {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  executionMode?: string;
  execute(
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
  ): Promise<{
    content: Array<{
      type: string;
      text: string;
    }>;
  }>;
}

describe('piToolWiring', () => {
  it('starts pi through the launcher with the bridge address', () => {
    const env = piToolWiring.launchEnv?.({
      bridge: BRIDGE,
      tools: [],
      mcpServers: [],
      env: {
        PI_ACP_PI_COMMAND: '/opt/pi/bin/pi',
      },
    });
    assert(env);
    const launcher = env.PI_ACP_PI_COMMAND;
    assert(launcher);
    expect(launcher).toEndWith(join('pi', 'launch.ts'));
    expect(existsSync(launcher)).toBe(true);
    expect(env.NOETIC_PI_COMMAND).toBe('/opt/pi/bin/pi');
    expect(env.NOETIC_TOOLS_URL).toBe(BRIDGE.url);
    expect(JSON.parse(env.NOETIC_TOOLS_HEADERS ?? '[]')).toEqual(BRIDGE.headers);
    expect(piToolWiring.declare).toBe('launch');
  });

  it('takes a launcher named for another machine', () => {
    const env = piToolWiring.launchEnv?.({
      bridge: BRIDGE,
      tools: [],
      mcpServers: [],
      env: {
        NOETIC_PI_LAUNCHER: '/remote/noetic-pi',
      },
    });
    expect(env?.PI_ACP_PI_COMMAND).toBe('/remote/noetic-pi');
    expect(env?.NOETIC_PI_COMMAND).toBe('pi');
  });

  it('refuses MCP servers of its own, which pi-acp would drop', () => {
    expect(() =>
      piToolWiring.launchEnv?.({
        bridge: BRIDGE,
        tools: [],
        mcpServers: [
          {
            name: 'docs',
            command: 'docs-mcp',
            args: [],
            env: [],
          },
        ],
        env: {},
      }),
    ).toThrow(TypeError);
  });
});

describe('pi-noetic-tools extension', () => {
  it('registers each bridged tool unchanged and returns results whole', async () => {
    const http = await serveToolsOverHttp(host);
    process.env.NOETIC_TOOLS_URL = http.url;
    process.env.NOETIC_TOOLS_HEADERS = JSON.stringify([
      {
        name: 'Authorization',
        value: `Bearer ${http.token}`,
      },
    ]);
    const registered: Registered[] = [];
    try {
      await noeticTools({
        registerTool: (tool) => {
          registered.push(tool);
        },
      });
      expect(process.env.NOETIC_TOOLS_URL).toBeUndefined();
      expect(process.env.NOETIC_TOOLS_HEADERS).toBeUndefined();
      expect(registered.map((tool) => tool.name)).toEqual([
        'echo',
        'big',
      ]);
      const [echo, big] = registered;
      assert(echo && big);
      expect(echo.description).toBe('Echo the text.');
      expect(echo.parameters).toEqual(SCHEMA);
      expect(echo.label).toBe('echo');
      expect(big.label).toBe('Big');
      expect(echo.executionMode).toBe('sequential');

      const whole = await big.execute('call-1', {}, undefined);
      expect(whole.content).toEqual([
        {
          type: 'text',
          text: BIG,
        },
      ]);
      const failed = await echo.execute(
        'call-2',
        {
          text: 'hi',
        },
        undefined,
      );
      expect(failed.content[0]?.text).toBe('Error: no {"text":"hi"}');
    } finally {
      await http.close();
    }
  });

  it('registers nothing without a bridge address', async () => {
    delete process.env.NOETIC_TOOLS_URL;
    const registered: string[] = [];
    await noeticTools({
      registerTool: (tool) => {
        registered.push(tool.name);
      },
    });
    expect(registered).toEqual([]);
  });

  it('fails clearly when the bridge refuses it', async () => {
    const http = await serveToolsOverHttp(host);
    process.env.NOETIC_TOOLS_URL = http.url;
    process.env.NOETIC_TOOLS_HEADERS = '[]';
    try {
      const failure = await noeticTools({
        registerTool: () => undefined,
      }).catch((e: unknown) => e);
      expect(String(failure)).toContain('HTTP 401');
    } finally {
      await http.close();
    }
  });
});

describe('noetic-pi launcher', () => {
  it('starts pi with the extension ahead of pi-acp’s own arguments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-pi-'));
    const fakePi = join(dir, 'pi');
    writeFileSync(fakePi, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    chmodSync(fakePi, 0o755);
    const launcher = join(import.meta.dir, '..', 'src', 'pi', 'launch.ts');
    const out = execFileSync(
      'node',
      [
        launcher,
        '--mode',
        'rpc',
      ],
      {
        env: {
          ...process.env,
          NOETIC_PI_COMMAND: fakePi,
        },
        encoding: 'utf8',
      },
    );
    const args = out.trim().split('\n');
    expect(args[0]).toBe('--extension');
    expect(args[1]).toEndWith(join('pi', 'extension.ts'));
    expect(existsSync(args[1] ?? '')).toBe(true);
    expect(args.slice(2)).toEqual([
      '--mode',
      'rpc',
    ]);
  });
});
