/**
 * A resumed ACP step reattaches to the agent its earlier host left running,
 * when the agent outlived that host: it collects the turn in flight — every
 * update of it, then its result — instead of prompting again, and falls back
 * to reloading or starting over when the agent is gone.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type {
  AcpAgent,
  AcpAgentConnection,
  AcpConnectOptions,
  AcpPromptOptions,
  AcpSession,
  AcpToolHost,
  AcpTurnResult,
  AcpWhenHostExits,
  ContextData,
} from '@noetic-tools/types';
import {
  AcpConnectError,
  frameworkCast,
  isNoeticConfigError,
  isNoeticError,
  NoeticErrorImpl,
  SteeringAction,
} from '@noetic-tools/types';
import { z } from 'zod';
import { inParallel } from '../../src/builders/control-flow-builders';
import { runCode, step } from '../../src/builders/step-builders';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { ACP_RESUME_NOTICE } from '../../src/interpreter/acp-resume';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { makeLayer, makeMessage } from '../_helpers';

//#region Fixtures

const HANDLE = {
  kind: 'test-keeper',
  address: 'kept-agent-1',
};

interface Seen {
  connects: AcpConnectOptions[];
  newSessions: number;
  prompts: string[];
  /** How each reattached connection was released: closed (agent stopped) or let go. */
  released: Array<'closed' | 'detached'>;
}

function seen(): Seen {
  return {
    connects: [],
    newSessions: 0,
    prompts: [],
    released: [],
  };
}

function promptText(prompt: AcpPromptOptions): string {
  return prompt.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

function result(text: string): AcpTurnResult {
  return {
    stopReason: 'end_turn',
    items: [
      makeMessage('assistant', text),
    ],
    text,
  };
}

/**
 * An agent that can be reattached. A first connection's prompt never ends (its
 * host dies); a reattached one collects `collected`, or nothing (`undefined`:
 * no turn was running), and a prompt after that answers `prompted`.
 */
function keptAgent(opts: {
  seen: Seen;
  collected?: string;
  collectedPromptId?: string;
  /** What the first host gets before it can commit its step. */
  first?: 'link-lost' | 'rpc-error' | 'answered';
  cutGuidance?: boolean;
  onConnect?: (tools: AcpToolHost | undefined) => Promise<void>;
  onPrompt?: (tools: AcpToolHost | undefined, number: number) => Promise<void>;
  onCollect?: (tools: AcpToolHost | undefined, promptId?: string) => Promise<void>;
  /** The agent is gone: reattaching fails with `AcpConnectError`. */
  gone?: boolean;
  /** Reattaching fails some other way: the old turn may still be there. */
  broken?: boolean;
  /** What its sessions are opened with, and what it would open one with now. */
  fingerprint?: string;
}): AcpAgent {
  return {
    specificationVersion: 'acp-v1',
    agentId: 'kept',
    async connect(connect): Promise<AcpAgentConnection> {
      opts.seen.connects.push(connect);
      await opts.onConnect?.(connect.host.tools);
      if (connect.reattach && opts.gone) {
        throw new AcpConnectError({
          agentId: 'kept',
          message: 'the keeper is gone',
          gone: true,
        });
      }
      if (connect.reattach && opts.broken) {
        // A connect failure that says nothing about whether the agent still runs.
        throw new AcpConnectError({
          agentId: 'kept',
          message: 'the keeper socket refused this user',
        });
      }
      const session = (sessionId: string, reattached: boolean): AcpSession => ({
        sessionId,
        ...(opts.fingerprint === undefined || reattached
          ? {}
          : {
              fingerprint: opts.fingerprint,
            }),
        availableCommands: [],
        async prompt(prompt) {
          opts.seen.prompts.push(promptText(prompt));
          await opts.onPrompt?.(connect.host.tools, opts.seen.prompts.length);
          if (!reattached) {
            if (opts.cutGuidance && opts.seen.prompts.length === 2) {
              throw new AcpConnectError({
                agentId: 'kept',
                message: 'runner socket dropped',
              });
            }
            if (opts.first === 'link-lost') {
              throw new AcpConnectError({
                agentId: 'kept',
                message: 'runner socket dropped',
              });
            }
            if (opts.first === 'rpc-error') {
              throw {
                code: -32603,
                message: 'lost result after writing',
              };
            }
            if (opts.first === 'answered') {
              return result('original answer');
            }
            // The host dies mid-turn: the turn ends only when the test lets go.
            return await new Promise<AcpTurnResult>((resolve) => {
              prompt.signal?.addEventListener('abort', () =>
                resolve({
                  stopReason: 'cancelled',
                  items: [],
                  text: '',
                }),
              );
            });
          }
          return result('prompted');
        },
        ...(reattached
          ? {
              async resumeTurn({ promptId }) {
                const text = opts.collected;
                if (text === undefined) {
                  return undefined;
                }
                await opts.onCollect?.(connect.host.tools, promptId);
                for (const part of text.split(' ')) {
                  connect.host.onSessionUpdate({
                    sessionId,
                    update: {
                      sessionUpdate: 'agent_message_chunk',
                      content: {
                        type: 'text',
                        text: part,
                      },
                    },
                  });
                }
                return {
                  ...result(text),
                  promptId: opts.collectedPromptId ?? promptId,
                };
              },
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
        fingerprintFor: (): string => opts.fingerprint ?? 'fake',
        reattach: HANDLE,
        async authenticate() {},
        async newSession() {
          opts.seen.newSessions += 1;
          return session('kept-session', false);
        },
        async loadSession(load) {
          return session(load.sessionId, false);
        },
        ...(connect.reattach
          ? {
              async attachSession(sessionId: string) {
                return session(sessionId, true);
              },
            }
          : {}),
        async close() {
          if (connect.reattach) {
            opts.seen.released.push('closed');
          }
        },
        async detach() {
          opts.seen.released.push('detached');
        },
      };
    },
  };
}

function harnessOn(storage: StorageAdapter, killAgentsOnExit?: boolean): AgentHarness {
  return new AgentHarness({
    name: 'acp-reattach',
    params: {},
    killAgentsOnExit,
    environment: {
      storage: {
        adapter: storage,
      },
    },
  });
}

function coder(agent: AcpAgent) {
  return step.acpAgent<ContextData, string, string>({
    id: 'code',
    agent,
    prompt: 'Add the feature.',
  });
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

it.each([
  'received',
  'unseen',
  'wrong',
  'failed-write',
])('recovers a guidance prompt that the keeper reports as %s', async (mode) => {
  const backing = createInMemoryStorage({
    swap: true,
  });
  let refused = false;
  const storage: StorageAdapter = {
    ...backing,
    async swap(key, prev, next) {
      if (
        mode === 'failed-write' &&
        !refused &&
        key.endsWith('/acp-session') &&
        next &&
        typeof next === 'object' &&
        Reflect.get(next, 'guidance')
      ) {
        refused = true;
        throw new Error('lost guidance intent');
      }
      return backing.swap!(key, prev, next);
    },
  };
  let guided = 0;
  const before = seen();
  const after = seen();
  const build = (agent: AcpAgent) =>
    new AgentHarness({
      name: 'steered',
      params: {},
      agentGraph: coder(agent),
      contextLayers: [
        makeLayer('guide', {
          hooks: {
            afterModelCall: async () => ({
              decision: {
                action:
                  mode === 'failed-write' && ++guided > 1
                    ? SteeringAction.Allow
                    : SteeringAction.Guide,
                guidance: 'revise',
              },
            }),
          },
        }),
      ],
      environment: {
        storage: {
          adapter: storage,
          lease: {
            cut: {
              delayMs: 0,
            },
          },
          park: {
            autoWake: false,
          },
        },
      },
    });
  const first = build(
    keptAgent({
      seen: before,
      first: 'answered',
      cutGuidance: true,
    }),
  );
  const second = build(
    keptAgent({
      seen: after,
      collected:
        mode === 'unseen'
          ? undefined
          : mode === 'failed-write'
            ? 'original answer'
            : 'guided answer',
      collectedPromptId: mode === 'wrong' ? 'previous-prompt' : undefined,
    }),
  );
  const delivery = {
    threadId: 'thread',
    messageId: 'start',
  };
  try {
    await first.execute('begin', delivery);
    expect((await first.getAgentResponse(delivery)).cut?.reason).toBe(
      mode === 'failed-write' ? 'ledger_write_failed' : 'acp_link_lost',
    );
    expect(before.prompts).toHaveLength(mode === 'failed-write' ? 1 : 2);
    expect(await second.wake()).toEqual([
      'thread',
    ]);
    if (mode === 'wrong') {
      await expect(second.getAgentResponse(delivery)).rejects.toMatchObject({
        noeticError: {
          kind: 'acp_outcome_unknown',
        },
      });
      expect(after.prompts).toHaveLength(0);
    } else {
      await second.getAgentResponse(delivery);
      expect(after.prompts).toHaveLength(mode === 'failed-write' ? 1 : mode === 'unseen' ? 3 : 2);
      if (mode === 'unseen' || mode === 'failed-write') {
        expect(after.prompts[0]).toContain('revise');
      }
    }
  } finally {
    await Promise.all([
      first.close(),
      second.close(),
    ]);
  }
});

interface GuidanceCalls {
  originalId?: string;
  guidanceId?: string;
  nextId?: string;
  loseIntent?: boolean;
  lateCall?: boolean;
  callOnAttach?: boolean;
  replayOnAttach?: boolean;
  attributed?: boolean;
  redeliver?: boolean;
  answer?: string;
  runs?: number;
}

it.each<
  [
    string,
    GuidanceCalls,
  ]
>([
  [
    'after collecting the original prompt',
    {
      loseIntent: true,
      lateCall: true,
      answer: 'prompted',
    },
  ],
  [
    'unseen guidance',
    {
      answer: 'prompted',
      callOnAttach: true,
    },
  ],
  [
    'unseen guidance after a stable call',
    {
      originalId: 'original',
      answer: 'prompted',
    },
  ],
  [
    'reused ID',
    {
      originalId: 'original',
      nextId: 'original',
      runs: 1,
    },
  ],
  [
    'stable redelivery',
    {
      redeliver: true,
      guidanceId: 'guided',
      answer: 'guided answer',
    },
  ],
  [
    'stable redelivery during attachment',
    {
      redeliver: true,
      replayOnAttach: true,
      guidanceId: 'guided',
      answer: 'guided answer',
    },
  ],
  [
    'first call attributed to the active guidance prompt',
    {
      attributed: true,
      answer: 'guided answer',
    },
  ],
  [
    'anonymous redelivery',
    {
      redeliver: true,
    },
  ],
])('keeps guidance tool calls scoped to their prompt (%s)', async (_name, scenario) => {
  const backing = createInMemoryStorage({
    swap: true,
  });
  const storage: StorageAdapter = {
    ...backing,
    async swap(key, prev, next) {
      if (
        key.endsWith('/acp-session') &&
        next &&
        typeof next === 'object' &&
        Reflect.get(next, 'guidance') !== undefined
      ) {
        if (scenario.loseIntent && !guidedIntentLost) {
          guidedIntentLost = true;
          throw new Error('lost the guidance prompt intent');
        }
        if (scenario.lateCall) {
          expect(after.prompts).toHaveLength(0);
          expect(await call(after.connects[0]?.host.tools)).toMatchObject({
            isError: true,
          });
          expect(runs).toBe(1);
        }
      }
      return backing.swap!(key, prev, next);
    },
  };
  let guidedIntentLost = false;
  let runs = 0;
  const write = tool({
    name: 'write',
    description: 'Write a report.',
    input: z.object({
      file: z.string(),
    }),
    output: z.string(),
    durable: true,
    async execute({ file }) {
      return `${file} #${++runs}`;
    },
  });
  const call = (tools: AcpToolHost | undefined, agentCallId?: string, promptId?: string) => {
    assert(tools);
    return tools.call({
      name: 'write',
      args: {
        file: 'report',
      },
      agentCallId,
      promptId,
      signal: new AbortController().signal,
    });
  };
  const before = seen();
  const after = seen();
  let guided = false;
  const build = (agent: AcpAgent) =>
    new AgentHarness({
      name: 'guidance-tools',
      params: {},
      agentGraph: step.acpAgent({
        id: 'code',
        agent,
        prompt: 'Write the report.',
        tools: [
          write,
        ],
      }),
      contextLayers: [
        makeLayer('guide', {
          hooks: {
            async afterModelCall() {
              const action = guided ? SteeringAction.Allow : SteeringAction.Guide;
              guided = true;
              return {
                decision: {
                  action,
                  guidance: 'Revise the report.',
                },
              };
            },
          },
        }),
      ],
      environment: {
        storage: {
          adapter: storage,
          lease: {
            cut: {
              delayMs: 0,
            },
          },
          park: {
            autoWake: false,
          },
        },
      },
    });
  const first = build(
    keptAgent({
      seen: before,
      first: 'answered',
      cutGuidance: true,
      async onPrompt(tools, number) {
        if (number === 1) {
          await call(tools, scenario.originalId);
        } else if (scenario.redeliver) {
          await call(tools, scenario.guidanceId);
        }
      },
    }),
  );
  const replies: Array<Awaited<ReturnType<typeof call>>> = [];
  const second = build(
    keptAgent({
      seen: after,
      collected: scenario.loseIntent
        ? 'original answer'
        : scenario.redeliver || scenario.attributed
          ? 'guided answer'
          : undefined,
      onConnect:
        scenario.callOnAttach || scenario.replayOnAttach
          ? async (tools) => {
              const reply = await call(tools, scenario.guidanceId);
              if (scenario.replayOnAttach) {
                replies.push(reply);
                expect(runs).toBe(2);
              } else {
                expect(reply).toMatchObject({
                  isError: true,
                });
                expect(runs).toBe(1);
              }
            }
          : undefined,
      async onPrompt(tools) {
        replies.push(await call(tools, scenario.nextId));
      },
      async onCollect(tools, promptId) {
        if (scenario.attributed) {
          assert(promptId);
          expect(await call(tools, undefined, 'another-prompt')).toMatchObject({
            isError: true,
          });
          expect(runs).toBe(1);
          replies.push(await call(tools, undefined, promptId));
        }
        if (scenario.redeliver && !scenario.replayOnAttach) {
          replies.push(await call(tools, scenario.guidanceId));
        }
      },
    }),
  );
  const delivery = {
    threadId: 'thread',
    messageId: 'start',
  };
  try {
    await first.execute('begin', delivery);
    expect((await first.getAgentResponse(delivery)).cut?.reason).toBe(
      scenario.loseIntent ? 'ledger_write_failed' : 'acp_link_lost',
    );
    expect(runs).toBe(scenario.redeliver ? 2 : 1);
    expect(await second.wake()).toEqual([
      'thread',
    ]);
    if (scenario.answer === undefined) {
      await expect(second.getAgentResponse(delivery)).rejects.toMatchObject({
        noeticError: {
          kind: 'acp_outcome_unknown',
        },
      });
    } else {
      expect((await second.getAgentResponse(delivery)).text).toBe(scenario.answer);
      expect(replies).toEqual([
        {
          output: 'report #2',
          isError: false,
        },
      ]);
    }
    expect(after.prompts).toHaveLength(scenario.redeliver || scenario.attributed ? 0 : 1);
    expect(runs).toBe(scenario.runs ?? 2);
  } finally {
    await Promise.all([
      first.close(),
      second.close(),
    ]);
  }
});

/** Run the step until its agent is mid-turn, as a host that then dies leaves it. */
async function cutOff(storage: StorageAdapter, first: Seen, fingerprint?: string): Promise<string> {
  const harness = harnessOn(storage);
  const ctx = harness.createContext();
  const done = harness
    .run(
      coder(
        keptAgent({
          seen: first,
          fingerprint,
        }),
      ),
      '',
      ctx,
    )
    .catch(() => undefined);
  running.push({
    ctx,
    done,
  });
  await until(() => first.prompts.length === 1);
  return ctx.id;
}

interface RecordedEvent {
  type: string;
  data: Record<string, unknown>;
}

async function resume({
  storage,
  executionId,
  agent,
  events,
  keyed,
}: {
  storage: StorageAdapter;
  executionId: string;
  agent: AcpAgent;
  events: RecordedEvent[];
  keyed?: boolean;
}): Promise<unknown> {
  const harness = harnessOn(storage);
  const ctx = await harness.restore(executionId);
  assert(ctx);
  let settle: (value: unknown) => void = () => undefined;
  const done = new Promise<unknown>((resolve) => {
    settle = resolve;
  });
  running.push({
    ctx,
    done,
  });
  frameworkCast<{
    _broadcaster: unknown;
  }>(ctx)._broadcaster = {
    emit(event: RecordedEvent) {
      events.push(event);
    },
  };
  try {
    const step = coder(agent);
    if (keyed) {
      step.execution = {
        replayKey: () => 'batch',
      };
    }
    return await harness.run(step, '', ctx);
  } finally {
    settle(undefined);
  }
}

//#endregion

describe('an ACP step resumed while its agent still runs', () => {
  it.each([
    false,
    true,
  ])('checks that a positional intent belongs to the dispatch (keyed: %s)', async (keyed) => {
    const storage = createInMemoryStorage();
    const first = seen();
    const executionId = await cutOff(storage, first);
    expect(first.connects[0]?.whenHostExits).toBe('keep');

    const after = seen();
    const events: RecordedEvent[] = [];
    const pending = resume({
      storage,
      executionId,
      agent: keptAgent({
        seen: after,
        collected: 'finished while away',
      }),
      events,
      keyed,
    });

    if (keyed) {
      await expect(pending).rejects.toMatchObject({
        noeticError: {
          kind: 'acp_outcome_unknown',
        },
      });
      expect(after.connects).toEqual([]);
      return;
    }
    const output = await pending;
    expect(output).toBe('finished while away');
    expect(after.connects[0]?.reattach).toEqual(HANDLE);
    expect(after.newSessions).toBe(0);
    expect(after.prompts).toEqual([]);
    // The collected turn streams as this step's output.
    const deltas = events
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => String(e.data.delta));
    expect(deltas.join(' ')).toBe('finished while away');
  });

  it('prompts, behind the resume notice, when no turn was running', async () => {
    const storage = createInMemoryStorage();
    const executionId = await cutOff(storage, seen());

    const after = seen();
    const output = await resume({
      storage,
      executionId,
      agent: keptAgent({
        seen: after,
      }),
      events: [],
    });

    expect(output).toBe('prompted');
    expect(after.newSessions).toBe(0);
    expect(after.prompts).toHaveLength(1);
    expect(after.prompts[0]).toContain(ACP_RESUME_NOTICE);
  });

  it('surfaces an unknown outcome without prompting when the agent is gone', async () => {
    const storage = createInMemoryStorage();
    const executionId = await cutOff(storage, seen());

    const after = seen();
    const gone = keptAgent({
      seen: after,
      gone: true,
    });
    const error = await resume({
      storage,
      executionId,
      agent: gone,
      events: [],
    }).catch((e: unknown) => e);
    assert(isNoeticError(error));
    expect(error.noeticError.kind).toBe('acp_outcome_unknown');
    expect(after.connects).toHaveLength(1);
    expect(after.connects[0]?.reattach).toEqual(HANDLE);
    expect(after.newSessions).toBe(0);
    expect(after.prompts).toEqual([]);
  });
});

describe('a durable turn cuts and wakes on the same ACP prompt', () => {
  it.each([
    'acp_link_lost',
    'ledger_write_failed',
  ] as const)('recovers from %s', async (reason) => {
    const backing = createInMemoryStorage({
      swap: true,
    });
    let failWrite = reason === 'ledger_write_failed';
    const storage: StorageAdapter = {
      ...backing,
      async swap(key, prior, next) {
        if (failWrite && key.includes(':ledger:')) {
          failWrite = false;
          throw new Error('storage dropped the completion checkpoint');
        }
        return await backing.swap!(key, prior, next);
      },
    };
    const before = seen();
    const after = seen();
    const build = (holder: string, agent: AcpAgent) =>
      new AgentHarness({
        name: 'acp-recovery',
        params: {},
        agentGraph: coder(agent),
        environment: {
          storage: {
            adapter: storage,
            lease: {
              holder,
              cut: {
                delayMs: 0,
              },
            },
            park: {
              autoWake: false,
            },
          },
        },
      });
    const first = build(
      'first',
      keptAgent({
        seen: before,
        first: reason === 'acp_link_lost' ? 'link-lost' : 'answered',
      }),
    );
    const second = build(
      'second',
      keptAgent({
        seen: after,
        collected: 'original answer',
      }),
    );
    const scope = {
      threadId: 'thread',
    };
    try {
      await first.execute('begin', {
        ...scope,
        messageId: 'start',
      });
      expect((await first.getAgentResponse(scope)).cut?.reason).toBe(reason);
      expect(before.released).toEqual([
        'detached',
      ]);
      expect(before.prompts).toHaveLength(1);
      expect(await second.wake()).toEqual([
        'thread',
      ]);
      expect((await second.getAgentResponse(scope)).text).toBe('original answer');
      expect(after.connects[0]?.reattach).toEqual(HANDLE);
      expect(after.newSessions).toBe(0);
      expect(after.prompts).toEqual([]);
    } finally {
      await Promise.all([
        first.close(),
        second.close(),
      ]);
    }
  });
});

it('does not send a second prompt through a cached shared session after a cut', async () => {
  const backing = createInMemoryStorage({
    swap: true,
  });
  let failWrite = true;
  const storage: StorageAdapter = {
    ...backing,
    async swap(key, prior, next) {
      if (failWrite && key.includes(':ledger:')) {
        failWrite = false;
        throw new Error('storage dropped the completion checkpoint');
      }
      return backing.swap!(key, prior, next);
    },
  };
  const log = seen();
  const agent = keptAgent({
    seen: log,
    first: 'answered',
  });
  const harness = new AgentHarness({
    name: 'shared-recovery',
    params: {},
    agentGraph: {
      ...coder(agent),
      session: {
        keepAlive: 'harness',
        reuse: 'shared',
      },
    },
    environment: {
      storage: {
        adapter: storage,
        lease: {
          cut: {
            delayMs: 0,
          },
        },
        park: {
          autoWake: false,
        },
      },
    },
  });
  const scope = {
    threadId: 'thread',
  };
  try {
    await harness.execute('begin', {
      ...scope,
      messageId: 'start',
    });
    expect((await harness.getAgentResponse(scope)).cut?.reason).toBe('ledger_write_failed');
    expect(await harness.wake(scope)).toEqual([
      'thread',
    ]);
    await expect(harness.getAgentResponse(scope)).rejects.toMatchObject({
      noeticError: {
        kind: 'acp_outcome_unknown',
      },
    });
    expect(log.prompts).toHaveLength(1);
  } finally {
    await harness.close();
  }
});

it.each([
  undefined,
  false,
])('does not retry a dispatched prompt without recovery storage (%s)', async (durable) => {
  const harness = new AgentHarness({
    name: 'no-storage',
    params: {},
  });
  const log = seen();
  const agent = keptAgent({
    seen: log,
    first: 'link-lost',
  });
  await expect(
    harness.run(
      {
        ...coder(agent),
        execution: {
          durable,
          retry: {
            maxAttempts: 2,
            initialDelay: 0,
            backoff: 'fixed',
          },
        },
      },
      '',
      harness.createContext(),
    ),
  ).rejects.toMatchObject({
    noeticError: {
      kind: 'acp_outcome_unknown',
    },
  });
  expect(log.prompts).toHaveLength(1);
  await harness.close();
});

it('does not retry an ACP internal error after dispatch', async () => {
  const harness = new AgentHarness({
    name: 'rpc-failure',
    params: {},
  });
  const log = seen();
  await expect(
    harness.run(
      {
        ...coder(
          keptAgent({
            seen: log,
            first: 'rpc-error',
          }),
        ),
        execution: {
          retry: {
            maxAttempts: 2,
            initialDelay: 0,
            backoff: 'fixed',
          },
        },
      },
      '',
      harness.createContext(),
    ),
  ).rejects.toMatchObject({
    noeticError: {
      kind: 'acp_outcome_unknown',
    },
    cause: {
      message: expect.stringContaining('lost result after writing'),
    },
  });
  expect(log.prompts).toHaveLength(1);
  await harness.close();
});

it.each([
  'all',
  'race',
  'settle',
] as const)('detaches a parallel sibling on a recoverable cut in %s mode', async (mode) => {
  const storage = createInMemoryStorage({
    swap: true,
  });
  const log = seen();
  const sibling = coder(
    keptAgent({
      seen: log,
    }),
  );
  const paths = () => [
    sibling,
    runCode<ContextData, string, string>({
      id: 'cut',
      async execute() {
        await until(() => log.prompts.length === 1);
        throw new NoeticErrorImpl({
          kind: 'ledger_write_failed',
          executionId: 'fixture',
          path: 'fixture',
          cause: new Error('cut'),
        });
      },
    }),
  ];
  const graph =
    mode === 'race'
      ? inParallel({
          id: 'parallel',
          mode,
          paths,
        })
      : mode === 'all'
        ? inParallel({
            id: 'parallel',
            mode,
            paths,
            merge: (values) => values.join(''),
          })
        : inParallel({
            id: 'parallel',
            mode,
            paths,
            merge: () => '',
          });
  const harness = new AgentHarness({
    name: 'parallel-cut',
    params: {},
    agentGraph: graph,
    environment: {
      storage: {
        adapter: storage,
        park: {
          autoWake: false,
        },
      },
    },
  });
  try {
    await harness.execute('start', {
      threadId: 'parallel',
    });
    expect(
      (
        await harness.getAgentResponse({
          threadId: 'parallel',
        })
      ).cut?.reason,
    ).toBe('ledger_write_failed');
    expect(log.released).toEqual([
      'detached',
    ]);
  } finally {
    await harness.close();
  }
});

describe('killAgentsOnExit', () => {
  it.each([
    [
      undefined,
      'keep',
    ],
    [
      false,
      'keep',
    ],
    [
      true,
      'stop',
    ],
  ] satisfies Array<
    [
      boolean | undefined,
      AcpWhenHostExits,
    ]
  >)('killAgentsOnExit: %p asks the agent to %s on host exit', async (kill, expected) => {
    const harness = harnessOn(createInMemoryStorage(), kill);
    const connects = seen();
    const agent = keptAgent({
      seen: connects,
    });
    const ctx = harness.createContext();
    const done = harness.run(coder(agent), '', ctx).catch(() => undefined);
    running.push({
      ctx,
      done,
    });
    await until(() => connects.connects.length === 1);
    expect(connects.connects[0]?.whenHostExits).toBe(expected);
  });
});

describe('an ACP step that cannot safely reattach', () => {
  it('fails rather than start over when reattaching fails some other way', async () => {
    const storage = createInMemoryStorage();
    const executionId = await cutOff(storage, seen());

    const after = seen();
    const error = await resume({
      storage,
      executionId,
      agent: keptAgent({
        seen: after,
        broken: true,
      }),
      events: [],
    }).catch((e: unknown) => e);

    assert(isNoeticError(error));
    expect(error.noeticError.kind).toBe('acp_link_lost');
    expect(after.newSessions).toBe(0);
    expect(after.prompts).toEqual([]);
  });

  it('fails when the session was opened with other instructions or settings', async () => {
    const storage = createInMemoryStorage();
    const executionId = await cutOff(storage, seen(), 'opened-with-A');

    const after = seen();
    const error = await resume({
      storage,
      executionId,
      agent: keptAgent({
        seen: after,
        collected: 'never collected',
        fingerprint: 'would-open-with-B',
      }),
      events: [],
    }).catch((e: unknown) => e);

    assert(isNoeticConfigError(error));
    expect(error.code).toBe('ACP_SESSION_SETTING_CONFLICT');
    expect(after.prompts).toEqual([]);
    // The old turn is let go of, never stopped: a matching host can still take it.
    expect(after.released).toEqual([
      'detached',
    ]);
  });

  it('collects the turn when the settings match', async () => {
    const storage = createInMemoryStorage();
    const executionId = await cutOff(storage, seen(), 'same');

    const output = await resume({
      storage,
      executionId,
      agent: keptAgent({
        seen: seen(),
        collected: 'done while away',
        fingerprint: 'same',
      }),
      events: [],
    });
    expect(output).toBe('done while away');
  });
});
