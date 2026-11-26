/**
 * Every link an agent opens is closed once, whichever step of connecting
 * fails, and an agent reached for an earlier host is let go of once.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type * as acp from '@agentclientprotocol/sdk';
import { createLinkSubprocessAdapter } from '@noetic-tools/core';
import type {
  AcpAgentConnection,
  AcpClientHost,
  AcpConnectOptions,
  AcpTransport,
  SubprocessLink,
  Tool,
} from '@noetic-tools/types';
import { adapterSet, frameworkCast } from '@noetic-tools/types';
import { defineAcpAgent } from '../src/define';
import { loopbackLink } from '../src/transport-loopback';

//#region Fixtures

interface Counts {
  opened: number;
  closed: number;
  detached: number;
}

type Fault = 'reach' | 'launch' | 'attach';

const HANDLE = {
  kind: 'test-keeper',
};

function agentThat(fails?: 'initialize' | 'newSession'): acp.Agent {
  return {
    async initialize() {
      if (fails === 'initialize') {
        throw new Error('initialize refused');
      }
      return {
        protocolVersion: 1,
        agentCapabilities: {},
      };
    },
    async newSession() {
      if (fails === 'newSession') {
        throw new Error('newSession refused');
      }
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
}

/** Connect options over a counting link whose `fault` step throws, to an agent that fails `agentFails`. */
function rig(opts: { fault?: Fault; agentFails?: 'initialize' | 'newSession'; tools?: boolean }): {
  counts: Counts;
  connect: AcpConnectOptions;
} {
  const counts: Counts = {
    opened: 0,
    closed: 0,
    detached: 0,
  };
  const open = loopbackLink(() => agentThat(opts.agentFails));
  const refuse = (step: Fault): void => {
    if (opts.fault === step) {
      throw new Error(`${step} refused`);
    }
  };
  /** A kept agent's stream: it can be let go of. */
  const kept = (transport: AcpTransport): AcpTransport => ({
    ...transport,
    reattach: HANDLE,
    async detach() {
      counts.detached += 1;
    },
  });
  const adapter = createLinkSubprocessAdapter(async (given): Promise<SubprocessLink> => {
    const link = await open(given);
    counts.opened += 1;
    return {
      ...link,
      async reach(bridge) {
        refuse('reach');
        return bridge;
      },
      async launch(command) {
        refuse('launch');
        return kept(await link.launch(command));
      },
      async attach() {
        refuse('attach');
        return kept(
          await link.launch({
            command: 'kept',
          }),
        );
      },
      async close() {
        counts.closed += 1;
      },
    };
  });
  const host = frameworkCast<AcpClientHost>({
    cwd: '/work',
    ...(opts.tools
      ? {
          tools: {
            serverName: 'noetic',
            tools: frameworkCast<Tool[]>([]),
          },
        }
      : {}),
  });
  return {
    counts,
    connect: {
      host,
      subprocess: {
        adapters: adapterSet({
          kind: 'subprocess',
          method: 'spawn',
          config: adapter,
        }),
      },
    },
  };
}

const agent = defineAcpAgent({
  agentId: 'kept',
  command: {
    command: 'kept',
  },
});

async function failureOf(run: Promise<unknown>): Promise<unknown> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  assert(error instanceof Error);
  return error;
}

//#endregion

describe('a link an agent opens', () => {
  it('is closed once when the bridge cannot be reached', async () => {
    const { counts, connect } = rig({
      fault: 'reach',
      tools: true,
    });
    await failureOf(agent.connect(connect));
    expect(counts).toEqual({
      opened: 1,
      closed: 1,
      detached: 0,
    });
  });

  it('is closed once when the launch fails', async () => {
    const { counts, connect } = rig({
      fault: 'launch',
    });
    await failureOf(agent.connect(connect));
    expect(counts).toEqual({
      opened: 1,
      closed: 1,
      detached: 0,
    });
  });

  it('is closed once when initialize fails', async () => {
    const { counts, connect } = rig({
      agentFails: 'initialize',
    });
    await failureOf(agent.connect(connect));
    expect(counts).toEqual({
      opened: 1,
      closed: 1,
      detached: 0,
    });
  });

  it('is closed once when a session cannot be opened and the caller closes the connection', async () => {
    const { counts, connect } = rig({
      agentFails: 'newSession',
    });
    const connection: AcpAgentConnection = await agent.connect(connect);
    await failureOf(
      connection.newSession({
        cwd: '/work',
        mcpServers: [],
      }),
    );
    expect(counts.closed).toBe(0);
    await connection.close();
    await connection.close();
    expect(counts).toEqual({
      opened: 1,
      closed: 1,
      detached: 0,
    });
  });

  it('is closed once when the caller lets go of the agent', async () => {
    const { counts, connect } = rig({});
    const connection = await agent.connect(connect);
    assert(connection.detach);
    await connection.detach();
    expect(counts.closed).toBe(1);
    await connection.close();
    expect(counts).toEqual({
      opened: 1,
      closed: 1,
      detached: 1,
    });
  });
});

describe('a link opened to reattach', () => {
  it('is closed once, letting go of nothing, when the attach fails', async () => {
    const { counts, connect } = rig({
      fault: 'attach',
    });
    await failureOf(
      agent.connect({
        ...connect,
        reattach: HANDLE,
      }),
    );
    expect(counts).toEqual({
      opened: 1,
      closed: 1,
      detached: 0,
    });
  });

  it('is closed once, and the agent let go of once, when the bridge fails after the attach', async () => {
    const { counts, connect } = rig({
      fault: 'reach',
      tools: true,
    });
    await failureOf(
      agent.connect({
        ...connect,
        reattach: HANDLE,
      }),
    );
    expect(counts).toEqual({
      opened: 1,
      closed: 1,
      detached: 1,
    });
  });

  it('is closed once, and the agent let go of once, when initialize fails after the attach', async () => {
    const { counts, connect } = rig({
      agentFails: 'initialize',
    });
    await failureOf(
      agent.connect({
        ...connect,
        reattach: HANDLE,
      }),
    );
    expect(counts).toEqual({
      opened: 1,
      closed: 1,
      detached: 1,
    });
  });
});
