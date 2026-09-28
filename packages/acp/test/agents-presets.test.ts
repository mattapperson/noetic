import { describe, expect, mock, test } from 'bun:test';
import type { AcpClientHost, AcpTransportFactory } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { PROTOCOL_VERSION } from '@zed-industries/agent-client-protocol';
import { claudeCode, codex } from '../src/agents';
import type { StdioAgentSpec } from '../src/stdio';
import { loopbackTransport } from '../src/transport-loopback';

const spawned: StdioAgentSpec[] = [];
mock.module('../src/stdio', () => ({
  stdioAcpTransport: (spec: StdioAgentSpec): AcpTransportFactory => {
    spawned.push(spec);
    return script;
  },
}));

const presets = [
  [
    'claude-code',
    claudeCode,
    '@agentclientprotocol/claude-agent-acp',
  ],
  [
    'codex',
    codex,
    '@agentclientprotocol/codex-acp',
  ],
] as const;

function host(): AcpClientHost {
  return frameworkCast<AcpClientHost>({
    cwd: '/workspace',
    threadId: 'thread-1',
    onSessionUpdate: () => undefined,
  });
}

const script = loopbackTransport(() => ({
  async initialize(params) {
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: {},
      authMethods: [],
    };
  },
  async newSession() {
    return {
      sessionId: 'session-1',
    };
  },
  async authenticate() {
    return {};
  },
  async prompt() {
    return {
      stopReason: 'end_turn',
    };
  },
  async cancel() {},
}));

describe('ACP agent presets', () => {
  for (const [agentId, create, packageName] of presets) {
    test(`${agentId} uses its current ACP package and supports overrides`, async () => {
      spawned.length = 0;
      const agent = create({
        env: {
          TEST_PRESET: 'yes',
        },
        args: [
          '--flag',
        ],
      });
      const connection = await agent.connect({
        host: host(),
      });
      expect(spawned).toEqual([
        {
          agentId,
          command: 'npx',
          args: [
            '-y',
            packageName,
            '--flag',
          ],
          env: {
            TEST_PRESET: 'yes',
          },
        },
      ]);
      expect(connection.protocolVersion).toBe(PROTOCOL_VERSION);
      await connection.close();

      spawned.length = 0;
      const overridden = create({
        command: 'custom-bin',
        args: [
          '--debug',
        ],
      });
      const customConnection = await overridden.connect({
        host: host(),
      });
      expect(spawned[0]).toMatchObject({
        command: 'custom-bin',
        args: [
          '-y',
          packageName,
          '--debug',
        ],
      });
      await customConnection.close();

      spawned.length = 0;
      const calls: Array<{
        cwd: string;
        env?: Record<string, string | undefined>;
      }> = [];
      const transport: AcpTransportFactory = async (opts) => {
        calls.push({
          cwd: opts.cwd,
          env: opts.env,
        });
        return await script(opts);
      };
      const alternate = create({
        transport,
        env: {
          TEST_PRESET: 'transport',
        },
      });
      const viaTransport = await alternate.connect({
        host: host(),
      });
      expect(spawned).toEqual([]);
      expect(calls).toEqual([
        {
          cwd: '/workspace',
          env: {
            TEST_PRESET: 'transport',
          },
        },
      ]);
      const session = await viaTransport.newSession({
        cwd: '/workspace',
      });
      const result = await session.prompt({
        content: [
          {
            type: 'text',
            text: 'hello',
          },
        ],
      });
      expect(result.stopReason).toBe('end_turn');
      await viaTransport.close();
    });
  }
});
