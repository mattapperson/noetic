/**
 * The Claude Code and Codex presets launch the maintained
 * `@agentclientprotocol` bridges (#98), carry the preset's arguments,
 * environment and working directory to them, and still honour a custom
 * transport without launching anything.
 */

import { describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLinkSubprocessAdapter } from '@noetic-tools/core';
import type { AcpClientHost } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { claudeCode, codex, PRESET_COMMANDS } from '../src/agents';
import { openLocalLink } from '../src/stdio';
import { loopbackTransport } from '../src/transport-loopback';

const PRESETS = [
  {
    make: claudeCode,
    id: 'claude-code',
    bridge: '@agentclientprotocol/claude-agent-acp',
  },
  {
    make: codex,
    id: 'codex',
    bridge: '@agentclientprotocol/codex-acp',
  },
] as const;

function host(cwd: string): AcpClientHost {
  return frameworkCast<AcpClientHost>({
    cwd,
    threadId: 'preset-test',
    onSessionUpdate: () => undefined,
  });
}

describe('maintained bridge presets', () => {
  it('names only the maintained bridges, never the retired @zed-industries packages', () => {
    expect(PRESET_COMMANDS['claude-code'].args).toEqual([
      '-y',
      '@agentclientprotocol/claude-agent-acp',
    ]);
    expect(PRESET_COMMANDS.codex.args).toEqual([
      '-y',
      '@agentclientprotocol/codex-acp',
    ]);
    expect(JSON.stringify(PRESET_COMMANDS)).not.toContain('@zed-industries');
  });

  for (const { make, id, bridge } of PRESETS) {
    it.skipIf(process.platform === 'win32')(
      `${id} launches ${bridge} with its arguments, environment and cwd`,
      async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'noetic-preset-')));
        const report = join(root, 'launch.json');
        const fixture = new URL('./fixtures/serve-stdio-agent.ts', import.meta.url).href;
        // A stand-in `npx` that records how it was launched, then serves ACP.
        const npx = join(root, 'npx');
        await writeFile(
          npx,
          [
            `#!${process.execPath}`,
            "import { writeFileSync } from 'node:fs';",
            `writeFileSync(${JSON.stringify(report)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), codexPath: process.env.CODEX_PATH, flag: process.env.PRESET_FLAG }));`,
            `await import(${JSON.stringify(fixture)});`,
            '',
          ].join('\n'),
        );
        await chmod(npx, 0o700);
        try {
          const agent = make({
            args: [
              '--extra',
            ],
            env: {
              PATH: `${root}:${process.env.PATH ?? ''}`,
              CODEX_PATH: '/chosen/codex',
              PRESET_FLAG: 'on',
            },
            subprocess: createLinkSubprocessAdapter((options) => openLocalLink({}, options)),
          });
          expect(agent.agentId).toBe(id);
          const connection = await agent.connect({
            host: host(root),
          });
          await connection.newSession({
            cwd: root,
          });
          await connection.close();
          expect(JSON.parse(await readFile(report, 'utf8'))).toEqual({
            args: [
              '-y',
              bridge,
              '--extra',
            ],
            cwd: root,
            codexPath: '/chosen/codex',
            flag: 'on',
          });
        } finally {
          await rm(root, {
            recursive: true,
            force: true,
          });
        }
      },
      15e3,
    );

    it(`${id} charges each turn its own usage, unless told another reader or none`, async () => {
      const turnOf = async (usageOf?: false | (() => undefined), quotaOnly = false) => {
        const agent = make({
          ...(usageOf === undefined
            ? {}
            : {
                usageOf,
              }),
          transport: loopbackTransport(() => ({
            initialize: async () => ({
              protocolVersion: 1,
              agentCapabilities: {},
            }),
            authenticate: async () => ({}),
            newSession: async () => ({
              sessionId: 's',
            }),
            prompt: async () => ({
              stopReason: 'end_turn',
              ...(quotaOnly
                ? {}
                : {
                    usage: {
                      inputTokens: 10,
                      outputTokens: 5,
                      totalTokens: 15,
                    },
                  }),
              _meta: {
                quota: {
                  token_count: {
                    inputTokens: 40,
                    outputTokens: 7,
                    cachedInputTokens: 30,
                  },
                },
              },
            }),
            cancel: async () => undefined,
          })),
        });
        const connection = await agent.connect({
          host: host('/workspace'),
        });
        const session = await connection.newSession({
          cwd: '/workspace',
        });
        const result = await session.prompt({
          content: [
            {
              type: 'text',
              text: 'hi',
            },
          ],
        });
        await connection.close();
        return result.usage;
      };
      expect(await turnOf()).toEqual({
        inputTokens: 10,
        outputTokens: 5,
      });
      expect(await turnOf(undefined, true)).toEqual(
        id === 'codex'
          ? {
              inputTokens: 40,
              outputTokens: 7,
              cachedTokens: 30,
            }
          : undefined,
      );
      expect(await turnOf(false)).toBeUndefined();
      expect(await turnOf(() => undefined)).toBeUndefined();
    });

    it(`${id} uses a custom transport in place of its command`, async () => {
      const controller = new AbortController();
      const transport = loopbackTransport(() => ({
        initialize: async () => ({
          protocolVersion: 1,
          agentCapabilities: {},
        }),
        authenticate: async () => ({}),
        newSession: async () => ({
          sessionId: 'custom-session',
        }),
        prompt: async () => ({
          stopReason: 'end_turn',
        }),
        cancel: async () => undefined,
      }));
      const seen: Array<{
        cwd: string;
        env?: Record<string, string | undefined>;
        signal?: AbortSignal;
      }> = [];
      const agent = make({
        command: '/must-not-launch',
        env: {
          PRESET_FLAG: 'on',
        },
        transport: async (opts) => {
          seen.push(opts);
          return transport(opts);
        },
      });

      const connection = await agent.connect({
        host: host('/workspace'),
        signal: controller.signal,
      });
      const session = await connection.newSession({
        cwd: '/workspace',
      });
      await connection.close();

      expect(session.sessionId).toBe('custom-session');
      expect(seen).toHaveLength(1);
      expect(seen[0]?.env?.PRESET_FLAG).toBe('on');
      expect(seen[0]?.signal).toBe(controller.signal);
    });
  }
});
