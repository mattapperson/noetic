import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCode, codex, customAcpAgent, gemini, opencode, pi } from '../src/agents';
import { loopbackTransport } from '../src/transport-loopback';
import { MemoryFs, RecordingShell } from './_helpers';

const presets = [
  {
    make: claudeCode,
    id: 'claude-code',
    pkg: '@agentclientprotocol/claude-agent-acp',
  },
  {
    make: codex,
    id: 'codex',
    pkg: '@agentclientprotocol/codex-acp',
  },
];

function host(cwd: string) {
  return {
    cwd,
    threadId: 'preset-test',
    fs: new MemoryFs(),
    shell: new RecordingShell(),
    onSessionUpdate: () => undefined,
  };
}

describe('maintained ACP presets', () => {
  for (const { make, id, pkg } of presets) {
    it.skipIf(process.platform === 'win32')(
      `${id} launches the maintained package with its environment and extra arguments`,
      async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'noetic-preset-')));
        const fixture = new URL('./fixtures/serve-stdio-agent.ts', import.meta.url).href;
        const report = join(root, 'launch.json');
        const script = `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(report)}, JSON.stringify({args:process.argv.slice(2), cwd:process.cwd(), config:process.env.CODEX_CONFIG, backend:process.env.CODEX_PATH}));\nawait import(${JSON.stringify(fixture)});\n`;
        await writeFile(join(root, 'npx'), script, {
          mode: 0o700,
        });
        const config = JSON.stringify({
          model: 'test-model',
          approval_policy: 'never',
        });
        try {
          const agent = make({
            args: [
              '--test-flag',
            ],
            env: {
              PATH: `${root}:${process.env.PATH ?? ''}`,
              CODEX_CONFIG: config,
              CODEX_PATH: '/chosen/codex',
            },
          });
          expect(agent.agentId).toBe(id);
          const connection = await agent.connect({
            host: host(root),
          });
          try {
            expect(JSON.parse(await readFile(report, 'utf8'))).toEqual({
              args: [
                '-y',
                pkg,
                '--test-flag',
              ],
              cwd: root,
              config,
              backend: '/chosen/codex',
            });
          } finally {
            await connection.close();
          }
        } finally {
          await rm(root, {
            recursive: true,
            force: true,
          });
        }
      },
    );

    it(`${id} keeps custom transports and passes environment, cwd, and cancellation`, async () => {
      const signal = new AbortController().signal;
      const env = {
        CODEX_CONFIG: '{"model":"test-model"}',
        CODEX_PATH: '/chosen/codex',
      };
      const transport = loopbackTransport(() => ({
        initialize: async () => ({
          protocolVersion: 1,
          agentCapabilities: {},
        }),
        authenticate: async () => ({}),
        newSession: async () => ({
          sessionId: 'test-session',
        }),
        prompt: async () => ({
          stopReason: 'end_turn',
        }),
        cancel: async () => {},
      }));
      let opened = false;
      const agent = make({
        command: '/must-not-launch',
        env,
        transport: async (opts) => {
          expect(opts).toEqual({
            cwd: '/workspace',
            env,
            signal,
          });
          opened = true;
          return transport(opts);
        },
      });
      const connection = await agent.connect({
        host: host('/workspace'),
        signal,
      });
      expect(opened).toBe(true);
      await connection.close();
    });
  }
});

describe('preset API key variables', () => {
  it.each([
    [
      claudeCode(),
      {
        env: 'ANTHROPIC_API_KEY',
      },
    ],
    [
      codex(),
      {
        env: 'CODEX_API_KEY',
        methodId: 'api-key',
      },
    ],
    [
      gemini(),
      {
        env: 'GEMINI_API_KEY',
        methodId: 'gemini-api-key',
      },
    ],
  ])('%#: names where the bridge reads its key', (agent, apiKey) => {
    expect(agent.apiKey).toEqual(apiKey);
  });

  it('leaves provider-dependent agents without one', () => {
    expect(opencode().apiKey).toBeUndefined();
    expect(pi().apiKey).toBeUndefined();
  });

  it('lets an override or a custom agent declare one', () => {
    const apiKey = {
      env: 'MY_KEY',
    };
    expect(
      claudeCode({
        apiKey,
      }).apiKey,
    ).toEqual(apiKey);
    expect(
      customAcpAgent({
        agentId: 'mine',
        command: 'mine-acp',
        apiKey,
      }).apiKey,
    ).toEqual(apiKey);
  });
});

describe('connection env', () => {
  it("layers connect's env over the preset's", async () => {
    const transport = loopbackTransport(() => ({
      initialize: async () => ({
        protocolVersion: 1,
        agentCapabilities: {},
      }),
      authenticate: async () => ({}),
      newSession: async () => ({
        sessionId: 'test-session',
      }),
      prompt: async () => ({
        stopReason: 'end_turn',
      }),
      cancel: async () => {},
    }));
    let seen: Record<string, string | undefined> | undefined;
    const agent = codex({
      env: {
        A: 'preset',
        B: 'preset',
      },
      transport: async (opts) => {
        seen = opts.env;
        return transport(opts);
      },
    });
    const connection = await agent.connect({
      host: host('/workspace'),
      env: {
        B: 'step',
        CODEX_API_KEY: 'sk-test',
      },
    });
    await connection.close();

    expect(seen).toEqual({
      A: 'preset',
      B: 'step',
      CODEX_API_KEY: 'sk-test',
    });
  });
});
