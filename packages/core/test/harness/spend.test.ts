// Paid dispatches (spec 23 § Paid dispatches): every paid call is recorded before it
// is sent, and a call cut off by a crash or a cancel is settled later, or held at its
// ceiling. A host killed mid-call is simulated by abandoning its harness and building
// a new one over the same storage. Generation and price lookups are mocked.

import { afterEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type { Context, ContextData, PendingSpend, StreamEvent } from '@noetic-tools/types';
import { frameworkCast, recordUsage } from '@noetic-tools/types';
import { inParallel } from '../../src/builders/control-flow-builders';
import { decide } from '../../src/builders/decide-builders';
import { loop } from '../../src/builders/loop-builder';
import { callModel, runCode } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import type { DispatchRecord } from '../../src/runtime/durable/spend-log';
import { createSpendLog } from '../../src/runtime/durable/spend-log';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { until } from '../../src/until/predicates';
import type { FakeOpenRouter } from '../_helpers';
import { startFakeOpenRouter } from '../_helpers';

//#region Fixtures

const PROMPT_PRICE = 1e-6;
const COMPLETION_PRICE = 1e-5;
const MAX_COMPLETION = 1e3;
/** What the fake provider bills for the cut-off round `gen-1`. */
const CUT_BILL = 0.00171;
/** What each finished round costs on the fake server. */
const ROUND_COST = 0.01;

interface Bill {
  totalCost: number;
  tokensPrompt: number;
  tokensCompletion: number;
}

interface FakeSdk {
  lookups: string[];
}

/**
 * The SDK client's model and generation lookups. A generation not in `bills` answers
 * 404, as the provider does until it has priced the call. Native decide calls never
 * answer.
 */
function useFakeSdk(
  harness: AgentHarness,
  opts: {
    bills?: Record<string, Bill>;
    decisionModel?: boolean;
  } = {},
): FakeSdk {
  const lookups: string[] = [];
  frameworkCast<{
    sdkClient: unknown;
  }>(harness).sdkClient = {
    models: {
      get: async () => ({
        data: {
          architecture: {
            outputModalities: [
              opts.decisionModel ? 'decisions' : 'text',
            ],
          },
          pricing: {
            prompt: String(PROMPT_PRICE),
            completion: String(COMPLETION_PRICE),
          },
          topProvider: {
            maxCompletionTokens: MAX_COMPLETION,
          },
          contextLength: 8e3,
        },
      }),
    },
    generations: {
      getGeneration: async ({ id }: { id: string }) => {
        lookups.push(id);
        const bill = opts.bills?.[id];
        if (!bill) {
          throw Object.assign(new Error('not found'), {
            statusCode: 404,
          });
        }
        return {
          data: bill,
        };
      },
    },
    alpha: {
      decisions: {
        // Never answers; a cancel rejects it, as the SDK does.
        create: (
          _request: unknown,
          options: {
            signal?: AbortSignal;
          },
        ) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(options.signal?.reason));
          }),
      },
    },
  };
  return {
    lookups,
  };
}

function answer(): unknown[] {
  return [
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: 'done',
          annotations: [],
        },
      ],
    },
  ];
}

const servers: FakeOpenRouter[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop();
  }
});

function startServer(): FakeOpenRouter {
  const server = startFakeOpenRouter(answer);
  servers.push(server);
  return server;
}

const agent = callModel<ContextData, string, string>({
  id: 'agent',
  model: 'test/model',
});

function harnessOver(
  storage: StorageAdapter,
  server?: FakeOpenRouter,
  agentGraph?: typeof agent,
): AgentHarness {
  return new AgentHarness({
    name: 'spend',
    params: {},
    agentGraph,
    callModelDefaults: {
      provider: 'openrouter',
      apiKey: 'sk-test',
      baseUrl: server?.baseUrl ?? 'http://localhost:1/api/v1',
    },
    environment: {
      storage: {
        adapter: storage,
      },
    },
  });
}

/** Poll `read` until `done` holds, or fail after two seconds. */
async function waitFor<T>(read: () => T | Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 2e3;
  for (;;) {
    const value = await read();
    if (done(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A harness that sees another harness's records as pending: it knows none are live. */
function pendingSeenBy(storage: StorageAdapter): () => Promise<PendingSpend[]> {
  const observer = harnessOver(storage);
  return () => observer.pendingSpend();
}

function record(over: Partial<DispatchRecord>): DispatchRecord {
  return {
    id: crypto.randomUUID(),
    kind: 'model',
    model: 'test/model',
    requestHash: 'h',
    inputTokens: 10,
    maxOutputTokens: 2e3,
    sentAt: new Date().toISOString(),
    ...over,
  };
}

/** The ceiling of `record()` under the fake prices: 10 prompt and 2000 completion tokens. */
const RECORD_CEILING = PROMPT_PRICE * 10 + COMPLETION_PRICE * 2e3;

const triage = decide({
  id: 'triage',
  model: 'typesafe/jev',
  questions: {
    urgent: {
      type: 'boolean',
      instructions: 'Is this urgent?',
    },
  },
});

//#endregion

describe('paid dispatch records', () => {
  it('writes the record before the call is sent and drops it once the bill arrives', async () => {
    const server = startServer();
    const storage = createInMemoryStorage();
    const log = createSpendLog(storage);
    const seen: Promise<DispatchRecord[]>[] = [];
    const harness = harnessOver(storage, server);
    const ctx = harness.createContext();
    const wrapped = callModel<ContextData, string, string>({
      id: 'agent',
      model: 'test/model',
      params: {
        maxTokens: 300,
      },
    });
    const original = server.rounds.push.bind(server.rounds);
    server.rounds.push = (...items) => {
      seen.push(log.list());
      return original(...items);
    };

    expect(await harness.run(wrapped, 'go', ctx)).toBe('done');

    const [atSend] = await Promise.all(seen);
    expect(atSend).toHaveLength(1);
    expect(atSend?.[0]).toMatchObject({
      kind: 'model',
      model: 'test/model',
      executionId: ctx.id,
      threadId: ctx.threadId,
      path: '/agent#0/round#0',
      maxOutputTokens: 300,
    });
    expect(atSend?.[0]?.requestHash).not.toBe('');
    expect(atSend?.[0]?.inputTokens).toBeGreaterThan(0);
    expect(await log.list()).toEqual([]);
    expect(ctx.cost).toBeCloseTo(ROUND_COST);
  });

  it('records nothing without durable storage', async () => {
    const server = startServer();
    const harness = new AgentHarness({
      name: 'spend',
      params: {},
      callModelDefaults: {
        provider: 'openrouter',
        apiKey: 'sk-test',
        baseUrl: server.baseUrl,
      },
    });
    const ctx = harness.createContext();

    expect(await harness.run(agent, 'go', ctx)).toBe('done');
    expect(await harness.pendingSpend()).toEqual([]);
    expect(await harness.reconcileSpend()).toEqual([]);
    expect(
      await harness.writeOffSpend('x', {
        assumedCost: 1,
      }),
    ).toBeUndefined();
  });
});

describe('a host killed mid-call', () => {
  it('settles the exact provider cost of a streamed round once the provider has priced it', async () => {
    const server = startServer();
    server.hangAt.add(1);
    const storage = createInMemoryStorage();
    const first = harnessOver(storage, server);
    const ctx = first.createContext();
    void first.run(agent, 'go', ctx).catch(() => {});

    // The generation id is stored from the response headers, before any body.
    const [pending] = await waitFor(pendingSeenBy(storage), (list) =>
      Boolean(list[0]?.generationId),
    );
    expect(pending).toMatchObject({
      kind: 'model',
      generationId: 'gen-1',
      executionId: ctx.id,
      path: '/agent#0/round#0',
    });

    // The host dies; a new one restores over the same storage.
    const second = harnessOver(storage, server);
    const sdk = useFakeSdk(second, {
      bills: {
        'gen-1': {
          totalCost: CUT_BILL,
          tokensPrompt: 12,
          tokensCompletion: 166,
        },
      },
    });
    const restored = await second.restore(ctx.id);
    assert(restored);
    await second.reconcileSpend({
      executionId: ctx.id,
    });

    expect(sdk.lookups).toContain('gen-1');
    expect(restored.billedCost).toBeCloseTo(CUT_BILL);
    expect(restored.cost).toBeCloseTo(CUT_BILL);
    expect(restored.tokens.output).toBe(166);
    expect(restored.heldCost).toBe(0);
    expect(await second.pendingSpend()).toEqual([]);
  });

  it('holds a decide() call at its ceiling, reports it, and never drops it', async () => {
    const storage = createInMemoryStorage();
    const first = harnessOver(storage);
    useFakeSdk(first, {
      decisionModel: true,
    });
    const ctx = first.createContext();
    void first.run(triage, 'help', ctx).catch(() => {});
    const [pending] = await waitFor(pendingSeenBy(storage), (list) => list.length === 1);
    expect(pending).toMatchObject({
      kind: 'decide',
      model: 'typesafe/jev',
      executionId: ctx.id,
      path: '/triage#0',
    });
    expect(pending?.generationId).toBeUndefined();

    const second = harnessOver(storage);
    useFakeSdk(second);
    const events: StreamEvent[] = [];
    const broadcaster = {
      emit: (event: StreamEvent) => events.push(event),
    };
    const restored = await second.restore(
      ctx.id,
      frameworkCast({
        _broadcaster: broadcaster,
      }),
    );
    assert(restored);
    const [held] = await second.pendingSpend(ctx.id);
    assert(held?.ceiling !== undefined);
    expect(held.ceiling).toBeCloseTo(
      PROMPT_PRICE * held.inputTokens + COMPLETION_PRICE * MAX_COMPLETION,
    );
    expect(restored.heldCost).toBeCloseTo(held.ceiling);
    expect(restored.billedCost).toBe(0);
    expect(events.map((event) => event.type)).toContain('spend:spend_pending');

    // No generation id, so reconciliation cannot price it: it stays held.
    expect(await second.reconcileSpend()).toEqual([]);
    expect(await second.pendingSpend()).toHaveLength(1);

    const settlement = await second.writeOffSpend(held.id, {
      assumedCost: 0.02,
    });
    expect(settlement).toMatchObject({
      id: held.id,
      cost: 0.02,
      writtenOff: true,
      executionId: ctx.id,
    });
    expect(restored.heldCost).toBe(0);
    expect(restored.billedCost).toBeCloseTo(0.02);
    expect(events.map((event) => event.type)).toContain('spend:spend_settled');
    expect(await second.pendingSpend()).toEqual([]);
    expect(
      await second.writeOffSpend(held.id, {
        assumedCost: 0.02,
      }),
    ).toBeUndefined();
  });

  it('settles a cut-off session turn into the session usage once', async () => {
    const server = startServer();
    server.hangAt.add(1);
    const storage = createInMemoryStorage();
    const first = harnessOver(storage, server, agent);
    await first.execute('go', {
      threadId: 't',
      messageId: 'm-1',
    });
    await waitFor(pendingSeenBy(storage), (list) => Boolean(list[0]?.generationId));

    const second = harnessOver(storage, server, agent);
    useFakeSdk(second, {
      bills: {
        'gen-1': {
          totalCost: CUT_BILL,
          tokensPrompt: 12,
          tokensCompletion: 166,
        },
      },
    });
    await second.execute('go', {
      threadId: 't',
      messageId: 'm-1',
    });
    const response = await second.getAgentResponse({
      threadId: 't',
    });
    expect(response.text).toBe('done');
    await second.reconcileSpend();

    const usage = second.getUsage({
      threadId: 't',
    });
    expect(usage.billedCost).toBeCloseTo(CUT_BILL + ROUND_COST);
    expect(usage.cost).toBeCloseTo(CUT_BILL + ROUND_COST);
    expect(usage.heldCost).toBeUndefined();
  });
});

describe('cancel mid-stream', () => {
  it('settles the cut-off round later instead of losing it', async () => {
    const server = startServer();
    server.hangAt.add(1);
    const storage = createInMemoryStorage();
    const harness = harnessOver(storage, server);
    useFakeSdk(harness, {
      bills: {
        'gen-1': {
          totalCost: CUT_BILL,
          tokensPrompt: 12,
          tokensCompletion: 166,
        },
      },
    });
    const ctx = harness.createContext();
    const run = harness.run(agent, 'go', ctx).catch(() => {});
    await waitFor(pendingSeenBy(storage), (list) => Boolean(list[0]?.generationId));

    await harness.cancel(ctx);
    await run;
    // The cut-off round is reconciled on its own; this waits for that lookup.
    await harness.reconcileSpend({
      executionId: ctx.id,
    });

    expect(ctx.billedCost).toBeCloseTo(CUT_BILL);
    expect(ctx.heldCost).toBe(0);
    expect(await harness.pendingSpend()).toEqual([]);
  });

  it('counts a response that arrived before the cancel', async () => {
    const storage = createInMemoryStorage();
    const harness = harnessOver(storage);
    let responded = false;
    frameworkCast<{
      client: unknown;
    }>(harness).client = {
      callModel: () => ({
        // The response is in, but the event stream never finishes.
        getFullResponsesStream: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise(() => {}),
          }),
        }),
        getResponse: async () => {
          responded = true;
          return {
            output: [],
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              cost: ROUND_COST,
            },
          };
        },
      }),
    };
    const ctx = harness.createContext();
    const run = harness.run(agent, 'go', ctx).catch(() => {});
    await waitFor(
      () => responded,
      (done) => done,
    );
    await waitFor(
      () => createSpendLog(storage).list(),
      (list) => list.length === 0,
    );

    await harness.cancel(ctx);
    await run;

    expect(ctx.cost).toBeCloseTo(ROUND_COST);
    expect(await createSpendLog(storage).list()).toEqual([]);
  });

  it('keeps polling while the provider has not priced the call yet', async () => {
    const storage = createInMemoryStorage();
    const harness = harnessOver(storage);
    const bills: Record<string, Bill> = {};
    const sdk = useFakeSdk(harness, {
      bills,
    });
    await createSpendLog(storage).put(
      record({
        generationId: 'gen-late',
      }),
    );
    setTimeout(() => {
      bills['gen-late'] = {
        totalCost: 0.003,
        tokensPrompt: 1,
        tokensCompletion: 2,
      };
    }, 300);

    const settled = await harness.reconcileSpend({
      patienceMs: 5e3,
    });

    expect(settled.map((s) => s.cost)).toEqual([
      0.003,
    ]);
    expect(sdk.lookups.length).toBeGreaterThan(1);
  });

  it('gives up after its patience and leaves the dispatch pending', async () => {
    const storage = createInMemoryStorage();
    const harness = harnessOver(storage);
    useFakeSdk(harness);
    await createSpendLog(storage).put(
      record({
        generationId: 'gen-never',
      }),
    );

    expect(
      await harness.reconcileSpend({
        patienceMs: 0,
      }),
    ).toEqual([]);
    expect(await harness.pendingSpend()).toHaveLength(1);
  });
});

describe('a graceful stop past its deadline', () => {
  it('keeps the rounds it cut off pending with their generation ids and reports them', async () => {
    const server = startServer();
    server.hangAt.add(1);
    server.hangAt.add(2);
    const storage = createInMemoryStorage();
    const harness = harnessOver(storage, server);
    useFakeSdk(harness);
    const events: StreamEvent[] = [];
    const ctx = Object.assign(harness.createContext(), {
      _broadcaster: {
        emit: (event: StreamEvent) => events.push(event),
      },
    });
    const both = inParallel({
      id: 'both',
      mode: 'all',
      paths: () => [
        agent,
        callModel<ContextData, string, string>({
          id: 'other',
          model: 'test/model',
        }),
      ],
      merge: (results: unknown[]) => results,
    });
    const run = harness.run(both, 'go', ctx).catch(() => {});
    await waitFor(
      () => server.rounds.length,
      (count) => count === 2,
    );

    await harness.cancel(ctx, {
      drainMs: 50,
    });
    await run;
    const pending = await waitFor(
      () => harness.pendingSpend(ctx.id),
      (list) => list.length === 2,
    );

    expect(pending.map((p) => p.generationId).sort()).toEqual([
      'gen-1',
      'gen-2',
    ]);
    const finished = events.find((event) => event.type === 'spend:drain_finished');
    assert(finished && 'data' in finished);
    const data = frameworkCast<{
      reason: string;
      finished: unknown[];
      cutOff: {
        dispatchId?: string;
        generationId?: string;
      }[];
    }>(finished.data);
    expect(data.reason).toBe('deadline');
    expect(data.finished).toEqual([]);
    expect(
      data.cutOff.map((call) => [
        call.dispatchId,
        call.generationId,
      ]),
    ).toEqual(
      expect.arrayContaining(
        pending.map((p) => [
          p.id,
          p.generationId,
        ]),
      ),
    );
    expect(data.cutOff).toHaveLength(2);
  });
});

describe('held spend and budgets', () => {
  /** A resumed run whose cut-off attempt left one dispatch held at RECORD_CEILING. */
  async function restoredWithHold(): Promise<{
    harness: AgentHarness;
    ctx: Context;
  }> {
    const storage = createInMemoryStorage();
    const first = harnessOver(storage);
    const original = first.createContext();
    await first.checkpoint(original);
    await createSpendLog(storage).put(
      record({
        executionId: original.id,
      }),
    );
    const harness = harnessOver(storage);
    useFakeSdk(harness);
    const ctx = await harness.restore(original.id);
    assert(ctx);
    return {
      harness,
      ctx,
    };
  }

  function budgetedLoop(
    onIteration: () => void,
  ): ReturnType<typeof loop<ContextData, string, string>> {
    return loop<ContextData, string, string>({
      id: 'budgeted',
      steps: [
        runCode<ContextData, string, string>({
          id: 'spend',
          durable: false,
          execute: async (input, ctx) => {
            onIteration();
            recordUsage(ctx, {
              inputTokens: 0,
              outputTokens: 0,
              cost: ROUND_COST,
            });
            return input;
          },
        }),
      ],
      until: until.maxCost(0.05),
      maxIterations: 10,
    });
  }

  it('a resumed run stops at until.maxCost counting the hold', async () => {
    const { harness, ctx } = await restoredWithHold();
    expect(ctx.heldCost).toBeCloseTo(RECORD_CEILING);
    let iterations = 0;

    await harness.run(
      budgetedLoop(() => iterations++),
      'go',
      ctx,
    );

    // 0.01 per iteration plus the 0.02001 hold crosses 0.05 on the third.
    expect(iterations).toBe(3);
    expect(ctx.cost).toBeCloseTo(0.03);
  });

  it('a restore in the same process takes over the hold of a cancelled call', async () => {
    const storage = createInMemoryStorage();
    const harness = harnessOver(storage);
    useFakeSdk(harness, {
      decisionModel: true,
    });
    const ctx = harness.createContext();
    const run = harness.run(triage, 'help', ctx).catch(() => {});
    await waitFor(
      () => createSpendLog(storage).list(),
      (list) => list.length === 1,
    );
    await harness.cancel(ctx);
    await run;
    await waitFor(
      () => ctx.heldCost,
      (held) => held > 0,
    );
    const held = ctx.heldCost;

    const restored = await harness.restore(ctx.id);

    assert(restored);
    expect(restored.heldCost).toBeCloseTo(held);
    expect(ctx.heldCost).toBe(0);
  });

  it('a run with nothing held spends the whole budget', async () => {
    const harness = harnessOver(createInMemoryStorage());
    const ctx = harness.createContext();
    let iterations = 0;

    await harness.run(
      budgetedLoop(() => iterations++),
      'go',
      ctx,
    );

    expect(iterations).toBe(5);
  });

  it('reports the hold beside cost and billedCost in session usage', async () => {
    const storage = createInMemoryStorage();
    const harness = harnessOver(storage);
    useFakeSdk(harness);
    await createSpendLog(storage).put(
      record({
        threadId: 't',
      }),
    );

    await harness.reconcileSpend({
      patienceMs: 0,
    });

    expect(
      harness.getUsage({
        threadId: 't',
      }).heldCost,
    ).toBeCloseTo(RECORD_CEILING);
  });

  it('flags a dispatch whose model publishes no price as unbounded', async () => {
    const storage = createInMemoryStorage();
    const harness = harnessOver(storage);
    await createSpendLog(storage).put(record({}));

    const [pending] = await harness.pendingSpend();

    expect(pending?.ceiling).toBeUndefined();
  });
});

describe('discards', () => {
  it('clearing a checkpoint keeps its unsettled dispatches reconcilable', async () => {
    const storage = createInMemoryStorage();
    const first = harnessOver(storage);
    const ctx = first.createContext();
    await first.checkpoint(ctx);
    await createSpendLog(storage).put(
      record({
        executionId: ctx.id,
        generationId: 'gen-kept',
      }),
    );

    await first.clearCheckpoint(ctx.id);
    expect(await first.restore(ctx.id)).toBeNull();
    expect(await first.pendingSpend(ctx.id)).toHaveLength(1);

    useFakeSdk(first, {
      bills: {
        'gen-kept': {
          totalCost: 0.004,
          tokensPrompt: 1,
          tokensCompletion: 1,
        },
      },
    });
    const settled = await first.reconcileSpend();
    expect(settled).toEqual([
      expect.objectContaining({
        executionId: ctx.id,
        cost: 0.004,
      }),
    ]);
    expect(await first.pendingSpend()).toEqual([]);
  });
});

describe('a provider that refuses the call', () => {
  it('drops the record: an error status means nothing was generated', async () => {
    const storage = createInMemoryStorage();
    const harness = harnessOver(storage);
    frameworkCast<{
      client: unknown;
    }>(harness).client = {
      callModel: () => ({
        async *getFullResponsesStream() {},
        getResponse: () =>
          Promise.reject(
            Object.assign(new Error('bad request'), {
              statusCode: 400,
            }),
          ),
      }),
    };
    const ctx = harness.createContext();

    await expect(harness.run(agent, 'go', ctx)).rejects.toThrow('bad request');

    expect(await createSpendLog(storage).list()).toEqual([]);
  });

  it('keeps the record of a decide() call whose 2xx response failed to parse', async () => {
    const storage = createInMemoryStorage();
    const harness = harnessOver(storage);
    useFakeSdk(harness, {
      decisionModel: true,
    });
    frameworkCast<{
      sdkClient: {
        alpha: unknown;
      };
    }>(harness).sdkClient.alpha = {
      decisions: {
        create: () =>
          Promise.reject(
            Object.assign(new Error('Response validation failed'), {
              statusCode: 200,
            }),
          ),
      },
    };

    await expect(harness.run(triage, 'help', harness.createContext())).rejects.toThrow();

    expect(await createSpendLog(storage).list()).toHaveLength(1);
  });

  it('takes the generation id from the stream when no header carried it', async () => {
    const storage = createInMemoryStorage();
    const harness = harnessOver(storage);
    const headers: unknown[] = [];
    frameworkCast<{
      client: unknown;
    }>(harness).client = {
      callModel: (
        _request: unknown,
        options: {
          headers?: unknown;
        },
      ) => {
        headers.push(options.headers);
        return {
          async *getFullResponsesStream() {
            yield {
              type: 'response.created',
              response: {
                id: 'gen-stream',
              },
            };
          },
          getResponse: () => new Promise(() => {}),
        };
      },
    };
    const ctx = harness.createContext();
    const run = harness.run(agent, 'go', ctx).catch(() => {});
    await waitFor(pendingSeenBy(storage), (list) => list[0]?.generationId === 'gen-stream');
    await harness.cancel(ctx);
    await run;

    const [pending] = await harness.pendingSpend();
    expect(pending?.generationId).toBe('gen-stream');
    expect(headers[0]).toEqual({
      'x-noetic-dispatch': pending?.id,
    });
  });
});

describe('settling once', () => {
  it('does not charge a dispatch another harness settled while this one polled', async () => {
    const storage = createInMemoryStorage();
    const log = createSpendLog(storage);
    const harness = harnessOver(storage);
    const bills: Record<string, Bill> = {};
    useFakeSdk(harness, {
      bills,
    });
    const settledElsewhere = record({
      generationId: 'gen-elsewhere',
    });
    await log.put(settledElsewhere);
    setTimeout(() => {
      void log.remove(settledElsewhere.id);
      bills['gen-elsewhere'] = {
        totalCost: 0.5,
        tokensPrompt: 1,
        tokensCompletion: 1,
      };
    }, 200);

    expect(
      await harness.reconcileSpend({
        patienceMs: 5e3,
      }),
    ).toEqual([]);
  });

  it('a reconcile racing a write-off leaves nothing held', async () => {
    const memory = createInMemoryStorage();
    const storage: StorageAdapter = Object.assign(Object.create(memory), {
      delete: async (key: string) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return memory.delete(key);
      },
    });
    const harness = harnessOver(storage);
    useFakeSdk(harness);
    const unpriced = record({
      threadId: 't',
    });
    await createSpendLog(storage).put(unpriced);
    await harness.reconcileSpend({
      patienceMs: 0,
    });

    const writeOff = harness.writeOffSpend(unpriced.id, {
      assumedCost: 0.1,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await harness.reconcileSpend({
      patienceMs: 0,
    });

    expect(await writeOff).toMatchObject({
      cost: 0.1,
    });
    expect(
      harness.getUsage({
        threadId: 't',
      }).heldCost,
    ).toBeUndefined();
  });
});
