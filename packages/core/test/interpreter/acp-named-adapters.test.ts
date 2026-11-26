/**
 * An ACP step picks the harness adapters it uses by name: the agent's process
 * through `subprocess`, its `fs/*` and `terminal/*` calls through `fs` and
 * `shell`. Steps on different adapters never share a connection, and a resumed
 * step reattaches only through the adapter its agent was started through.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type {
  AcpAgent,
  AcpAgentConnection,
  AcpConnectOptions,
  AcpSession,
  AcpTurnResult,
  FsAdapter,
  ShellAdapter,
} from '@noetic-tools/types';
import { isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import { createInMemoryFsAdapter } from '../../src/adapters/in-memory-fs-adapter';
import { createInMemoryShellAdapter } from '../../src/adapters/in-memory-shell-adapter';
import { createInMemorySubprocessAdapter } from '../../src/adapters/in-memory-subprocess-adapter';
import type { StepAcpAgentOpts } from '../../src/builders/step-builders';
import { step } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { execute } from '../../src/interpreter/execute';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { makeMessage } from '../_helpers';

//#region Fixtures

const HANDLE = {
  kind: 'test-keeper',
  address: 'kept-agent-1',
};

type Names = Pick<StepAcpAgentOpts<unknown, string>, 'subprocess' | 'fs' | 'shell' | 'session'>;

interface Hosts {
  harness: AgentHarness;
  fs: Record<'laptop' | 'builder', FsAdapter>;
  shell: Record<'laptop' | 'builder', ShellAdapter>;
}

/** A harness with a `laptop` (the default) and a `builder` adapter of each kind. */
function twoHosts(storage?: StorageAdapter): Hosts {
  const fs = {
    laptop: createInMemoryFsAdapter(),
    builder: createInMemoryFsAdapter(),
  };
  const shell = {
    laptop: createInMemoryShellAdapter(),
    builder: createInMemoryShellAdapter(),
  };
  const harness = new AgentHarness({
    name: 'acp-named-adapters',
    params: {},
    environment: {
      ...(storage
        ? {
            storage: {
              adapter: storage,
            },
          }
        : {}),
      fs: {
        laptop: {
          adapter: fs.laptop,
          default: true,
        },
        builder: {
          adapter: fs.builder,
        },
      },
      shell: {
        laptop: {
          adapter: shell.laptop,
          default: true,
        },
        builder: {
          adapter: shell.builder,
        },
      },
      subprocess: {
        laptop: {
          adapter: createInMemorySubprocessAdapter(),
          default: true,
        },
        builder: {
          adapter: createInMemorySubprocessAdapter(),
        },
      },
    },
  });
  return {
    harness,
    fs,
    shell,
  };
}

/**
 * An agent that records each connect. With `hangs`, a first connection's
 * prompt never ends, as when its host dies mid-turn, and the agent can be
 * reattached.
 */
function recordingAgent(
  connects: AcpConnectOptions[],
  opts: {
    hangs?: boolean;
    /** The harness subprocess adapter the preset names. */
    subprocess?: string;
  } = {},
): AcpAgent {
  const done: AcpTurnResult = {
    stopReason: 'end_turn',
    items: [
      makeMessage('assistant', 'done'),
    ],
    text: 'done',
  };
  return {
    specificationVersion: 'acp-v1',
    agentId: 'recording',
    ...(opts.subprocess === undefined
      ? {}
      : {
          subprocess: opts.subprocess,
        }),
    async connect(connect): Promise<AcpAgentConnection> {
      connects.push(connect);
      const session = (sessionId: string): AcpSession => ({
        sessionId,
        availableCommands: [],
        async prompt(prompt) {
          if (!opts.hangs || connect.reattach) {
            return done;
          }
          return await new Promise<AcpTurnResult>((resolve) => {
            prompt.signal?.addEventListener('abort', () =>
              resolve({
                stopReason: 'cancelled',
                items: [],
                text: '',
              }),
            );
          });
        },
        ...(connect.reattach
          ? {
              resumeTurn: async () => done,
            }
          : {}),
        async cancel() {},
        async setMode() {},
        async setModel() {},
      });
      return {
        agentCapabilities: {},
        authMethods: [],
        protocolVersion: 1,
        fingerprintFor: (): string => 'recording',
        ...(opts.hangs
          ? {
              reattach: HANDLE,
            }
          : {}),
        async authenticate() {},
        newSession: async () => session('s-1'),
        loadSession: async (load) => session(load.sessionId),
        ...(connect.reattach
          ? {
              attachSession: async (sessionId: string) => session(sessionId),
            }
          : {}),
        async close() {},
      };
    },
  };
}

function coder(agent: AcpAgent, names: Names = {}) {
  return step.acpAgent({
    id: 'code',
    agent,
    prompt: 'Add the feature.',
    ...names,
  });
}

function rootCause(error: unknown): unknown {
  let current = error;
  while (isNoeticError(current) && current.noeticError.kind === 'step_failed') {
    current = current.noeticError.cause;
  }
  return current;
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 2e3 && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert(done());
}

/** Runs a test started and must end, so no turn outlives its test. */
const running: Array<{
  ctx: {
    abort(reason?: string): void;
  };
  done: Promise<unknown>;
}> = [];

afterEach(async () => {
  for (const run of running.splice(0)) {
    run.ctx.abort('test over');
    await run.done;
  }
});

/** Run the step until its agent is mid-turn, as a host that then dies leaves it. */
async function cutOff(storage: StorageAdapter, names?: Names): Promise<string> {
  const { harness } = twoHosts(storage);
  const ctx = harness.createContext();
  const connects: AcpConnectOptions[] = [];
  const done = harness
    .run(
      coder(
        recordingAgent(connects, {
          hangs: true,
        }),
        names,
      ),
      undefined,
      ctx,
    )
    .catch(() => undefined);
  running.push({
    ctx,
    done,
  });
  await until(() => connects.length === 1);
  // The record is written once the session is open, before the prompt.
  await new Promise((resolve) => setTimeout(resolve, 5));
  return ctx.id;
}

async function resume(
  storage: StorageAdapter,
  executionId: string,
  acpStep: ReturnType<typeof coder>,
): Promise<unknown> {
  const { harness } = twoHosts(storage);
  const ctx = await harness.restore(executionId);
  assert(ctx);
  const done = harness.run(acpStep, undefined, ctx).catch((e: unknown) => e);
  running.push({
    ctx,
    done,
  });
  return await done;
}

//#endregion

describe('the adapters an ACP step names', () => {
  it('serves the agent from the default filesystem and shell when it names none', async () => {
    const { harness, fs, shell } = twoHosts();
    const connects: AcpConnectOptions[] = [];
    await execute(coder(recordingAgent(connects)), undefined, harness.createContext());
    expect(connects[0]?.host.fs).toBe(fs.laptop);
    expect(connects[0]?.host.shell).toBe(shell.laptop);
    expect(connects[0]?.subprocess?.adapters).toBe(harness.adapters.subprocess);
    expect(connects[0]?.subprocess?.name).toBeUndefined();
  });

  it('serves the agent from the filesystem and shell it names', async () => {
    const { harness, fs, shell } = twoHosts();
    const connects: AcpConnectOptions[] = [];
    const ctx = harness.createContext();
    await execute(
      coder(recordingAgent(connects), {
        subprocess: 'builder',
        fs: 'builder',
        shell: 'builder',
      }),
      undefined,
      ctx,
    );
    expect(connects[0]?.host.fs).toBe(fs.builder);
    expect(connects[0]?.host.shell).toBe(shell.builder);
    expect(connects[0]?.subprocess?.name).toBe('builder');
    // The run's own adapters are still the defaults.
    expect(ctx.fs).toBe(fs.laptop);
    expect(ctx.itemLog.items.length).toBeGreaterThan(0);
  });

  it.each([
    'subprocess',
    'fs',
    'shell',
  ] as const)('fails an unknown %s name before the agent starts', async (kind) => {
    const { harness } = twoHosts();
    const connects: AcpConnectOptions[] = [];
    const error = await execute(
      coder(recordingAgent(connects), {
        [kind]: 'cloud',
      }),
      undefined,
      harness.createContext(),
    ).catch((e: unknown) => e);
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('ADAPTER_UNKNOWN');
    expect(error.message).toContain("'laptop', 'builder'");
    expect(connects).toHaveLength(0);
  });

  it("fails an unknown name its agent's preset gives", async () => {
    const { harness } = twoHosts();
    const connects: AcpConnectOptions[] = [];
    const error = await execute(
      coder(
        recordingAgent(connects, {
          subprocess: 'cloud',
        }),
      ),
      undefined,
      harness.createContext(),
    ).catch((e: unknown) => e);
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('ADAPTER_UNKNOWN');
    expect(connects).toHaveLength(0);
  });
});

describe('a session shared by steps', () => {
  const session = {
    reuse: 'bugfix',
    keepAlive: 'harness',
  } as const;

  async function connectsOf(names: ReadonlyArray<Names>, preset?: string): Promise<number> {
    const { harness } = twoHosts();
    const connects: AcpConnectOptions[] = [];
    const agent = recordingAgent(connects, {
      subprocess: preset,
    });
    const ctx = harness.createContext();
    for (const each of names) {
      await execute(
        coder(agent, {
          ...each,
          session,
        }),
        undefined,
        ctx,
      );
    }
    await harness.close();
    return connects.length;
  }

  it('is one connection for steps that resolve to the same adapters', async () => {
    expect(
      await connectsOf([
        {},
        {
          subprocess: 'laptop',
          fs: 'laptop',
          shell: 'laptop',
        },
      ]),
    ).toBe(1);
  });

  it.each([
    'subprocess',
    'fs',
    'shell',
  ] as const)('is a connection each for steps that name a different %s', async (kind) => {
    expect(
      await connectsOf([
        {},
        {
          [kind]: 'builder',
        },
        {
          [kind]: 'builder',
        },
      ]),
    ).toBe(2);
  });

  it("counts the adapter the agent's preset names", async () => {
    // The preset's `builder` and a step's `builder` are the same adapter; `laptop` is not.
    expect(
      await connectsOf(
        [
          {},
          {
            subprocess: 'builder',
          },
          {
            subprocess: 'laptop',
          },
        ],
        'builder',
      ),
    ).toBe(2);
  });
});

describe('a resumed step whose agent outlived its host', () => {
  it('reattaches through the adapter the agent was started through', async () => {
    const storage = createInMemoryStorage();
    const executionId = await cutOff(storage, {
      subprocess: 'builder',
    });
    const connects: AcpConnectOptions[] = [];
    const output = await resume(
      storage,
      executionId,
      coder(
        recordingAgent(connects, {
          hangs: true,
        }),
        {
          subprocess: 'builder',
        },
      ),
    );
    expect(output).toBe('done');
    expect(connects).toHaveLength(1);
    expect(connects[0]?.reattach).toEqual(HANDLE);
    expect(connects[0]?.subprocess?.name).toBe('builder');
  });

  it('fails, attaching nowhere, when the step now names another adapter', async () => {
    const storage = createInMemoryStorage();
    const executionId = await cutOff(storage);
    const connects: AcpConnectOptions[] = [];
    const error = rootCause(
      await resume(
        storage,
        executionId,
        coder(
          recordingAgent(connects, {
            hangs: true,
          }),
          {
            subprocess: 'builder',
          },
        ),
      ),
    );
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('ACP_SESSION_ADAPTER_CONFLICT');
    expect(error.message).toContain("'laptop'");
    expect(error.message).toContain("'builder'");
    expect(connects).toHaveLength(0);
  });

  it("fails when the agent's preset now names another adapter", async () => {
    const storage = createInMemoryStorage();
    const executionId = await cutOff(storage);
    const connects: AcpConnectOptions[] = [];
    const error = rootCause(
      await resume(
        storage,
        executionId,
        coder(
          recordingAgent(connects, {
            hangs: true,
            subprocess: 'builder',
          }),
        ),
      ),
    );
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('ACP_SESSION_ADAPTER_CONFLICT');
    expect(connects).toHaveLength(0);
  });

  it('leaves the record, so a resume through the first adapter still reattaches', async () => {
    const storage = createInMemoryStorage();
    const executionId = await cutOff(storage);
    await resume(
      storage,
      executionId,
      coder(recordingAgent([]), {
        subprocess: 'builder',
      }),
    );
    const connects: AcpConnectOptions[] = [];
    const output = await resume(
      storage,
      executionId,
      coder(
        recordingAgent(connects, {
          hangs: true,
        }),
      ),
    );
    expect(output).toBe('done');
    expect(connects[0]?.reattach).toEqual(HANDLE);
  });
});
