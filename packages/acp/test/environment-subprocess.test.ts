/**
 * An agent that names no subprocess adapter runs through the harness's
 * (`environment.subprocess`): its launch, the tool bridge's route, a reattach
 * and a process started beside it all go through that adapter's `open`.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type * as acp from '@agentclientprotocol/sdk';
import { AgentHarness, createInMemorySubprocessAdapter, execute, step } from '@noetic-tools/core';
import type {
  AcpAgent,
  AcpClientHost,
  AcpReattachHandle,
  SpawnCommand,
  SubprocessAdapter,
  SubprocessLink,
  SubprocessOpenOptions,
} from '@noetic-tools/types';
import { AcpConnectError, frameworkCast } from '@noetic-tools/types';
import type { AgentSubprocessAdapter } from '../src/agent-subprocess';
import { agentSubprocess } from '../src/agent-subprocess';
import { defineAcpAgent } from '../src/define';
import { loopbackSubprocess } from '../src/transport-loopback';

interface Seen {
  launched: SpawnCommand[];
  spawned: SpawnCommand[];
  attached: AcpReattachHandle[];
}

function seen(): Seen {
  return {
    launched: [],
    spawned: [],
    attached: [],
  };
}

function quietAgent(): acp.Agent {
  return {
    async initialize() {
      return {
        protocolVersion: 1,
        agentCapabilities: {},
      };
    },
    async newSession() {
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

/** A loopback adapter that records what it was asked to start and reach again. */
function recording(log: Seen): AgentSubprocessAdapter {
  const inner = loopbackSubprocess((_conn, command) => {
    log.launched.push(command);
    return quietAgent();
  });
  return agentSubprocess('recording', async (opts) => {
    const link = await inner.open(opts);
    return {
      ...link,
      async spawn(command) {
        log.spawned.push(command);
        return {
          readable: new ReadableStream(),
          writable: new WritableStream(),
          close: async () => undefined,
        };
      },
      async attach(handle) {
        log.attached.push(handle);
        throw new AcpConnectError({
          agentId: 'kept',
          message: 'the kept agent is gone',
          gone: true,
        });
      },
    };
  });
}

function agentOn(subprocess?: SubprocessAdapter): AcpAgent {
  return defineAcpAgent({
    agentId: 'placed',
    command: {
      command: 'agent-acp',
    },
    ...(subprocess
      ? {
          subprocess,
        }
      : {}),
  });
}

async function runOn(environment: AgentSubprocessAdapter, agent: AcpAgent): Promise<void> {
  const ctx = new AgentHarness({
    name: 'environment-subprocess',
    params: {},
    environment: {
      subprocess: {
        ...createInMemorySubprocessAdapter(),
        open: (options) => environment.open(options),
      },
    },
  }).createContext();
  await execute(
    step.acpAgent({
      id: 'placed',
      agent,
      prompt: 'go',
    }),
    undefined,
    ctx,
  );
}

describe("the harness's subprocess adapter", () => {
  it('starts an agent that names no adapter of its own', async () => {
    const environment = seen();
    await runOn(recording(environment), agentOn());
    expect(environment.launched.map((command) => command.command)).toEqual([
      'agent-acp',
    ]);
  });

  it('calls open on its adapter', async () => {
    const environment = seen();
    class Placed {
      private readonly inner = recording(environment);
      open(options: SubprocessOpenOptions): Promise<SubprocessLink> {
        return this.inner.open(options);
      }
    }
    const ctx = new AgentHarness({
      name: 'environment-subprocess',
      params: {},
      environment: {
        subprocess: Object.assign(new Placed(), createInMemorySubprocessAdapter()),
      },
    }).createContext();
    await execute(
      step.acpAgent({
        id: 'placed',
        agent: agentOn(),
        prompt: 'go',
      }),
      undefined,
      ctx,
    );
    expect(environment.launched).toHaveLength(1);
  });

  it('leaves an agent on the adapter it names', async () => {
    const environment = seen();
    const own = seen();
    await runOn(recording(environment), agentOn(recording(own)));
    expect(own.launched).toHaveLength(1);
    expect(environment.launched).toHaveLength(0);
  });

  it('is where a resumed step reaches the agent it left running', async () => {
    const environment = seen();
    const handle = {
      keeper: 'k-1',
    };
    const gone = await agentOn()
      .connect({
        host: frameworkCast<AcpClientHost>({
          cwd: '/work',
          threadId: 'environment-subprocess',
          onSessionUpdate: () => undefined,
        }),
        reattach: handle,
        subprocess: recording(environment),
      })
      .catch((e: unknown) => e);
    assert(gone instanceof AcpConnectError);
    expect(environment.attached).toEqual([
      handle,
    ]);
  });

  it('starts a process beside the agent, unless the agent names an adapter', async () => {
    const environment = seen();
    const own = seen();
    const cat = {
      command: 'cat',
    };
    const options = {
      subprocess: recording(environment),
    };
    await agentOn().spawn?.(cat, options);
    expect(environment.spawned).toEqual([
      cat,
    ]);
    await agentOn(recording(own)).spawn?.(cat, options);
    expect(own.spawned).toEqual([
      cat,
    ]);
    expect(environment.spawned).toHaveLength(1);
  });
});
