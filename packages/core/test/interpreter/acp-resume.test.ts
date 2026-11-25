// A resumed ACP step: it reloads the agent's own session when the agent can, and
// a tool call the agent makes again gets the result it got the first time. See
// specs/27-acp-agent-steps § Resuming a step.

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
import { frameworkCast, isNoeticError } from '@noetic-tools/types';
import { z } from 'zod';
import { step } from '../../src/builders/step-builders';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { ACP_RESUME_NOTICE } from '../../src/interpreter/acp-resume';
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
  /** The session ids this agent still has. Loading any other fails. */
  has?: string[];
  /** The load fails some way other than "no such session". */
  loadCrashes?: boolean;
}): AcpAgent {
  const { log } = opts;
  let made = 0;
  return {
    specificationVersion: 'acp-v1',
    agentId: 'fake-coder',
    async connect(connect): Promise<AcpAgentConnection> {
      const session = (sessionId: string): AcpSession => ({
        sessionId,
        availableCommands: [],
        async prompt(prompt): Promise<AcpTurnResult> {
          log.prompts.push(promptText(prompt));
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
                // A new id every time: an agent that makes a call again does not reuse one.
                agentCallId: `call-${crypto.randomUUID()}`,
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
          if (opts.loadCrashes) {
            throw new Error('the agent crashed while loading');
          }
          if (opts.has && !opts.has.includes(load.sessionId)) {
            // JSON-RPC "resource not found": the agent no longer has it.
            throw {
              code: -32002,
              message: `Resource not found: ${load.sessionId}`,
            };
          }
          // The agent replays the session's conversation while it loads.
          connect.host.onSessionUpdate({
            sessionId: load.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'what I said before the crash',
              },
            },
          });
          log.loaded.push(load.sessionId);
          return session(load.sessionId);
        },
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

function coder(acpAgent: AcpAgent, tools: Tool[]) {
  return step.acpAgent({
    id: 'code',
    agent: acpAgent,
    prompt: 'Add the feature.',
    tools,
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
async function cutOff(storage: StorageAdapter, tools: Tool[], log: AgentLog): Promise<string> {
  const first = harnessOn(storage);
  const ctx = first.createContext();
  void first
    .run(
      coder(
        agent({
          log,
          calls: THREE,
          diesAfter: 2,
        }),
        tools,
      ),
      undefined,
      ctx,
    )
    .catch(() => {});
  await until(() => log.results.length === 2);
  return ctx.id;
}

interface RecordedEvent {
  type: string;
  data: Record<string, unknown>;
}

async function resume(opts: {
  storage: StorageAdapter;
  executionId: string;
  acpAgent: AcpAgent;
  tools: Tool[];
  /** Records every event the resumed step emits. */
  events?: RecordedEvent[];
}): Promise<{
  harness: AgentHarness;
  running: Promise<unknown>;
}> {
  const harness = harnessOn(opts.storage);
  const ctx = await harness.restore(opts.executionId);
  assert(ctx);
  const events = opts.events;
  if (events) {
    frameworkCast<{
      _broadcaster: unknown;
    }>(ctx)._broadcaster = {
      emit(event: RecordedEvent) {
        events.push(event);
      },
    };
  }
  return {
    harness,
    running: harness.run(coder(opts.acpAgent, opts.tools), undefined, ctx),
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

describe('an ACP step resumed after its host died', () => {
  it('reloads the agent’s session, and a call the agent makes again is not run again', async () => {
    const storage = createInMemoryStorage();
    const runs: string[] = [];
    const tools = [
      counted('write', runs),
      counted('test', runs),
    ];
    const before = agentLog();
    const executionId = await cutOff(storage, tools, before);
    expect(before.newSessions).toBe(1);
    expect(runs).toEqual([
      'write:a.ts',
      'write:b.ts',
    ]);

    // A new process. The agent has its session back, knows the two writes are
    // done, and writes a.ts once more on purpose before running the tests.
    const after = agentLog();
    const events: RecordedEvent[] = [];
    const { running } = await resume({
      storage,
      executionId,
      events,
      acpAgent: agent({
        log: after,
        calls: [
          {
            name: 'write',
            args: {
              file: 'a.ts',
            },
          },
          {
            name: 'test',
            args: {
              file: 'all',
            },
          },
        ],
      }),
      tools,
    });
    expect(await running).toBe('done');

    expect(after.newSessions).toBe(0);
    expect(after.loaded).toHaveLength(1);
    // What the agent replayed while it loaded is its history, never new output.
    expect(JSON.stringify(events)).not.toContain('what I said before the crash');
    const deltas = events
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => String(e.data.delta));
    expect(deltas.join('')).not.toContain('what I said before the crash');
    // It is told it was cut off, and given the task again.
    expect(after.prompts).toHaveLength(1);
    expect(after.prompts[0]).toContain(ACP_RESUME_NOTICE);
    expect(after.prompts[0]).toContain('Add the feature.');
    expect(after.prompts[0]).not.toContain('what I said before the crash');

    // A reloaded agent's call is a new call, even with a tool and arguments it
    // used before: it runs, and is not answered with the old result.
    expect(runs).toEqual([
      'write:a.ts',
      'write:b.ts',
      'write:a.ts',
      'test:all',
    ]);
    expect(after.results.map((result) => result.output)).toEqual([
      'write a.ts #3',
      'test all #4',
    ]);
  });

  it('starts a new session when the agent cannot reload one, and still repeats no call', async () => {
    const storage = createInMemoryStorage();
    const runs: string[] = [];
    const tools = [
      counted('write', runs),
      counted('test', runs),
    ];
    const executionId = await cutOff(storage, tools, agentLog());

    const after = agentLog();
    const { running } = await resume({
      storage,
      executionId,
      acpAgent: agent({
        log: after,
        calls: THREE,
        canLoad: false,
      }),
      tools,
    });
    expect(await running).toBe('done');
    expect(after.loaded).toEqual([]);
    expect(after.newSessions).toBe(1);
    expect(after.prompts[0]).not.toContain(ACP_RESUME_NOTICE);
    expect(runs).toEqual([
      'write:a.ts',
      'write:b.ts',
      'test:all',
    ]);
  });

  it('starts a new session when the agent no longer has the old one', async () => {
    const storage = createInMemoryStorage();
    const runs: string[] = [];
    const tools = [
      counted('write', runs),
      counted('test', runs),
    ];
    const executionId = await cutOff(storage, tools, agentLog());

    const after = agentLog();
    const { running } = await resume({
      storage,
      executionId,
      acpAgent: agent({
        log: after,
        calls: THREE,
        has: [],
      }),
      tools,
    });
    expect(await running).toBe('done');
    expect(after.loaded).toEqual([]);
    expect(after.newSessions).toBe(1);
    expect(after.prompts[0]).not.toContain(ACP_RESUME_NOTICE);
  });

  it('fails rather than start the work over when the load fails another way', async () => {
    const storage = createInMemoryStorage();
    const runs: string[] = [];
    const tools = [
      counted('write', runs),
      counted('test', runs),
    ];
    const executionId = await cutOff(storage, tools, agentLog());

    const after = agentLog();
    const { running } = await resume({
      storage,
      executionId,
      acpAgent: agent({
        log: after,
        calls: THREE,
        loadCrashes: true,
      }),
      tools,
    });
    const error = await running.catch((e: unknown) => e);
    assert(isNoeticError(error));
    expect(error.noeticError.kind).toBe('step_failed');
    expect(after.newSessions).toBe(0);
    expect(after.prompts).toEqual([]);
  });

  it('runs a call the agent makes differently this time', async () => {
    const storage = createInMemoryStorage();
    const runs: string[] = [];
    const tools = [
      counted('write', runs),
      counted('test', runs),
    ];
    const executionId = await cutOff(storage, tools, agentLog());

    const { running } = await resume({
      storage,
      executionId,
      acpAgent: agent({
        log: agentLog(),
        canLoad: false,
        calls: [
          {
            name: 'write',
            args: {
              file: 'a.ts',
            },
          },
          {
            name: 'write',
            args: {
              file: 'c.ts',
            },
          },
        ],
      }),
      tools,
    });
    await running;
    expect(runs).toEqual([
      'write:a.ts',
      'write:b.ts',
      'write:c.ts',
    ]);
  });

  it('tells two equal calls apart by their order', async () => {
    const storage = createInMemoryStorage();
    const runs: string[] = [];
    const tools = [
      counted('write', runs),
    ];
    const twice: Call[] = [
      {
        name: 'write',
        args: {
          file: 'a.ts',
        },
      },
      {
        name: 'write',
        args: {
          file: 'a.ts',
        },
      },
      {
        name: 'write',
        args: {
          file: 'a.ts',
        },
      },
    ];
    const first = harnessOn(storage);
    const ctx = first.createContext();
    const before = agentLog();
    void first
      .run(
        coder(
          agent({
            log: before,
            calls: twice,
            diesAfter: 2,
          }),
          tools,
        ),
        undefined,
        ctx,
      )
      .catch(() => {});
    await until(() => before.results.length === 2);

    const after = agentLog();
    const { running } = await resume({
      storage,
      executionId: ctx.id,
      acpAgent: agent({
        log: after,
        canLoad: false,
        calls: twice,
      }),
      tools,
    });
    await running;
    // The first two are replayed, each with its own result; the third runs.
    expect(runs).toHaveLength(3);
    expect(after.results.map((result) => result.output)).toEqual([
      'write a.ts #1',
      'write a.ts #2',
      'write a.ts #3',
    ]);
  });

  it('runs a `durable: false` tool again: nothing was recorded for it', async () => {
    const storage = createInMemoryStorage();
    const runs: string[] = [];
    const tools = [
      counted('write', runs, {
        durable: false,
      }),
      counted('test', runs),
    ];
    const executionId = await cutOff(storage, tools, agentLog());
    const { running } = await resume({
      storage,
      executionId,
      acpAgent: agent({
        log: agentLog(),
        calls: THREE,
      }),
      tools,
    });
    await running;
    expect(runs).toEqual([
      'write:a.ts',
      'write:b.ts',
      'write:a.ts',
      'write:b.ts',
      'test:all',
    ]);
  });

  it('forgets the session once the step has finished', async () => {
    const storage = createInMemoryStorage();
    const runs: string[] = [];
    const tools = [
      counted('write', runs),
      counted('test', runs),
    ];
    const executionId = await cutOff(storage, tools, agentLog());
    const kept = await storage.list(`execution:${executionId}:pending:`);
    expect(kept.filter((key) => key.endsWith('/acp-session'))).toHaveLength(1);

    const { running } = await resume({
      storage,
      executionId,
      acpAgent: agent({
        log: agentLog(),
        calls: THREE,
      }),
      tools,
    });
    await running;
    const left = await storage.list(`execution:${executionId}:pending:`);
    expect(left.filter((key) => key.endsWith('/acp-session'))).toEqual([]);
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
