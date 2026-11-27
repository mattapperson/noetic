// Recovery of ACP prompts and their bridged tool calls.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type {
  AcpAgent,
  AcpAgentConnection,
  AcpPromptOptions,
  AcpSession,
  AcpToolResult,
  AcpTurnResult,
  HeldCall,
  Tool,
} from '@noetic-tools/types';
import { isNoeticError } from '@noetic-tools/types';
import { z } from 'zod';
import { runCode, step } from '../../src/builders/step-builders';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { BridgedCallRecords } from '../../src/interpreter/acp-resume';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { makeMessage } from '../_helpers';

//#region Fixtures

interface Call {
  name: string;
  args: unknown;
}

/** What one process's agent saw and did. */
interface AgentLog {
  newSessions: number;
  loaded: string[];
  prompts: string[];
  results: AcpToolResult[];
}

function agentLog(): AgentLog {
  return {
    newSessions: 0,
    loaded: [],
    prompts: [],
    results: [],
  };
}

function promptText(prompt: AcpPromptOptions): string {
  return prompt.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

/**
 * An agent that makes `calls` through the tool bridge and answers `done`. With
 * `diesAfter`, its process hangs for good once it has made that many calls, as a
 * host that was killed leaves it.
 */
function agent(opts: {
  log: AgentLog;
  calls: Call[];
  diesAfter?: number;
  canLoad?: boolean;
  kept?: boolean;
  stableIds?: boolean;
  earlyCall?: boolean;
}): AcpAgent {
  const { log } = opts;
  let made = 0;
  return {
    specificationVersion: 'acp-v1',
    agentId: 'fake-coder',
    async connect(connect): Promise<AcpAgentConnection> {
      const finish = async (): Promise<AcpTurnResult> => {
        const tools = connect.host.tools;
        assert(tools);
        for (const call of opts.calls) {
          if (made === opts.diesAfter) {
            await new Promise(() => {});
          }
          made += 1;
          log.results.push(
            await tools.call({
              ...call,
              ...(opts.stableIds
                ? {
                    agentCallId: `call-${made}`,
                  }
                : {}),
              signal: new AbortController().signal,
            }),
          );
        }
        if (made === opts.diesAfter) {
          await new Promise(() => {});
        }
        return {
          stopReason: 'end_turn',
          items: [
            makeMessage('assistant', 'done'),
          ],
          text: 'done',
        };
      };
      const session = (sessionId: string): AcpSession => ({
        sessionId,
        availableCommands: [],
        async prompt(prompt) {
          log.prompts.push(promptText(prompt));
          return finish();
        },
        async cancel() {},
        async setMode() {},
        async setModel() {},
      });
      return {
        agentCapabilities: {
          loadSession: opts.canLoad !== false,
        },
        authMethods: [],
        protocolVersion: 1,
        fingerprintFor: (): string => 'fake',
        async authenticate() {},
        async newSession() {
          log.newSessions += 1;
          return session(`s-${crypto.randomUUID()}`);
        },
        async loadSession(load) {
          log.loaded.push(load.sessionId);
          return session(load.sessionId);
        },
        ...(opts.kept
          ? {
              reattach: {
                keeper: 'fixture',
              },
              async attachSession(sessionId: string) {
                const running = opts.earlyCall ? finish() : undefined;
                if (running) {
                  await until(() => log.results.length > 0);
                }
                return {
                  ...session(sessionId),
                  resumeTurn: async ({ promptId }) => ({
                    ...(await (running ?? finish())),
                    promptId,
                  }),
                };
              },
              async detach() {},
            }
          : {}),
        async close() {},
      };
    },
  };
}

/** A tool that counts its runs and answers with which run it was. */
function counted(name: string, runs: string[], opts: Pick<Tool, 'durable' | 'needsApproval'> = {}) {
  return tool({
    name,
    description: `Do ${name}.`,
    input: z.object({
      file: z.string(),
    }),
    output: z.string(),
    ...opts,
    execute: async ({ file }) => {
      runs.push(`${name}:${file}`);
      return `${name} ${file} #${runs.length}`;
    },
  });
}

const THREE: Call[] = [
  {
    name: 'write',
    args: {
      file: 'a.ts',
    },
  },
  {
    name: 'write',
    args: {
      file: 'b.ts',
    },
  },
  {
    name: 'test',
    args: {
      file: 'all',
    },
  },
];

function harnessOn(storage: StorageAdapter): AgentHarness {
  return new AgentHarness({
    name: 'acp-resume',
    params: {},
    environment: {
      storage: {
        adapter: storage,
      },
    },
  });
}

function coder(acpAgent: AcpAgent, tools: Tool[], keyed = false) {
  return step.acpAgent({
    id: 'code',
    agent: acpAgent,
    prompt: 'Add the feature.',
    tools,
    ...(keyed
      ? {
          execution: {
            replayKey: () => 'job',
          },
        }
      : {}),
  });
}

async function until(done: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 2e3; i += 1) {
    if (await done()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert(await done());
}

/**
 * Runs the step until the first agent's process hangs after two of its three
 * calls. Resolves the execution id to resume.
 */
async function cutOff({
  storage,
  tools,
  log,
  kept = false,
  stableIds = false,
}: {
  storage: StorageAdapter;
  tools: Tool[];
  log: AgentLog;
  kept?: boolean;
  stableIds?: boolean;
}): Promise<string> {
  const first = harnessOn(storage);
  const ctx = first.createContext();
  const code = coder(
    agent({
      log,
      calls: THREE,
      diesAfter: 2,
      kept,
      stableIds,
    }),
    tools,
    kept,
  );
  const target = kept
    ? runCode({
        id: 'first-worker',
        execute: async (_input, ctx) => ctx.harness.run(code, undefined, ctx),
      })
    : code;
  void first.run(target, undefined, ctx).catch(() => {});
  await until(() => log.results.length === 2);
  return ctx.id;
}

async function resume(opts: {
  storage: StorageAdapter;
  executionId: string;
  acpAgent: AcpAgent;
  tools: Tool[];
  moved?: boolean;
}): Promise<{
  harness: AgentHarness;
  running: Promise<unknown>;
}> {
  const harness = harnessOn(opts.storage);
  const ctx = await harness.restore(opts.executionId);
  assert(ctx);
  return {
    harness,
    running: harness.run(
      opts.moved
        ? runCode({
            id: 'second-worker',
            execute: async (_input, ctx) =>
              ctx.harness.run(coder(opts.acpAgent, opts.tools, true), undefined, ctx),
          })
        : coder(opts.acpAgent, opts.tools),
      undefined,
      ctx,
    ),
  };
}

/** The first call the execution holds, once it holds one. */
async function heldCall(harness: AgentHarness, executionId: string): Promise<HeldCall> {
  let held: HeldCall | undefined;
  await until(async () => {
    [held] = await harness.pending({
      executionId,
    });
    return held !== undefined;
  });
  assert(held);
  return held;
}

//#endregion

describe('ACP prompt recovery', () => {
  it('cannot assign an interrupted anonymous call to a redelivery by arrival order', async () => {
    const harness = harnessOn(
      createInMemoryStorage({
        swap: true,
      }),
    );
    const opts = {
      ctx: harness.createContext(),
      stepId: 'code',
      tool: counted('write', [], {
        durable: true,
      }),
      wireName: 'write',
      args: {
        file: 'a.ts',
      },
    };
    try {
      const first = new BridgedCallRecords();
      first.bind('/work', 'fresh');
      await first.recordFor(opts);

      const resumed = new BridgedCallRecords();
      resumed.bind('/work', 'resume');
      await expect(resumed.recordFor(opts)).rejects.toMatchObject({
        noeticError: {
          kind: 'acp_outcome_unknown',
        },
      });
    } finally {
      await harness.close();
    }
  });

  it('keeps distinct holds for equal tool inputs redelivered in reverse order', async () => {
    const harness = harnessOn(
      createInMemoryStorage({
        swap: true,
      }),
    );
    const opts = {
      ctx: harness.createContext(),
      stepId: 'code',
      tool: counted('write', [], {
        durable: true,
      }),
      wireName: 'write',
      args: {
        file: 'a.ts',
      },
    };
    try {
      const first = new BridgedCallRecords();
      first.bind('/work', 'fresh');
      const a = await first.recordFor({
        ...opts,
        agentCallId: 'a',
      });
      const b = await first.recordFor({
        ...opts,
        agentCallId: 'b',
      });
      expect(a.id).not.toBe(b.id);

      const second = new BridgedCallRecords();
      second.bind('/work', 'resume');
      expect(
        (
          await second.recordFor({
            ...opts,
            agentCallId: 'b',
          })
        ).id,
      ).toBe(b.id);
      expect(
        (
          await second.recordFor({
            ...opts,
            agentCallId: 'a',
          })
        ).id,
      ).toBe(a.id);
      await expect(
        second.recordFor({
          ...opts,
          agentCallId: 'a',
          args: {
            file: 'other',
          },
        }),
      ).rejects.toMatchObject({
        noeticError: {
          kind: 'acp_outcome_unknown',
        },
      });
    } finally {
      await harness.close();
    }
  });

  it('does not dispatch a moved keyed step with an unresolved legacy intent', async () => {
    const storage = createInMemoryStorage();
    const first = harnessOn(storage);
    const ctx = first.createContext();
    await first.checkpoint(ctx);
    await storage.set(`execution:${ctx.id}:pending:/old-worker#0/code#0/acp-session`, {
      sessionId: 'old',
      agentId: 'fake-coder',
      reattach: {
        keeper: 'fixture',
      },
    });
    const log = agentLog();
    const { running, harness } = await resume({
      storage,
      executionId: ctx.id,
      acpAgent: agent({
        log,
        calls: [],
        kept: true,
      }),
      tools: [],
      moved: true,
    });
    try {
      await expect(running).rejects.toMatchObject({
        noeticError: {
          kind: 'acp_outcome_unknown',
        },
      });
      expect(log.newSessions).toBe(0);
      expect(log.prompts).toEqual([]);
    } finally {
      await Promise.all([
        first.close(),
        harness.close(),
      ]);
    }
  });

  it.each([
    true,
    false,
  ])('stops when the original prompt is gone (load support: %s)', async (canLoad) => {
    const storage = createInMemoryStorage();
    const runs: string[] = [];
    const tools = [
      counted('write', runs),
      counted('test', runs),
    ];
    const executionId = await cutOff({
      storage,
      tools,
      log: agentLog(),
    });
    const log = agentLog();
    const { running } = await resume({
      storage,
      executionId,
      acpAgent: agent({
        log,
        calls: THREE,
        canLoad,
      }),
      tools,
    });
    const error = await running.catch((error: unknown) => error);
    assert(isNoeticError(error));
    expect(error.noeticError.kind).toBe('acp_outcome_unknown');
    expect(log.loaded).toEqual([]);
    expect(log.newSessions).toBe(0);
    expect(log.prompts).toEqual([]);
    expect(runs).toEqual([
      'write:a.ts',
      'write:b.ts',
    ]);
  });

  it.each([
    true,
    false,
  ])('checks redelivered tool results against their call IDs (stable: %s)', async (stableIds) => {
    const storage = createInMemoryStorage();
    const runs: string[] = [];
    const tools = [
      counted('write', runs, {
        durable: true,
      }),
      counted('test', runs),
    ];
    const executionId = await cutOff({
      storage,
      tools,
      log: agentLog(),
      kept: true,
      stableIds,
    });
    const log = agentLog();
    const { running, harness } = await resume({
      storage,
      executionId,
      acpAgent: agent({
        log,
        calls: THREE,
        kept: true,
        stableIds,
        earlyCall: true,
      }),
      tools,
      moved: true,
    });
    try {
      if (!stableIds) {
        await expect(running).rejects.toMatchObject({
          noeticError: {
            kind: 'acp_outcome_unknown',
          },
        });
        expect(runs).toEqual([
          'write:a.ts',
          'write:b.ts',
        ]);
        return;
      }
      expect(await running).toBe('done');
      expect(log.results.map((result) => result.output)).toEqual([
        'write a.ts #1',
        'write b.ts #2',
        'test all #3',
      ]);
      expect(runs).toEqual([
        'write:a.ts',
        'write:b.ts',
        'test:all',
      ]);
    } finally {
      await harness.close();
    }
  });

  it('clears the pending session after a completed step', async () => {
    const storage = createInMemoryStorage();
    const harness = harnessOn(storage);
    const ctx = harness.createContext();
    const tools = [
      counted('write', []),
      counted('test', []),
    ];
    expect(
      await harness.run(
        coder(
          agent({
            log: agentLog(),
            calls: THREE,
          }),
          tools,
        ),
        undefined,
        ctx,
      ),
    ).toBe('done');
    const keys = await storage.list(`execution:${ctx.id}:pending:`);
    expect(keys.some((key) => key.endsWith('/acp-session'))).toBe(false);
  });
});

describe('a `durable: true` tool an agent was inside when its host died', () => {
  it('is held for a person on resume, and their answer goes to the agent', async () => {
    const storage = createInMemoryStorage();
    const attempts: string[] = [];
    let hung = false;
    const deploy = tool({
      name: 'deploy',
      description: 'Deploy the build.',
      input: z.object({
        file: z.string(),
      }),
      output: z.string(),
      durable: true,
      execute: async ({ file }) => {
        attempts.push(file);
        if (!hung) {
          hung = true;
          await new Promise(() => {});
        }
        return `deployed ${file}`;
      },
    });
    const calls: Call[] = [
      {
        name: 'deploy',
        args: {
          file: 'build-7',
        },
      },
    ];
    const first = harnessOn(storage);
    const ctx = first.createContext();
    void first
      .run(
        coder(
          agent({
            log: agentLog(),
            calls,
            kept: true,
            stableIds: true,
          }),
          [
            deploy,
          ],
        ),
        undefined,
        ctx,
      )
      .catch(() => {});
    await until(() => attempts.length === 1);

    const after = agentLog();
    const { harness, running } = await resume({
      storage,
      executionId: ctx.id,
      acpAgent: agent({
        log: after,
        calls,
        kept: true,
        stableIds: true,
      }),
      tools: [
        deploy,
      ],
    });
    const held = await heldCall(harness, ctx.id);
    expect(held).toMatchObject({
      name: 'deploy',
      reason: 'outcome',
      args: {
        file: 'build-7',
      },
    });
    // The person looked: the deploy went out.
    await harness.resolveHeld(
      {
        executionId: ctx.id,
      },
      {
        callId: held.callId,
        output: 'deployed build-7',
      },
    );
    expect(await running).toBe('done');
    expect(attempts).toEqual([
      'build-7',
    ]);
    expect(after.prompts).toEqual([]);
    expect(after.results).toEqual([
      {
        output: 'deployed build-7',
        isError: false,
      },
    ]);
    expect(
      await harness.pending({
        executionId: ctx.id,
      }),
    ).toEqual([]);
  });
});

describe('a bridged tool that needs approval, with no approver', () => {
  it('is held while the agent waits, and runs once a person allows it', async () => {
    const runs: string[] = [];
    const harness = new AgentHarness({
      name: 'acp-resume',
      params: {},
    });
    const ctx = harness.createContext();
    const log = agentLog();
    const running = harness.run(
      coder(
        agent({
          log,
          calls: [
            {
              name: 'write',
              args: {
                file: 'a.ts',
              },
            },
          ],
        }),
        [
          counted('write', runs, {
            needsApproval: true,
          }),
        ],
      ),
      undefined,
      ctx,
    );
    const held = await heldCall(harness, ctx.id);
    expect(held).toMatchObject({
      name: 'write',
      reason: 'approval',
    });
    expect(runs).toEqual([]);

    await harness.resolveHeld(
      {
        executionId: ctx.id,
      },
      {
        callId: held.callId,
        action: 'allow',
      },
    );
    expect(await running).toBe('done');
    expect(runs).toEqual([
      'write:a.ts',
    ]);
    expect(log.results[0]?.output).toBe('write a.ts #1');
  });

  it('answers the agent with the refusal when the person denies it', async () => {
    const runs: string[] = [];
    const harness = new AgentHarness({
      name: 'acp-resume',
      params: {},
    });
    const ctx = harness.createContext();
    const log = agentLog();
    const running = harness.run(
      coder(
        agent({
          log,
          calls: [
            {
              name: 'write',
              args: {
                file: 'a.ts',
              },
            },
          ],
        }),
        [
          counted('write', runs, {
            needsApproval: true,
          }),
        ],
      ),
      undefined,
      ctx,
    );
    const held = await heldCall(harness, ctx.id);
    await harness.resolveHeld(
      {
        executionId: ctx.id,
      },
      {
        callId: held.callId,
        action: 'deny',
        guidance: 'not in this repo',
      },
    );
    await running;
    expect(runs).toEqual([]);
    expect(log.results[0]?.isError).toBe(true);
    expect(log.results[0]?.output).toContain('not in this repo');
  });
});
