/**
 * An agent that names no machine starts where the harness runs processes
 * (`environment.subprocess.open`): its launch, the tool bridge's route, a
 * reattach and a process started beside it all go through that machine.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type * as acp from '@agentclientprotocol/sdk';
import { AgentHarness, createInMemorySubprocessAdapter, execute, step } from '@noetic-tools/core';
import type {
  AcpAgent,
  AcpClientHost,
  AcpMachine,
  AcpMachineFactory,
  AcpReattachHandle,
  SpawnCommand,
} from '@noetic-tools/types';
import { AcpConnectError, frameworkCast } from '@noetic-tools/types';
import { defineAcpAgent } from '../src/define';
import { loopbackMachine } from '../src/transport-loopback';

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

/** A loopback machine that records what it was asked to start and reach again. */
function recordingMachine(log: Seen): AcpMachineFactory {
  const inner = loopbackMachine((_conn, command) => {
    log.launched.push(command);
    return quietAgent();
  });
  return async (opts): Promise<AcpMachine> => {
    const machine = await inner(opts);
    return {
      ...machine,
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
  };
}

function agentOn(machine?: AcpMachineFactory): AcpAgent {
  return defineAcpAgent({
    agentId: 'placed',
    command: {
      command: 'agent-acp',
    },
    ...(machine
      ? {
          machine,
        }
      : {}),
  });
}

async function runOn(environment: AcpMachineFactory, agent: AcpAgent): Promise<void> {
  const ctx = new AgentHarness({
    name: 'environment-machine',
    params: {},
    environment: {
      subprocess: {
        ...createInMemorySubprocessAdapter(),
        open: environment,
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

describe("the harness's subprocess machine", () => {
  it('starts an agent that names no machine of its own', async () => {
    const environment = seen();
    await runOn(recordingMachine(environment), agentOn());
    expect(environment.launched.map((command) => command.command)).toEqual([
      'agent-acp',
    ]);
  });

  it('calls open on its adapter', async () => {
    const environment = seen();
    class Placed {
      private readonly machine = recordingMachine(environment);
      open(opts: Parameters<AcpMachineFactory>[0]): Promise<AcpMachine> {
        return this.machine(opts);
      }
    }
    const ctx = new AgentHarness({
      name: 'environment-machine',
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

  it('leaves an agent on the machine it names', async () => {
    const environment = seen();
    const own = seen();
    await runOn(recordingMachine(environment), agentOn(recordingMachine(own)));
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
          threadId: 'environment-machine',
          onSessionUpdate: () => undefined,
        }),
        reattach: handle,
        machine: recordingMachine(environment),
      })
      .catch((e: unknown) => e);
    assert(gone instanceof AcpConnectError);
    expect(environment.attached).toEqual([
      handle,
    ]);
  });

  it('starts a process beside the agent, unless the agent names a machine', async () => {
    const environment = seen();
    const own = seen();
    const cat = {
      command: 'cat',
    };
    const options = {
      machine: recordingMachine(environment),
    };
    await agentOn().spawn?.(cat, options);
    expect(environment.spawned).toEqual([
      cat,
    ]);
    await agentOn(recordingMachine(own)).spawn?.(cat, options);
    expect(own.spawned).toEqual([
      cat,
    ]);
    expect(environment.spawned).toHaveLength(1);
  });
});
