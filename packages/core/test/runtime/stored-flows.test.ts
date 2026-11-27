// Flows stored with a turn: the source of a flow that is data is stored under the
// turn's execution, and a turn resumed by a harness on a newer flow finishes on
// the flow it began under. See specs/23-durable-execution § Stored flows.
//
// Only JSON workflows have a source. The fixtures here that need a step with a
// lasting effect build one in TypeScript and give it a source through the
// builders' internal `flowFrom`, the path `hydrateWorkflow` and `workflow()` take.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type {
  CallModelRequest,
  Context,
  ContextData,
  DecisionItem,
  ExecuteStepFn,
  FlowRebuildFailure,
  LLMResponse,
  Step,
  WorkflowDocument,
} from '@noetic-tools/types';
import { FlowRebuildReason, frameworkCast, isNoeticError } from '@noetic-tools/types';
import { z } from 'zod';
import { flowFrom } from '../../src/builders/flow-source';
import { toStep } from '../../src/builders/sequence';
import { callModel, invokeTool, runCode, step } from '../../src/builders/step-builders';
import { tool } from '../../src/builders/tool-builder';
import { hydrateWorkflow } from '../../src/builders/workflow-source';
import { workflow } from '../../src/builders/workflow-step';
import { defineSource } from '../../src/connections/sources';
import { AgentHarness } from '../../src/harness/agent-harness';
import { execute } from '../../src/interpreter/execute';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { assistantMessage } from '../_helpers';

//#region Fixtures

interface Model {
  calls: number;
  /** The instructions of each call, in order. */
  instructions: Array<string | undefined>;
  call: (request: CallModelRequest) => Promise<LLMResponse>;
}

/** Answers `<tag>-<n>`, and drops the connection on the calls in `failAt`. */
function model(tag: string, failAt: number[] = []): Model {
  const m: Model = {
    calls: 0,
    instructions: [],
    call: async (request) => {
      m.calls += 1;
      m.instructions.push(request.instructions);
      if (failAt.includes(m.calls)) {
        throw new Error('fetch failed: ECONNRESET');
      }
      return {
        items: [
          assistantMessage(`${tag}-${m.calls}`),
        ],
        usage: {
          inputTokens: 1,
          outputTokens: 1,
        },
      };
    },
  };
  return m;
}

const turn = (id: string) =>
  callModel<ContextData, string, string>({
    id,
    model: 'test/model',
  });

/** A source for a flow with a durable charge in it. */
const RowSchema = z.object({
  revision: z.number(),
  amount: z.number(),
});
type Row = z.infer<typeof RowSchema>;

function chargeTool(charges: number[]) {
  return tool({
    name: 'charge',
    description: 'Charge a card.',
    input: z.object({
      amount: z.number(),
    }),
    output: z.object({
      charged: z.number(),
      receipt: z.string(),
    }),
    durable: true,
    execute: async (args) => {
      charges.push(args.amount);
      return {
        charged: args.amount,
        receipt: `rcpt-${charges.length}`,
      };
    },
  });
}

/** Builds the flow of a row: plan, charge the row's amount, then answer. */
function compile(charges: number[]): (row: Row) => Step<ContextData, string, string> {
  return (row) => {
    const { amount } = RowSchema.parse(row);
    const chargeStep = invokeTool({
      id: 'charge',
      tool: chargeTool(charges),
    });
    return runCode<ContextData, string, string>({
      id: 'flow',
      execute: async (input, execCtx) => {
        await execCtx.harness.run(turn('plan'), input, execCtx);
        await execCtx.harness.run(
          chargeStep,
          {
            amount,
          },
          execCtx,
        );
        return String(await execCtx.harness.run(turn('answer'), 'charged', execCtx));
      },
    });
  };
}

interface Deploy {
  storage: StorageAdapter;
  m: Model;
  row: Row;
  charges: number[];
  version?: string;
  /** The compiler, when it is not `compile(charges)`. */
  build?: (row: Row) => Step<ContextData, string, string>;
}

function harnessOn(opts: Deploy): AgentHarness {
  return new AgentHarness({
    name: 'flows',
    params: {},
    version: opts.version,
    agentGraph: flowFrom(opts.row, opts.build ?? compile(opts.charges)),
    environment: {
      storage: {
        adapter: opts.storage,
      },
    },
    _testCallModel: (request) => opts.m.call(request),
  });
}

const OLD: Row = {
  revision: 1,
  amount: 42,
};
const NEW: Row = {
  revision: 2,
  amount: 50,
};

const thread = {
  threadId: 't',
};
const delivery = {
  threadId: 't',
  messageId: 'm-1',
};
const next = {
  threadId: 't',
  messageId: 'm-2',
};

/** Runs `row` until the answer's model call fails: the plan and the charge are recorded. */
async function cutOffAfterCharge(
  opts: Omit<Deploy, 'm' | 'row'> & {
    row?: Row;
  },
): Promise<AgentHarness> {
  const first = harnessOn({
    row: OLD,
    ...opts,
    m: model(
      'a',
      [
        2,
      ],
    ),
  });
  await first.execute('refund order 7', delivery);
  await expect(first.getAgentResponse(thread)).rejects.toThrow('ECONNRESET');
  expect(opts.charges).toEqual([
    42,
  ]);
  return first;
}

function decision(action: 'continue' | 'restart' | 'abandon'): DecisionItem {
  return {
    type: 'noetic:decision',
    action,
  };
}

async function kindOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    assert(isNoeticError(error));
    return error.noeticError.kind;
  }
  return 'resolved';
}

const StoredFlowSchema = z.object({
  version: z.string(),
  hash: z.string(),
  source: z.unknown(),
});

/** The key of every flow a turn stored. */
async function flowKeys(storage: StorageAdapter): Promise<string[]> {
  return (await storage.list('execution:')).filter((key) => key.endsWith(':flow'));
}

/** Every flow a turn stored. */
async function storedFlows(storage: StorageAdapter): Promise<z.infer<typeof StoredFlowSchema>[]> {
  const found: z.infer<typeof StoredFlowSchema>[] = [];
  for (const key of await flowKeys(storage)) {
    found.push(StoredFlowSchema.parse(await storage.get<unknown>(key)));
  }
  return found;
}

const SessionSchema = z.object({
  turn: z
    .object({
      executionId: z.string(),
      version: z.string().optional(),
      flow: z.string().optional(),
    })
    .optional(),
});

async function session(storage: StorageAdapter): Promise<z.infer<typeof SessionSchema>> {
  return SessionSchema.parse(await storage.get<unknown>('session:t'));
}

/** The version each step of the thread's trail ran under, by step id. */
async function trailVersions(harness: AgentHarness): Promise<Record<string, string | undefined>> {
  const trail = await harness.getAuditTrail(thread);
  return Object.fromEntries(
    trail.map((mark) => [
      mark.stepId,
      mark.version,
    ]),
  );
}

/** `storage`, counting the writes to keys that start with `prefix`. */
function countingWrites(
  storage: StorageAdapter,
  prefix: string,
): {
  storage: StorageAdapter;
  writes: string[];
} {
  const writes: string[] = [];
  return {
    writes,
    storage: {
      ...storage,
      set: async (key, value) => {
        if (key.startsWith(prefix)) {
          writes.push(key);
        }
        await storage.set(key, value);
      },
    },
  };
}

interface RebuildEvent extends FlowRebuildFailure {
  threadId: string;
  executionId: string;
}

const RebuildEventSchema = z.object({
  type: z.literal('flows:flow_rebuild_failed'),
  data: z.object({
    threadId: z.string(),
    executionId: z.string(),
    version: z.string(),
    reason: z.enum(FlowRebuildReason),
    message: z.string(),
  }),
});

async function collectRebuildFailures(harness: AgentHarness, into: RebuildEvent[]): Promise<void> {
  for await (const event of harness.getFullStream(thread)) {
    const parsed = RebuildEventSchema.safeParse(event);
    if (parsed.success) {
      into.push(parsed.data.data);
    }
  }
}

/** The thread's `flow_rebuild_failed` events, filled for as long as the harness streams. */
function rebuildFailures(harness: AgentHarness): RebuildEvent[] {
  const heard: RebuildEvent[] = [];
  void collectRebuildFailures(harness, heard);
  return heard;
}

//#endregion

describe('a turn that began on a flow with a source', () => {
  it('finishes on that flow when a harness on a newer flow resumes it', async () => {
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    await cutOffAfterCharge({
      storage,
      charges,
    });
    const [stored] = await storedFlows(storage);
    assert(stored);
    expect(stored.source).toEqual(OLD);
    expect(stored.version).toBe(stored.hash);
    // It is the turn's own: stored under its execution, and named on its record.
    const cut = (await session(storage)).turn;
    assert(cut);
    expect(await flowKeys(storage)).toEqual([
      `execution:${cut.executionId}:flow`,
    ]);
    expect(cut.flow).toBe(stored.hash);

    const m = model('b');
    const second = harnessOn({
      storage,
      m,
      row: NEW,
      charges,
    });
    const failures = rebuildFailures(second);
    await second.execute('refund order 7', delivery);
    expect((await second.getAgentResponse(thread)).text).toBe('b-1');
    // The plan and the charge replayed: only the answer ran, and no card was charged twice.
    expect(m.calls).toBe(1);
    expect(charges).toEqual([
      42,
    ]);
    expect(await second.listStuckRuns()).toEqual([]);
    expect(failures).toEqual([]);
    // The whole turn ran as the version it began under.
    expect(await trailVersions(second)).toEqual({
      plan: stored.version,
      charge: stored.version,
      answer: stored.version,
      flow: stored.version,
    });
  });

  it('goes with the turn: the next turn of the session runs the newer flow', async () => {
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    await cutOffAfterCharge({
      storage,
      charges,
    });
    const second = harnessOn({
      storage,
      m: model('b'),
      row: NEW,
      charges,
    });
    await second.execute('refund order 7', delivery);
    await second.getAgentResponse(thread);
    // The turn ended, and what it stored went with its checkpoint.
    expect(await flowKeys(storage)).toEqual([]);

    await second.execute('and order 8', next);
    await second.getAgentResponse(thread);
    expect(charges).toEqual([
      42,
      50,
    ]);
    expect(await flowKeys(storage)).toEqual([]);
  });

  it('is written when the turn begins, and not again each time it resumes', async () => {
    const counted = countingWrites(createInMemoryStorage(), 'execution:');
    const flowWrites = (): string[] => counted.writes.filter((key) => key.endsWith(':flow'));
    const charges: number[] = [];
    await cutOffAfterCharge({
      storage: counted.storage,
      charges,
    });
    expect(flowWrites()).toHaveLength(1);
    // Resumed on the same flow, and cut off again at the answer.
    const again = harnessOn({
      storage: counted.storage,
      m: model(
        'b',
        [
          1,
        ],
      ),
      row: OLD,
      charges,
    });
    await again.execute('refund order 7', delivery);
    await again.getAgentResponse(thread).catch(() => {});
    // Resumed on a newer flow, which reads the source and leaves it as it is.
    const newer = harnessOn({
      storage: counted.storage,
      m: model('c'),
      row: NEW,
      charges,
    });
    await newer.execute('refund order 7', delivery);
    expect((await newer.getAgentResponse(thread)).text).toBe('c-1');
    expect(flowWrites()).toHaveLength(1);

    // Each new turn stores a copy of its own.
    await newer.execute('and order 8', next);
    await newer.getAgentResponse(thread);
    expect(flowWrites()).toHaveLength(2);
  });

  it('resumes on its flow whichever of two live harnesses takes it', async () => {
    for (const resumer of [
      'old',
      'new',
    ]) {
      const storage = createInMemoryStorage({
        swap: true,
      });
      const charges: number[] = [];
      const first = await cutOffAfterCharge({
        storage,
        charges,
      });
      const lease = {
        waitMs: 0,
      };
      const m = model('b');
      const make = (row: Row): AgentHarness =>
        new AgentHarness({
          name: 'flows',
          params: {},
          agentGraph: flowFrom(row, compile(charges)),
          environment: {
            storage: {
              adapter: storage,
              lease,
            },
          },
          _testCallModel: (request) => m.call(request),
        });
      const onOld = make(OLD);
      const onNew = make(NEW);
      // The turn failed in a live process, so only a named wake runs it again.
      const woken = await (resumer === 'old' ? onOld : onNew).wake(thread);
      expect(woken).toEqual([
        't',
      ]);
      const response = await (resumer === 'old' ? onOld : onNew).getAgentResponse(thread);
      expect(response.text).toBe('b-1');
      expect(charges).toEqual([
        42,
      ]);
      const versions = await trailVersions(first);
      expect(new Set(Object.values(versions)).size).toBe(1);
      // The other harness finds nothing left to run.
      expect(await (resumer === 'old' ? onNew : onOld).wake(thread)).toEqual([]);
    }
  });

  it('keeps the version the host names, with the source stored the same way', async () => {
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    await cutOffAfterCharge({
      storage,
      charges,
      version: 'revision-1',
    });
    const [stored] = await storedFlows(storage);
    assert(stored);
    expect(stored.version).toBe('revision-1');
    expect(stored.hash.startsWith('workflow-')).toBe(true);
    expect((await session(storage)).turn?.version).toBe('revision-1');

    const m = model('b');
    const second = harnessOn({
      storage,
      m,
      row: NEW,
      charges,
      version: 'revision-2',
    });
    await second.execute('refund order 7', delivery);
    expect((await second.getAgentResponse(thread)).text).toBe('b-1');
    expect(charges).toEqual([
      42,
    ]);
    expect((await trailVersions(second)).answer).toBe('revision-1');

    await second.execute('and order 8', next);
    await second.getAgentResponse(thread);
    expect((await trailVersions(second)).answer).toBe('revision-2');
  });
});

it.each([
  undefined,
  'release',
])('resumes the original batch and replays its completed item (version: %s)', async (version) => {
  const storage = createInMemoryStorage({
    swap: true,
  });
  const ran: string[] = [];
  const executions = new Set<string>();
  const stopped = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const run = (label: string, holder: string, now: number) =>
    new AgentHarness({
      name: 'batch',
      version,
      params: {},
      agentGraph: flowFrom(
        {
          label,
        },
        ({ label }) =>
          runCode<ContextData, string, string>({
            id: 'batch',
            execute: async (_input, ctx) => {
              executions.add(ctx.id);
              const results: string[] = [];
              for (const id of [
                'a',
                'b',
              ]) {
                results.push(
                  await ctx.harness.run(
                    runCode({
                      id,
                      execute: async () => {
                        if (holder === 'first' && id === 'b') {
                          stopped.resolve();
                          await release.promise;
                        }
                        ran.push(`${holder}:${label}:${id}`);
                        return `${label}:${id}`;
                      },
                    }),
                    undefined,
                    ctx,
                  ),
                );
              }
              return results.join(',');
            },
          }),
      ),
      environment: {
        storage: {
          adapter: storage,
          lease: {
            holder,
            ttlMs: 10_000,
            waitMs: 0,
            now: () => now,
          },
          park: {
            autoWake: false,
          },
        },
      },
    });

  const first = run('old', 'first', 0);
  const second = run('new', 'second', 10_000);
  try {
    await first.execute('batch input', delivery);
    await stopped.promise;
    const firstTurn = (await first.getStoredThread(thread.threadId))?.turn;
    assert(firstTurn);
    expect(await second.wake()).toEqual([
      thread.threadId,
    ]);
    expect((await second.getAgentResponse(thread)).text).toBe('old:a,old:b');
    expect(ran).toEqual([
      'first:old:a',
      'second:old:b',
    ]);
    expect([
      ...executions,
    ]).toEqual([
      firstTurn.executionId,
    ]);

    release.resolve();
    await expect(first.getAgentResponse(thread)).rejects.toMatchObject({
      noeticError: {
        kind: 'lease_lost',
      },
    });
    expect((await second.getStoredThread(thread.threadId))?.turn).toBeUndefined();
    expect(await second.wake()).toEqual([]);
  } finally {
    release.resolve();
    await Promise.all([
      first.close(),
      second.close(),
    ]);
  }
});

it.each([
  'baseline',
  'end',
  'end-reply',
] as const)('keeps the correct recovery state when storage loses %s', async (lost) => {
  const backing = createInMemoryStorage({
    swap: true,
  });
  let interrupted = false;
  const storage: StorageAdapter = {
    ...backing,
    async set(key, value) {
      if (!interrupted && lost === 'baseline' && key.endsWith(':snapshot')) {
        interrupted = true;
        throw new Error('baseline write failed');
      }
      await backing.set(key, value);
    },
    async swap(key, prior, next) {
      if (
        !interrupted &&
        lost !== 'baseline' &&
        key === 'session:t' &&
        prior &&
        typeof prior === 'object' &&
        'turn' in prior &&
        next &&
        typeof next === 'object' &&
        !('turn' in next)
      ) {
        interrupted = true;
        if (lost === 'end-reply') {
          expect(await backing.swap!(key, prior, next)).toBe(true);
        }
        throw new Error('turn end reply lost');
      }
      return await backing.swap!(key, prior, next);
    },
  };
  const ran: string[] = [];
  const build = (label: string) =>
    new AgentHarness({
      name: 'checkpoint-boundary',
      params: {},
      agentGraph: flowFrom(
        {
          label,
        },
        ({ label }) =>
          runCode<ContextData, string, string>({
            id: 'item',
            execute: async (_input, ctx) => {
              ran.push(
                `${label}:${ctx.itemLog.items.filter((item) => item.type === 'message' && item.role === 'user').length}`,
              );
              return label;
            },
          }),
      ),
      environment: {
        storage: {
          adapter: storage,
          lease: {
            waitMs: 0,
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
  const first = build('original');
  const replacement = build('updated');
  try {
    await first.execute('start', delivery);
    const response = await first.getAgentResponse(thread);
    expect(interrupted).toBe(true);
    if (lost === 'end-reply') {
      expect(response.text).toBe('original');
      expect(await replacement.wake()).toEqual([]);
    } else {
      expect(response.cut?.reason).toBe('ledger_write_failed');
      expect(ran).toEqual(
        lost === 'baseline'
          ? []
          : [
              'original:1',
            ],
      );
      expect(await replacement.wake()).toEqual([
        thread.threadId,
      ]);
      expect((await replacement.getAgentResponse(thread)).text).toBe('original');
    }
    await replacement.execute('start', delivery);
    expect((await replacement.getAgentResponse(thread)).text).toBe('original');
    expect(ran).toEqual([
      'original:1',
    ]);
  } finally {
    await Promise.all([
      first.close(),
      replacement.close(),
    ]);
  }
});

describe('a parked turn', () => {
  const DAY = 864e5;

  /** A source over `mailbox` that replays from a cursor. */
  function inbox(mailbox: string[]) {
    return defineSource({
      events: {
        reply: z.object({
          text: z.string(),
        }),
      },
      async start({ emit, cursor, signal }) {
        let at = cursor === null ? 0 : Number(cursor) + 1;
        while (!signal.aborted) {
          const text = mailbox[at];
          if (text === undefined) {
            await new Promise((resolve) => setTimeout(resolve, 2));
            continue;
          }
          await emit({
            type: 'reply',
            id: `reply-${at}`,
            cursor: String(at),
            payload: {
              text,
            },
          });
          at += 1;
        }
      },
    });
  }

  const LabelSchema = z.object({
    label: z.string(),
  });

  /** Plan, wait for a reply, then answer under the source's label. */
  function waiting(source: z.infer<typeof LabelSchema>): Step<ContextData, string, string> {
    const { label } = LabelSchema.parse(source);
    const waitForReply = step.wait({
      id: 'wait',
      connection: 'inbox',
      event: 'reply',
      timeoutMs: DAY,
    });
    return runCode<ContextData, string, string>({
      id: 'flow',
      execute: async (input, execCtx) => {
        await execCtx.harness.run(turn('plan'), input, execCtx);
        await execCtx.harness.run(waitForReply, undefined, execCtx);
        return `${label}:${String(await execCtx.harness.run(turn('answer'), 'replied', execCtx))}`;
      },
    });
  }

  function harnessOver(opts: {
    storage: StorageAdapter;
    mailbox: string[];
    m: Model;
    label: string;
  }): AgentHarness {
    return new AgentHarness({
      name: 'flows',
      params: {},
      agentGraph: flowFrom(
        {
          label: opts.label,
        },
        waiting,
      ),
      now: () => 1e6,
      connections: {
        inbox: inbox(opts.mailbox),
      },
      environment: {
        storage: {
          adapter: opts.storage,
          lease: {
            waitMs: 0,
          },
          park: {
            graceMs: 0,
            autoWake: false,
          },
        },
      },
      _testCallModel: (request) => opts.m.call(request),
    });
  }

  it('wakes on the flow it parked on', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const mailbox: string[] = [];
    const first = harnessOver({
      storage,
      mailbox,
      m: model('a'),
      label: 'old',
    });
    await first.execute('hello', delivery);
    assert((await first.getAgentResponse(thread)).parked);
    await first.close();

    const m = model('b');
    const second = harnessOver({
      storage,
      mailbox,
      m,
      label: 'new',
    });
    mailbox.push('approved');
    expect(await second.wake(thread)).toEqual([
      't',
    ]);
    const response = await second.getAgentResponse(thread);
    expect(response.text).toBe('old:b-1');
    expect(m.calls).toBe(1);
    await second.close();
  });
});

describe('a stored flow that cannot be rebuilt', () => {
  /** A builder that turned its back on revision 1 rows. */
  function strict(charges: number[]): (row: Row) => Step<ContextData, string, string> {
    return (row) => {
      if (RowSchema.parse(row).revision < 2) {
        throw new Error('revision 1 rows are no longer compiled');
      }
      return compile(charges)(row);
    };
  }

  it('falls back to moving forward: stuck on a recorded effect, with the reason', async () => {
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    await cutOffAfterCharge({
      storage,
      charges,
    });
    const [stored] = await storedFlows(storage);
    assert(stored);

    const m = model('b');
    const second = harnessOn({
      storage,
      m,
      row: NEW,
      charges,
      build: strict(charges),
    });
    const failures = rebuildFailures(second);
    await second.execute('refund order 7', delivery);
    expect(await kindOf(() => second.getAgentResponse(thread))).toBe('turn_stuck');
    expect(charges).toEqual([
      42,
    ]);

    const failure: FlowRebuildFailure = {
      version: stored.version,
      reason: FlowRebuildReason.BuildFailed,
      message: 'revision 1 rows are no longer compiled',
    };
    const [stuck] = await second.listStuckRuns();
    assert(stuck);
    expect(stuck.from).toBe(stored.version);
    expect(stuck.rebuild).toEqual(failure);
    expect(failures).toEqual([
      {
        threadId: 't',
        executionId: stuck.executionId,
        ...failure,
      },
    ]);

    // The turn moved to this harness's flow when it began here: that is what it stores now.
    expect((await storedFlows(storage)).map((flow) => flow.source)).toEqual([
      NEW,
    ]);

    // The host's decisions mean what they did: go on, on this harness's flow.
    await second.execute(decision('continue'), thread);
    expect((await second.getAgentResponse(thread)).text).toBe('b-1');
    expect(charges).toEqual([
      42,
      50,
    ]);
    expect(await second.listStuckRuns()).toEqual([]);
  });

  it('stores the harness flow in place of the old one when the host goes on', async () => {
    for (const action of [
      'continue',
      'restart',
    ] as const) {
      const storage = createInMemoryStorage();
      const charges: number[] = [];
      await cutOffAfterCharge({
        storage,
        charges,
      });
      const second = harnessOn({
        storage,
        // Settled, the turn is cut off again at its answer.
        m: model(
          'b',
          action === 'continue'
            ? [
                1,
              ]
            : [
                2,
              ],
        ),
        row: NEW,
        charges,
        build: strict(charges),
      });
      await second.execute('refund order 7', delivery);
      await second.getAgentResponse(thread).catch(() => {});
      await second.execute(decision(action), thread);
      await second.getAgentResponse(thread).catch(() => {});
      expect(charges).toEqual([
        42,
        50,
      ]);
      const [stored] = await storedFlows(storage);
      assert(stored);
      expect(await flowKeys(storage)).toHaveLength(1);
      expect(stored.source).toEqual(NEW);
      expect((await session(storage)).turn?.version).toBe(stored.version);

      // A harness that can still build revision 1 resumes it where it now is.
      const third = harnessOn({
        storage,
        m: model('c'),
        row: NEW,
        charges,
      });
      await third.execute('refund order 7', delivery);
      expect((await third.getAgentResponse(thread)).text).toBe('c-1');
      expect(charges).toEqual([
        42,
        50,
      ]);
    }
  });

  it('is dropped with the turn when the host abandons it', async () => {
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    await cutOffAfterCharge({
      storage,
      charges,
    });
    const second = harnessOn({
      storage,
      m: model('b'),
      row: NEW,
      charges,
      build: strict(charges),
    });
    await second.execute('refund order 7', delivery);
    await second.getAgentResponse(thread).catch(() => {});
    expect(await flowKeys(storage)).toHaveLength(1);
    await second.execute(decision('abandon'), thread);
    expect(await flowKeys(storage)).toEqual([]);
  });

  it('moves forward without stopping when nothing recorded is lost', async () => {
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    await cutOffAfterCharge({
      storage,
      charges,
    });
    const m = model('b');
    const second = harnessOn({
      storage,
      m,
      // Another revision that charges the same: the recorded charge still matches.
      row: {
        revision: 2,
        amount: 42,
      },
      charges,
      build: strict(charges),
    });
    const failures = rebuildFailures(second);
    await second.execute('refund order 7', delivery);
    expect((await second.getAgentResponse(thread)).text).toBe('b-1');
    expect(charges).toEqual([
      42,
    ]);
    expect(failures.map((failure) => failure.reason)).toEqual([
      'build_failed',
    ]);
  });

  it('refuses a rebuilt flow that runs a document the stored source does not hold', async () => {
    // The builder nests a second flow whose source comes from the release, not the row.
    const nesting =
      (charges: number[], release: string) =>
      (row: Row): Step<ContextData, string, string> =>
        toStep<ContextData, string, string>([
          flowFrom(
            {
              release,
            },
            () =>
              runCode<ContextData, string, string>({
                id: 'greet',
                execute: async (input) => input,
              }),
          ),
          compile(charges)(row),
        ]);
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    await cutOffAfterCharge({
      storage,
      charges,
      build: nesting(charges, 'r1'),
    });
    const second = harnessOn({
      storage,
      m: model('b'),
      row: NEW,
      charges,
      build: nesting(charges, 'r2'),
    });
    const failures = rebuildFailures(second);
    await second.execute('refund order 7', delivery);
    expect(await kindOf(() => second.getAgentResponse(thread))).toBe('turn_stuck');
    expect(failures.map((failure) => failure.reason)).toEqual([
      'hash_mismatch',
    ]);
    const [stuck] = await second.listStuckRuns();
    expect(stuck?.rebuild?.reason).toBe('hash_mismatch');
  });

  it('says so when what the turn stored is not a flow', async () => {
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    await cutOffAfterCharge({
      storage,
      charges,
    });
    const [key] = await flowKeys(storage);
    assert(key);
    await storage.set(key, 'not a flow');
    const second = harnessOn({
      storage,
      m: model('b'),
      row: NEW,
      charges,
    });
    const failures = rebuildFailures(second);
    await second.execute('refund order 7', delivery);
    expect(await kindOf(() => second.getAgentResponse(thread))).toBe('turn_stuck');
    expect(failures.map((failure) => failure.reason)).toEqual([
      'unreadable',
    ]);
  });

  it('says so when the harness flow has no builder', async () => {
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    await cutOffAfterCharge({
      storage,
      charges,
    });
    // The next release builds its flow in TypeScript and names its version itself.
    const second = new AgentHarness({
      name: 'flows',
      params: {},
      version: 'closures-2',
      agentGraph: compile(charges)(NEW),
      environment: {
        storage: {
          adapter: storage,
        },
      },
      _testCallModel: (request) => model('b').call(request),
    });
    const failures = rebuildFailures(second);
    await second.execute('refund order 7', delivery);
    expect(await kindOf(() => second.getAgentResponse(thread))).toBe('turn_stuck');
    expect(failures.map((failure) => failure.reason)).toEqual([
      'no_builder',
    ]);
    // The turn moved to a flow with no source: the old one names nothing now.
    expect(await flowKeys(storage)).toEqual([]);
  });
});

describe('a flow with no source, or a harness with no storage', () => {
  it('stores nothing for a flow built in TypeScript, and moves forward as before', async () => {
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    const closures = (m: Model, version: string, amount: number): AgentHarness =>
      new AgentHarness({
        name: 'flows',
        params: {},
        version,
        agentGraph: compile(charges)({
          revision: 1,
          amount,
        }),
        environment: {
          storage: {
            adapter: storage,
          },
        },
        _testCallModel: (request) => m.call(request),
      });
    const first = closures(
      model(
        'a',
        [
          2,
        ],
      ),
      'v1',
      42,
    );
    await first.execute('refund order 7', delivery);
    await first.getAgentResponse(thread).catch(() => {});
    expect(await flowKeys(storage)).toEqual([]);

    const second = closures(model('b'), 'v2', 50);
    const failures = rebuildFailures(second);
    await second.execute('refund order 7', delivery);
    expect(await kindOf(() => second.getAgentResponse(thread))).toBe('turn_stuck');
    const [stuck] = await second.listStuckRuns();
    assert(stuck);
    expect(stuck.rebuild).toBeUndefined();
    expect(failures).toEqual([]);
    expect(await flowKeys(storage)).toEqual([]);
  });

  it('runs a flow built from a source with no storage at all', async () => {
    const charges: number[] = [];
    const m = model('a');
    const harness = new AgentHarness({
      name: 'flows',
      params: {},
      agentGraph: flowFrom(OLD, compile(charges)),
      _testCallModel: (request) => m.call(request),
    });
    await harness.execute('refund order 7', delivery);
    expect((await harness.getAgentResponse(thread)).text).toBe('a-2');
    expect(charges).toEqual([
      42,
    ]);
  });

  it('stores nothing when durability is off', async () => {
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    const m = model('a');
    const harness = new AgentHarness({
      name: 'flows',
      params: {},
      durability: false,
      agentGraph: flowFrom(OLD, compile(charges)),
      environment: {
        storage: {
          adapter: storage,
        },
      },
      _testCallModel: (request) => m.call(request),
    });
    await harness.execute('refund order 7', delivery);
    await harness.getAgentResponse(thread);
    expect(await storage.list('')).not.toContainEqual(expect.stringContaining(':flow'));
  });
});

describe('forgetting', () => {
  const other = {
    threadId: 'u',
  };

  /** Two threads, each with a turn cut off after its charge. */
  async function twoCutTurns(): Promise<{
    storage: StorageAdapter;
    harness: AgentHarness;
    charges: number[];
  }> {
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    await cutOffAfterCharge({
      storage,
      charges,
    });
    const first = harnessOn({
      storage,
      m: model(
        'a',
        [
          2,
        ],
      ),
      row: OLD,
      charges,
    });
    await first.execute('refund order 9', {
      ...other,
      messageId: 'm-9',
    });
    await first.getAgentResponse(other).catch(() => {});
    return {
      storage,
      harness: harnessOn({
        storage,
        m: model('b'),
        row: NEW,
        charges,
      }),
      charges,
    };
  }

  it('of a thread deletes the flow its turn stored, and no other turn’s', async () => {
    const { storage, harness } = await twoCutTurns();
    expect(await flowKeys(storage)).toHaveLength(2);
    const kept = (await session(storage)).turn?.executionId;
    assert(kept);
    await harness.forget(other);
    expect(await flowKeys(storage)).toEqual([
      `execution:${kept}:flow`,
    ]);
    await harness.forget(thread);
    expect(await flowKeys(storage)).toEqual([]);
  });

  it('of an execution deletes its flow, and leaves another unfinished turn’s', async () => {
    const { storage, harness, charges } = await twoCutTurns();
    const kept = (await session(storage)).turn?.executionId;
    assert(kept);
    const listed = await harness.listStoredExecutions();
    const gone = listed.find((execution) => execution.executionId !== kept);
    assert(gone);
    expect(gone.parts).toContain('flow');
    await harness.forget({
      executionId: gone.executionId,
    });
    expect(await flowKeys(storage)).toEqual([
      `execution:${kept}:flow`,
    ]);

    // The cut-off turn of thread `t` still finds its flow.
    await harness.execute('refund order 7', delivery);
    expect((await harness.getAgentResponse(thread)).text).toBe('b-1');
    expect(charges).toEqual([
      42,
      42,
    ]);
  });
});

describe('a JSON workflow', () => {
  const answer = (prompt: string): WorkflowDocument => ({
    version: 1,
    root: {
      kind: 'callModel',
      id: 'answer',
      model: 'test/model',
      instructions: prompt,
    },
  });

  /** Plan, then run the named workflow `child`. */
  const MAIN: WorkflowDocument = {
    version: 1,
    root: {
      kind: 'sequence',
      id: 'main',
      steps: [
        {
          kind: 'callModel',
          id: 'plan',
          model: 'test/model',
          instructions: 'Plan.',
        },
        {
          kind: 'subflow',
          id: 'finish',
          ref: 'child',
        },
      ],
    },
  };

  function named(prompt: string): Map<string, WorkflowDocument> {
    return new Map([
      [
        'main',
        MAIN,
      ],
      [
        'child',
        answer(prompt),
      ],
    ]);
  }

  function harnessFor(
    storage: StorageAdapter,
    m: Model,
    agentGraph: ConstructorParameters<typeof AgentHarness>[0]['agentGraph'],
  ): AgentHarness {
    return new AgentHarness({
      name: 'flows',
      params: {},
      agentGraph,
      environment: {
        storage: {
          adapter: storage,
        },
        secrets: {
          resolve: async () => 'hunter2',
        },
      },
      _testCallModel: (request) => m.call(request),
    });
  }

  const byName = (prompt: string) =>
    workflow({
      id: 'flow',
      ref: 'main',
      workflows: named(prompt),
    });

  it('stores what its version covers: the name, and every named workflow', async () => {
    const storage = createInMemoryStorage();
    const first = harnessFor(
      storage,
      model(
        'a',
        [
          2,
        ],
      ),
      byName('Answer the old way.'),
    );
    await first.execute('hello', delivery);
    await first.getAgentResponse(thread).catch(() => {});
    const [stored] = await storedFlows(storage);
    assert(stored);
    expect(stored.version.startsWith('workflow-')).toBe(true);
    expect(stored.hash).toBe(stored.version);
    expect(stored.source).toEqual({
      document: null,
      ref: 'main',
      workflows: {
        main: MAIN,
        child: answer('Answer the old way.'),
      },
    });

    // The next release edits only the named workflow a subflow runs.
    const m = model('b');
    const second = harnessFor(storage, m, byName('Answer the new way.'));
    await second.execute('hello', delivery);
    await second.getAgentResponse(thread);
    expect(m.instructions).toEqual([
      'Answer the old way.',
    ]);
    await second.execute('again', next);
    await second.getAgentResponse(thread);
    expect(m.instructions.slice(1)).toEqual([
      'Plan.',
      'Answer the new way.',
    ]);
  });

  it('resumes a hydrateWorkflow root on the document it began under', async () => {
    const storage = createInMemoryStorage();
    const two = (prompt: string): WorkflowDocument => ({
      version: 1,
      root: {
        kind: 'sequence',
        id: 'main',
        steps: [
          {
            kind: 'callModel',
            id: 'plan',
            model: 'test/model',
            instructions: 'Plan.',
          },
          {
            kind: 'callModel',
            id: 'answer',
            model: 'test/model',
            instructions: prompt,
          },
        ],
      },
    });
    const hydrated = (m: Model, prompt: string): AgentHarness => {
      const harness: AgentHarness = harnessFor(
        storage,
        m,
        hydrateWorkflow(two(prompt), {
          tools: new Map(),
          executeStep: frameworkCast<ExecuteStepFn>((child: Step, input: unknown, ctx: Context) =>
            harness.run(child, input, ctx),
          ),
        }),
      );
      return harness;
    };
    const first = hydrated(
      model(
        'a',
        [
          2,
        ],
      ),
      'Answer the old way.',
    );
    await first.execute('hello', delivery);
    await first.getAgentResponse(thread).catch(() => {});

    const m = model('b');
    const second = hydrated(m, 'Answer the new way.');
    await second.execute('hello', delivery);
    await second.getAgentResponse(thread);
    expect(m.instructions).toEqual([
      'Answer the old way.',
    ]);
  });

  /** Plan, then run the tool `toolName`. */
  const withTool = (toolName: string): WorkflowDocument => ({
    version: 1,
    root: {
      kind: 'sequence',
      id: 'main',
      steps: [
        {
          kind: 'callModel',
          id: 'plan',
          model: 'test/model',
          instructions: 'Plan.',
        },
        {
          kind: 'invokeTool',
          id: 'act',
          toolName,
          args: {
            amount: 42,
          },
        },
        {
          kind: 'callModel',
          id: 'answer',
          model: 'test/model',
          instructions: 'Answer.',
        },
      ],
    },
  });

  it('runs a recorded tool step once, and keeps a version the host names', async () => {
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    const deploy = (m: Model, version: string, document: WorkflowDocument): AgentHarness =>
      new AgentHarness({
        name: 'flows',
        params: {},
        version,
        agentGraph: workflow({
          id: 'flow',
          document,
          tools: [
            chargeTool(charges),
          ],
        }),
        environment: {
          storage: {
            adapter: storage,
          },
        },
        _testCallModel: (request) => m.call(request),
      });
    const first = deploy(
      model(
        'a',
        [
          2,
        ],
      ),
      'release-1',
      withTool('charge'),
    );
    await first.execute('hello', delivery);
    await first.getAgentResponse(thread).catch(() => {});
    const [stored] = await storedFlows(storage);
    assert(stored);
    expect(stored.version).toBe('release-1');
    expect(stored.hash.startsWith('workflow-')).toBe(true);

    // The next release charges twice as much and audits before it answers.
    const edited = withTool('charge');
    assert(edited.root.kind === 'sequence');
    edited.root.steps.splice(
      1,
      1,
      {
        kind: 'invokeTool',
        id: 'act',
        toolName: 'charge',
        args: {
          amount: 84,
        },
      },
      {
        kind: 'callModel',
        id: 'audit',
        model: 'test/model',
        instructions: 'Audit.',
      },
    );
    const m = model('b');
    const second = deploy(m, 'release-2', edited);
    await second.execute('hello', delivery);
    await second.getAgentResponse(thread);
    expect(m.instructions).toEqual([
      'Answer.',
    ]);
    expect(charges).toEqual([
      42,
    ]);
    expect((await trailVersions(second)).answer).toBe('release-1');

    await second.execute('again', next);
    await second.getAgentResponse(thread);
    expect(charges).toEqual([
      42,
      84,
    ]);
    expect(m.instructions.slice(1)).toEqual([
      'Plan.',
      'Audit.',
      'Answer.',
    ]);
  });

  it('falls back when the stored document names a tool the harness no longer has', async () => {
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    const first = harnessFor(
      storage,
      model(
        'a',
        [
          2,
        ],
      ),
      workflow({
        id: 'flow',
        document: withTool('charge'),
        tools: [
          chargeTool(charges),
        ],
      }),
    );
    await first.execute('hello', delivery);
    await first.getAgentResponse(thread).catch(() => {});
    expect(charges).toEqual([
      42,
    ]);

    const refunds: number[] = [];
    const refund = tool({
      name: 'refund',
      description: 'Refund a card.',
      input: z.object({
        amount: z.number(),
      }),
      output: z.string(),
      execute: async (args) => {
        refunds.push(args.amount);
        return 'refunded';
      },
    });
    const m = model('b');
    const second = harnessFor(
      storage,
      m,
      workflow({
        id: 'flow',
        document: withTool('refund'),
        tools: [
          refund,
        ],
      }),
    );
    const failures = rebuildFailures(second);
    await second.execute('hello', delivery);
    await second.getAgentResponse(thread);
    const [failure] = failures;
    assert(failure);
    expect(failure.reason).toBe('build_failed');
    expect(failure.message).toContain("'charge'");
    expect(charges).toEqual([
      42,
    ]);
  });

  it('falls back when the stored document no longer validates', async () => {
    const storage = createInMemoryStorage();
    const first = harnessFor(
      storage,
      model(
        'a',
        [
          1,
        ],
      ),
      workflow({
        id: 'flow',
        document: answer('Answer the old way.'),
      }),
    );
    await first.execute('hello', delivery);
    await first.getAgentResponse(thread).catch(() => {});
    const [key] = await flowKeys(storage);
    assert(key);
    const stored = StoredFlowSchema.parse(await storage.get<unknown>(key));
    // As a release that dropped a node kind would read it.
    await storage.set(key, {
      ...stored,
      source: {
        document: {
          version: 1,
          root: {
            kind: 'retired',
            id: 'answer',
          },
        },
        ref: null,
        workflows: null,
      },
    });

    const m = model('b');
    const second = harnessFor(
      storage,
      m,
      workflow({
        id: 'flow',
        document: answer('Answer the new way.'),
      }),
    );
    const failures = rebuildFailures(second);
    await second.execute('hello', delivery);
    await second.getAgentResponse(thread);
    expect(failures.map((failure) => failure.reason)).toEqual([
      'build_failed',
    ]);
    expect(failures[0]?.message).toContain('no longer validates');
    // The turn moved forward to the harness's document.
    expect(m.instructions).toEqual([
      'Answer the new way.',
    ]);
  });

  it('stores the names of secrets, never a value', async () => {
    const storage = createInMemoryStorage();
    const login: WorkflowDocument = {
      version: 1,
      connections: {
        app: {
          profile: 'browser@^1.2',
        },
      },
      root: {
        kind: 'call',
        id: 'password',
        connection: 'app',
        op: 'ui.fill',
        args: {
          text: {
            $secret: 'app.password',
          },
        },
      },
    };
    const harness = harnessFor(
      storage,
      model('a'),
      workflow({
        id: 'flow',
        document: login,
      }),
    );
    await harness.execute('sign in', delivery);
    // The harness has no such connection: the turn fails after it began.
    await harness.getAgentResponse(thread).catch(() => {});
    const [stored] = await storedFlows(storage);
    assert(stored);
    expect(stored.source).toEqual({
      document: login,
      ref: null,
      workflows: null,
    });
    const everything = JSON.stringify(
      await Promise.all((await storage.list('')).map((key) => storage.get<unknown>(key))),
    );
    expect(everything).toContain('app.password');
    expect(everything).not.toContain('hunter2');
  });
});

describe('a stored flow that reads harness params', () => {
  /** Plans, then answers under instructions read from the harness param `param`. */
  const reads = (param: string): WorkflowDocument => ({
    version: 1,
    root: {
      kind: 'sequence',
      id: 'main',
      steps: [
        {
          kind: 'callModel',
          id: 'plan',
          model: 'test/model',
          instructions: 'Plan.',
        },
        {
          kind: 'callModel',
          id: 'answer',
          model: 'test/model',
          fromParams: {
            instructions: param,
          },
        },
      ],
    },
  });

  function deploy(opts: {
    storage: StorageAdapter;
    m: Model;
    document: WorkflowDocument;
    params: Record<string, unknown>;
  }): AgentHarness {
    return new AgentHarness({
      name: 'flows',
      params: opts.params,
      agentGraph: hydrateWorkflow(opts.document, {
        tools: new Map(),
        executeStep: execute,
      }),
      environment: {
        storage: {
          adapter: opts.storage,
        },
      },
      _testCallModel: (request) => opts.m.call(request),
    });
  }

  /** Runs the document that reads `rules` until its answer's model call fails. */
  async function cutOffBeforeAnswer(storage: StorageAdapter): Promise<void> {
    const first = deploy({
      storage,
      m: model(
        'a',
        [
          2,
        ],
      ),
      document: reads('rules'),
      params: {
        rules: () => 'first rules',
      },
    });
    await first.execute('go', delivery);
    await expect(first.getAgentResponse(thread)).rejects.toThrow('ECONNRESET');
  }

  it('reads them from the harness that resumes it', async () => {
    const storage = createInMemoryStorage();
    await cutOffBeforeAnswer(storage);
    const m = model('b');
    const second = deploy({
      storage,
      m,
      document: reads('newRules'),
      params: {
        rules: () => 'second rules',
        newRules: () => 'unused by the stored flow',
      },
    });
    await second.execute('go', delivery);
    expect((await second.getAgentResponse(thread)).text).toBe('b-1');
    expect(m.instructions).toEqual([
      'second rules',
    ]);
  });

  it('fails at its start when the harness that resumes it lacks one', async () => {
    const storage = createInMemoryStorage();
    await cutOffBeforeAnswer(storage);
    const m = model('b');
    const second = deploy({
      storage,
      m,
      document: reads('newRules'),
      params: {
        newRules: () => 'x',
      },
    });
    await second.execute('go', delivery);
    await expect(second.getAgentResponse(thread)).rejects.toThrow(
      "reads harness param 'rules', which the harness does not have",
    );
    expect(m.calls).toBe(0);
  });
});
