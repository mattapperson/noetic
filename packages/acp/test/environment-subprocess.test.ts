/**
 * An agent that names no subprocess adapter runs through the harness's
 * (`environment.subprocess`): its launch, the tool bridge's route, a reattach
 * and a process started beside it all go through that adapter's `open`.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type * as acp from '@agentclientprotocol/sdk';
import {
  AgentHarness,
  createInMemorySubprocessAdapter,
  createLinkSubprocessAdapter,
  execute,
  step,
} from '@noetic-tools/core';
import type {
  AcpAgent,
  AcpClientHost,
  AcpReattachHandle,
  SpawnCommand,
  SubprocessAdapter,
  SubprocessChoice,
  SubprocessLink,
  SubprocessOpen,
  SubprocessOpenOptions,
} from '@noetic-tools/types';
import { AcpConnectError, adapterSet, frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import { defineAcpAgent } from '../src/define';
import { loopbackLink } from '../src/transport-loopback';

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
function recording(log: Seen): SubprocessAdapter & {
  open: SubprocessOpen;
} {
  const open = loopbackLink((_conn, command) => {
    log.launched.push(command);
    return quietAgent();
  });
  return createLinkSubprocessAdapter(async (opts) => {
    const link = await open(opts);
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

/** The harness's subprocess adapters by name, the first the default, and the one a step names. */
function among(adapters: Record<string, SubprocessAdapter>, name?: string): SubprocessChoice {
  const [first] = Object.keys(adapters);
  return {
    adapters: adapterSet({
      kind: 'subprocess',
      method: 'spawn',
      config: Object.fromEntries(
        Object.entries(adapters).map(([key, adapter]) => [
          key,
          {
            adapter,
            default: key === first,
          },
        ]),
      ),
    }),
    name,
  };
}

/** A harness whose subprocess adapters are `laptop` (the default) and `builder`, each recording. */
function twoHosts(): {
  laptop: Seen;
  builder: Seen;
  harness: AgentHarness;
} {
  const laptop = seen();
  const builder = seen();
  const harness = new AgentHarness({
    name: 'named-subprocess',
    params: {},
    environment: {
      subprocess: {
        laptop: {
          adapter: recording(laptop),
          default: true,
        },
        builder: {
          adapter: recording(builder),
          displayName: 'Build host',
        },
      },
    },
  });
  return {
    laptop,
    builder,
    harness,
  };
}

async function runStep(
  harness: AgentHarness,
  agent: AcpAgent,
  subprocess?: string,
): Promise<unknown> {
  return await execute(
    step.acpAgent({
      id: 'placed',
      agent,
      prompt: 'go',
      subprocess,
    }),
    undefined,
    harness.createContext(),
  ).catch((e: unknown) => e);
}

/** An agent that names the harness subprocess adapter `subprocess`, or none. */
function agentOn(subprocess?: string): AcpAgent {
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

async function runOn(
  environment: {
    open: SubprocessOpen;
  },
  agent: AcpAgent,
): Promise<void> {
  const ctx = new AgentHarness({
    name: 'environment-subprocess',
    params: {},
    environment: {
      subprocess: createInMemorySubprocessAdapter({
        open: environment.open,
      }),
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
        subprocess: among({
          environment: recording(environment),
        }),
      })
      .catch((e: unknown) => e);
    assert(gone instanceof AcpConnectError);
    expect(environment.attached).toEqual([
      handle,
    ]);
  });

  it('starts a process beside the agent', async () => {
    const environment = seen();
    const cat = {
      command: 'cat',
    };
    const options = {
      subprocess: among({
        environment: recording(environment),
      }),
    };
    await agentOn().spawn?.(cat, options);
    expect(environment.spawned).toEqual([
      cat,
    ]);
  });
});

describe('named subprocess adapters', () => {
  it('starts an agent that names none through the default', async () => {
    const { laptop, builder, harness } = twoHosts();
    await runStep(harness, agentOn());
    expect(laptop.launched).toHaveLength(1);
    expect(builder.launched).toHaveLength(0);
  });

  it("starts an agent through the adapter its preset names, before the harness's default", async () => {
    const { laptop, builder, harness } = twoHosts();
    const agent = agentOn('builder');
    expect(agent.subprocess).toBe('builder');
    await runStep(harness, agent);
    expect(builder.launched).toHaveLength(1);
    expect(laptop.launched).toHaveLength(0);
  });

  it("starts an agent through the adapter its step names, before the preset's name", async () => {
    const { laptop, builder, harness } = twoHosts();
    await runStep(harness, agentOn('builder'), 'laptop');
    expect(laptop.launched).toHaveLength(1);
    expect(builder.launched).toHaveLength(0);
  });

  it('fails a name the harness lacks, listing the names it has', async () => {
    const { laptop, builder, harness } = twoHosts();
    const error = await runStep(harness, agentOn('cloud'));
    assert(error instanceof NoeticConfigError);
    expect(error.code).toBe('ADAPTER_UNKNOWN');
    expect(error.message).toContain("'laptop', 'builder'");
    expect(laptop.launched).toHaveLength(0);
    expect(builder.launched).toHaveLength(0);
  });

  it('fails a named adapter with no harness adapters to find it among', async () => {
    const error = await agentOn('builder')
      .connect({
        host: frameworkCast<AcpClientHost>({
          cwd: '/work',
          threadId: 'named-subprocess',
          onSessionUpdate: () => undefined,
        }),
      })
      .catch((e: unknown) => e);
    assert(error instanceof NoeticConfigError);
    expect(error.code).toBe('SUBPROCESS_NAME_WITHOUT_HARNESS');
  });

  it('fails an agent that names none with no harness adapters to start through', async () => {
    const error = await agentOn()
      .connect({
        host: frameworkCast<AcpClientHost>({
          cwd: '/work',
          threadId: 'named-subprocess',
          onSessionUpdate: () => undefined,
        }),
      })
      .catch((e: unknown) => e);
    assert(error instanceof NoeticConfigError);
    expect(error.code).toBe('SUBPROCESS_CANNOT_OPEN');
  });

  it('starts a process beside the agent through the named adapter', async () => {
    const laptop = seen();
    const builder = seen();
    const hosts = {
      laptop: recording(laptop),
      builder: recording(builder),
    };
    const cat = {
      command: 'cat',
    };
    await agentOn('builder').spawn?.(cat, {
      subprocess: among(hosts),
    });
    expect(builder.spawned).toHaveLength(1);
    await agentOn('builder').spawn?.(cat, {
      subprocess: among(hosts, 'laptop'),
    });
    expect(laptop.spawned).toHaveLength(1);
    expect(builder.spawned).toHaveLength(1);
  });
});
