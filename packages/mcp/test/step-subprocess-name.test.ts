/**
 * A process beside the agent runs where the agent runs: a TypeScript
 * `step.acpAgent` that names a subprocess adapter starts the stdio `mcp()`
 * servers its `tools` list through that adapter too.
 */

import { describe, expect, it } from 'bun:test';
import type { SubprocessAdapter } from '@noetic-tools/types';
import { defineAcpAgent } from '../../acp/src/define';
import { loopbackLink } from '../../acp/src/transport-loopback';
import { AgentHarness, createInMemorySubprocessAdapter, step } from '../../core/src/index';
import { mcp } from '../src/provider';

//#region Fixtures

const quietAgent: ReturnType<Parameters<typeof loopbackLink>[0]> = {
  async initialize(params) {
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: {
        mcpCapabilities: {
          http: true,
        },
      },
      authMethods: [],
    };
  },
  async newSession() {
    return {
      sessionId: 's-1',
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
};

/** An adapter that runs the agent in this process and records each process started beside it. */
function recording(name: string, started: string[]): SubprocessAdapter {
  const open = loopbackLink(() => quietAgent);
  return createInMemorySubprocessAdapter({
    open: async (options) => ({
      ...(await open(options)),
      async spawn(command) {
        started.push(`${name}: ${command.command}`);
        throw new Error('not started in this test');
      },
    }),
  });
}

async function serversStarted(subprocess: string | undefined): Promise<string[]> {
  const started: string[] = [];
  const harness = new AgentHarness({
    name: 'step-subprocess-name',
    params: {},
    environment: {
      subprocess: {
        laptop: {
          adapter: recording('laptop', started),
          default: true,
        },
        builder: {
          adapter: recording('builder', started),
        },
      },
    },
  });
  const agent = defineAcpAgent({
    agentId: 'quiet',
    command: {
      command: 'quiet-agent',
    },
  });
  await harness
    .run(
      step.acpAgent({
        id: 'code',
        agent,
        prompt: 'go',
        tools: [
          mcp({
            name: 'docs',
            command: 'docs-mcp',
            spawn: agent.spawn,
          }),
        ],
        ...(subprocess === undefined
          ? {}
          : {
              subprocess,
            }),
      }),
      undefined,
      harness.createContext(),
    )
    // The server never starts here, so the step may fail for want of its tools.
    .catch(() => undefined);
  await harness.close();
  return started;
}

//#endregion

describe('a stdio mcp() entry on a TypeScript acpAgent step', () => {
  it('starts through the adapter the step names', async () => {
    expect(await serversStarted('builder')).toContain('builder: docs-mcp');
    expect(await serversStarted('builder')).not.toContain('laptop: docs-mcp');
  });

  it("starts through the harness's default when the step names none", async () => {
    const started = await serversStarted(undefined);
    expect(started).toContain('laptop: docs-mcp');
    expect(started).not.toContain('builder: docs-mcp');
  });
});
