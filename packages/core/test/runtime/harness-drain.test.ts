// Graceful stop: `cancel(ctx, { drainMs })` and `abort({ drainMs })` hold back new
// steps, rounds and tool calls, let model calls in flight finish, then cancel.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  Context,
  ContextData,
  DecideRequest,
  DecideResponse,
  Item,
  Step,
  StreamEvent,
} from '@noetic-tools/types';
import { frameworkCast, isNoeticError } from '@noetic-tools/types';
import { z } from 'zod';
import { inParallel } from '../../src/builders/control-flow-builders';
import { decide } from '../../src/builders/decide-builders';
import { callModel, runCode } from '../../src/builders/step-builders';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createCheckpointStore } from '../../src/runtime/durable/checkpoint-store';
import { createStepLedgerStore } from '../../src/runtime/durable/step-ledger';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { makeMessage, sleep } from '../_helpers';

//#region Fakes

interface EmittedEvent {
  source: string;
  type: string;
  data: Record<string, unknown>;
}

/**
 * A provider that answers a round for model `m` after `latencyMs[m]`, replies
 * with a function call for `tools/model` and a message otherwise, charges 10
 * input / 5 output tokens and $0.01 a round, and stops when its signal aborts.
 */
class SlowClient {
  started = 0;
  aborted = 0;

  constructor(private readonly latencyMs: Record<string, number>) {}

  callModel(
    params: {
      model: string;
    },
    options: {
      signal: AbortSignal;
    },
  ): {
    getFullResponsesStream: () => AsyncIterable<unknown>;
    getResponse: () => Promise<unknown>;
  } {
    this.started += 1;
    const output =
      params.model === 'tools/model'
        ? [
            lookupCall(),
          ]
        : [
            makeMessage('assistant', 'done'),
          ];
    let answered = false;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        answered = true;
        resolve({
          id: `resp-${crypto.randomUUID()}`,
          status: 'completed',
          output,
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cost: 0.01,
          },
        });
      }, this.latencyMs[params.model] ?? 0);
      options.signal.addEventListener(
        'abort',
        () => {
          if (answered) {
            return;
          }
          this.aborted += 1;
          clearTimeout(timer);
          reject(new Error('aborted'));
        },
        {
          once: true,
        },
      );
    });
    response.catch(() => {});
    return {
      async *getFullResponsesStream() {
        await response.catch(() => {});
      },
      getResponse: () => response,
    };
  }
}

function lookupCall(): Item {
  return frameworkCast<Item>({
    id: `fc-${crypto.randomUUID()}`,
    type: 'function_call',
    status: 'completed',
    callId: `call-${crypto.randomUUID()}`,
    name: 'lookup',
    arguments: '{}',
  });
}

type Storage = ReturnType<typeof createInMemoryStorage>;

function makeHarness(client: SlowClient, storage?: Storage): AgentHarness {
  const harness = new AgentHarness({
    name: 'drain',
    params: {},
    ...(storage
      ? {
          environment: {
            storage: {
              adapter: storage,
              checkpointStore: createCheckpointStore({
                storage,
              }),
            },
          },
        }
      : {}),
  });
  frameworkCast<{
    client: unknown;
  }>(harness).client = client;
  return harness;
}

/** A root context whose framework events land in `events`. */
function watchedContext(harness: AgentHarness, events: EmittedEvent[]): Context {
  return Object.assign(harness.createContext(), {
    _broadcaster: {
      emit: (event: EmittedEvent) => {
        events.push(event);
      },
    },
  });
}

function ask(id: string, model: string): Step<ContextData, unknown, unknown> {
  return callModel({
    id,
    model,
    instructions: 'answer',
  });
}

/** Run `steps` one after another, the way the workflow hydrator composes them. */
function inTurn(harness: AgentHarness, id: string, steps: Step<ContextData, unknown, unknown>[]) {
  return runCode({
    id,
    execute: async (input: unknown, ctx: Context) => {
      let output = input;
      for (const next of steps) {
        output = await harness.run(next, output, ctx);
      }
      return output;
    },
  });
}

function sideBySide(paths: Step<ContextData, unknown, unknown>[]) {
  return inParallel({
    id: 'both',
    mode: 'all',
    paths: () => paths,
    merge: (results: unknown[]) => results,
  });
}

async function collect(stream: AsyncIterable<StreamEvent>, into: StreamEvent[]): Promise<void> {
  for await (const event of stream) {
    into.push(event);
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) {
    await sleep(5);
  }
  assert(check(), 'condition never held');
}

function eventData(events: EmittedEvent[], name: string): Record<string, unknown> {
  const event = events.find((e) => e.type === `drain:${name}`);
  assert(event, `no ${name} event`);
  return event.data;
}

function callsIn(data: Record<string, unknown>, key: string): unknown[] {
  const calls = data[key];
  assert(Array.isArray(calls));
  return calls;
}

async function cancelledError(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
  } catch (e) {
    return isNoeticError(e) ? e.noeticError.kind : String(e);
  }
  return undefined;
}

//#endregion

describe('cancel with drainMs', () => {
  it('lets both rounds in flight finish, charges and records them, and starts nothing new', async () => {
    const storage = createInMemoryStorage();
    const client = new SlowClient({
      fast: 30,
      slow: 150,
    });
    const harness = makeHarness(client, storage);
    const events: EmittedEvent[] = [];
    const ctx = watchedContext(harness, events);
    // `left-2` would start while `right` is still in flight; the drain holds it.
    const graph = inTurn(harness, 'flow', [
      sideBySide([
        inTurn(harness, 'left-path', [
          ask('left', 'fast'),
          ask('left-2', 'fast'),
        ]),
        ask('right', 'slow'),
      ]),
      ask('after', 'fast'),
    ]);
    const run = harness.run(graph, 'go', ctx);
    await waitFor(() => client.started === 2);

    await harness.cancel(ctx, {
      reason: 'SIGTERM',
      drainMs: 2e3,
    });

    expect(await cancelledError(run)).toBe('cancelled');
    expect(client.started).toBe(2);
    expect(client.aborted).toBe(0);
    expect(ctx.cost).toBeCloseTo(0.02);
    expect(ctx.tokens.output).toBe(10);
    expect(ctx.abortReason).toBe('SIGTERM');
    const recorded = [
      ...(
        await createStepLedgerStore({
          storage,
        }).load(ctx.id)
      ).entries.values(),
    ].map((entry) => entry.stepId);
    expect(recorded).toEqual(
      expect.arrayContaining([
        'left',
        'right',
      ]),
    );
    expect(recorded).not.toContain('left-2');
    expect(recorded).not.toContain('after');
    expect(callsIn(eventData(events, 'drain_started'), 'inFlight')).toHaveLength(2);
    const finished = eventData(events, 'drain_finished');
    expect(finished.reason).toBe('settled');
    expect(callsIn(finished, 'finished')).toHaveLength(2);
    expect(callsIn(finished, 'cutOff')).toHaveLength(0);
  });

  it('cancels the rounds still in flight at the deadline and reports them cut off', async () => {
    const client = new SlowClient({
      slow: 5e3,
    });
    const harness = makeHarness(client);
    const events: EmittedEvent[] = [];
    const ctx = watchedContext(harness, events);
    const run = harness.run(
      sideBySide([
        ask('left', 'slow'),
        ask('right', 'slow'),
      ]),
      'go',
      ctx,
    );
    await waitFor(() => client.started === 2);
    const startedAt = Date.now();

    const report = await harness.cancel(ctx, {
      drainMs: 40,
    });

    expect(Date.now() - startedAt).toBeLessThan(2e3);
    expect(await cancelledError(run)).toBe('cancelled');
    expect(client.started).toBe(2);
    expect(client.aborted).toBe(2);
    expect(ctx.cost).toBe(0);
    const finished = eventData(events, 'drain_finished');
    expect(finished.reason).toBe('deadline');
    expect(callsIn(finished, 'finished')).toHaveLength(0);
    expect(callsIn(finished, 'cutOff')).toEqual(
      expect.arrayContaining([
        {
          kind: 'model_round',
          model: 'slow',
          executionId: expect.any(String),
          round: 0,
        },
      ]),
    );
    expect(callsIn(finished, 'cutOff')).toHaveLength(2);
    expect(finished).toEqual({
      ...report,
    });
  });

  it('cancels at once on a second cancel during the drain', async () => {
    const client = new SlowClient({
      slow: 5e3,
    });
    const harness = makeHarness(client);
    const events: EmittedEvent[] = [];
    const ctx = watchedContext(harness, events);
    const run = harness.run(
      sideBySide([
        ask('left', 'slow'),
        ask('right', 'slow'),
      ]),
      'go',
      ctx,
    );
    await waitFor(() => client.started === 2);

    const first = harness.cancel(ctx, {
      drainMs: 60e3,
    });
    const startedAt = Date.now();
    const second = await harness.cancel(ctx, 'now');
    const report = await first;

    expect(Date.now() - startedAt).toBeLessThan(2e3);
    expect(await cancelledError(run)).toBe('cancelled');
    expect(client.aborted).toBe(2);
    const finished = eventData(events, 'drain_finished');
    expect(finished.reason).toBe('stopped');
    expect(callsIn(finished, 'cutOff')).toHaveLength(2);
    expect(finished).toEqual({
      ...second,
    });
    expect(report).toBe(second);
  });

  it('resolves with a report whose finished round carries the cost it was charged', async () => {
    let toolRan = false;
    const lookup = tool({
      name: 'lookup',
      description: 'lookup',
      input: z.object({}),
      output: z.object({}),
      execute: async () => {
        toolRan = true;
        return {};
      },
    });
    const client = new SlowClient({
      'tools/model': 60,
    });
    const harness = makeHarness(client);
    const events: EmittedEvent[] = [];
    const ctx = watchedContext(harness, events);
    // A tool loop: once its round returns, the drain holds it at its tool call,
    // so the step ends cancelled and never publishes `lastStepMeta`.
    const run = harness.run(
      callModel({
        id: 'agent',
        model: 'tools/model',
        instructions: 'use tools',
        tools: [
          lookup,
        ],
      }),
      'go',
      ctx,
    );
    await waitFor(() => client.started === 1);

    const report = await harness.cancel(ctx, {
      drainMs: 2e3,
    });

    expect(await cancelledError(run)).toBe('cancelled');
    expect(toolRan).toBe(false);
    expect(ctx.lastStepMeta).toBeNull();
    assert(report);
    expect(report.reason).toBe('settled');
    expect(report.executionId).toBe(ctx.id);
    expect(report.cutOff).toEqual([]);
    expect(report.finished).toEqual([
      {
        kind: 'model_round',
        model: 'tools/model',
        executionId: ctx.id,
        round: 0,
        cost: 0.01,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
        },
      },
    ]);
    expect(report.finished[0]?.cost).toBe(ctx.cost);
    expect(ctx.tokens.output).toBe(5);
    expect(eventData(events, 'drain_finished')).toEqual({
      ...report,
    });
  });

  it('reports what a decide call that finished in the drain cost', async () => {
    const harness = new AgentHarness({
      name: 'drain',
      params: {},
      _testDecide: async (): Promise<DecideResponse> => {
        await sleep(40);
        return {
          answers: {
            urgent: {
              type: 'boolean',
              value: true,
              probability: 0.9,
            },
          },
          source: 'native',
          modelId: 'typesafe/jev-1.14',
          usage: {
            inputTokens: 20,
            outputTokens: 2,
          },
          cost: 0.003,
        };
      },
    });
    const events: EmittedEvent[] = [];
    const ctx = watchedContext(harness, events);
    const run = harness.run(
      inTurn(harness, 'flow', [
        decide({
          id: 'triage',
          model: 'typesafe/jev-1.14',
          questions: {
            urgent: {
              type: 'boolean',
              instructions: 'Is it urgent?',
            },
          },
        }),
        runCode({
          id: 'after',
          execute: async () => 'after',
        }),
      ]),
      'help',
      ctx,
    );
    await waitFor(() => events.length > 0);
    await sleep(5);

    const report = await harness.cancel(ctx, {
      drainMs: 2e3,
    });

    expect(await cancelledError(run)).toBe('cancelled');
    assert(report);
    expect(report.finished).toEqual([
      {
        kind: 'decide',
        model: 'typesafe/jev-1.14',
        executionId: ctx.id,
        cost: 0.003,
        usage: {
          inputTokens: 20,
          outputTokens: 2,
        },
      },
    ]);
    expect(ctx.cost).toBeCloseTo(0.003);
  });

  it('resolves undefined when no drain ran', async () => {
    const harness = makeHarness(new SlowClient({}));
    const ctx = harness.createContext();

    expect(await harness.cancel(ctx, 'now')).toBeUndefined();
    expect(
      await harness.cancel(ctx, {
        drainMs: 1e3,
      }),
    ).toBeUndefined();
  });

  it("reports a run() execution's status while it runs, drains and stops", async () => {
    const client = new SlowClient({
      fast: 80,
    });
    const harness = makeHarness(client);
    const ctx = harness.createContext();
    const scope = {
      executionId: ctx.id,
    };
    expect(harness.getStatus(scope)).toEqual({
      kind: 'idle',
    });
    const run = harness.run(
      inTurn(harness, 'flow', [
        ask('first', 'fast'),
        ask('second', 'fast'),
      ]),
      'go',
      ctx,
    );
    await waitFor(() => client.started === 1);
    expect(harness.getStatus(scope).kind).toBe('generating');
    // Step code reads the same status through its context, typed without a turn.
    const viaContext = ctx.harness.getStatus(scope);
    expect(viaContext).toEqual(harness.getStatus(scope));
    // @ts-expect-error an execution's status carries no turnId
    expect(viaContext.turnId).toBeUndefined();

    const stopping = harness.cancel(ctx, {
      drainMs: 2e3,
    });
    const draining = harness.getStatus(scope);
    assert(draining.kind === 'draining');
    expect(draining.deadline).toBeGreaterThan(Date.now());
    await stopping;
    expect(harness.getStatus(scope).kind).toBe('aborting');

    expect(await cancelledError(run)).toBe('cancelled');
    expect(harness.getStatus(scope)).toEqual({
      kind: 'idle',
    });
    // The session's default thread is a different scope and stays idle.
    expect(harness.getStatus().kind).toBe('idle');
  });

  it('holds back the tool calls of a round that finished while another is in flight', async () => {
    let toolRan = false;
    const lookup = tool({
      name: 'lookup',
      description: 'lookup',
      input: z.object({}),
      output: z.object({}),
      execute: async () => {
        toolRan = true;
        return {};
      },
    });
    const client = new SlowClient({
      'tools/model': 30,
      slow: 150,
    });
    const harness = makeHarness(client);
    const ctx = harness.createContext();
    const agent = callModel({
      id: 'agent',
      model: 'tools/model',
      instructions: 'use tools',
      tools: [
        lookup,
      ],
    });
    const run = harness.run(
      sideBySide([
        agent,
        ask('right', 'slow'),
      ]),
      'go',
      ctx,
    );
    await waitFor(() => client.started === 2);

    await harness.cancel(ctx, {
      drainMs: 2e3,
    });

    expect(await cancelledError(run)).toBe('cancelled');
    expect(toolRan).toBe(false);
    expect(client.started).toBe(2);
    expect(client.aborted).toBe(0);
    expect(ctx.cost).toBeCloseTo(0.02);
  });

  it('keeps a call in flight until its own step ends, not a sibling step on the same context', async () => {
    const storage = createInMemoryStorage();
    const client = new SlowClient({
      fast: 30,
    });
    const harness = makeHarness(client, storage);
    const events: EmittedEvent[] = [];
    const ctx = watchedContext(harness, events);
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let answered = false;
    const answer = runCode({
      id: 'answer',
      execute: async (_input: unknown, stepCtx: Context) => {
        await stepCtx.harness.callModel({
          model: 'fast',
          items: [],
          ctx: stepCtx,
        });
        answered = true;
        await gate;
        return 'answered';
      },
    });
    const watch = runCode({
      id: 'watch',
      execute: async () => {
        await waitFor(() => answered);
        return 'watched';
      },
    });
    // Two dispatches on one context, side by side, as a host fanning out by hand.
    const graph = runCode({
      id: 'flow',
      execute: (input: unknown, flowCtx: Context) =>
        Promise.all([
          harness.run(watch, input, flowCtx),
          harness.run(answer, input, flowCtx),
        ]),
    });
    const run = harness.run(graph, 'go', ctx);
    await waitFor(() => client.started === 1);

    const stopping = harness.cancel(ctx, {
      drainMs: 2e3,
    });
    await waitFor(() => answered);
    await sleep(30);
    const endedEarly = events.some((e) => e.type === 'drain:drain_finished');
    open();
    await stopping;

    // Nothing new was due to start, so the run ends on its own, the answer kept.
    expect(endedEarly).toBe(false);
    expect(await run).toEqual([
      'watched',
      'answered',
    ]);
    expect(eventData(events, 'drain_finished').reason).toBe('settled');
  });

  it('starts no new round once a tool that was running when the drain began returns', async () => {
    let toolRan = false;
    const lookup = tool({
      name: 'lookup',
      description: 'lookup',
      input: z.object({}),
      output: z.object({}),
      execute: async () => {
        await sleep(80);
        toolRan = true;
        return {};
      },
    });
    const client = new SlowClient({
      'tools/model': 10,
      slow: 300,
    });
    const harness = makeHarness(client);
    const ctx = harness.createContext();
    const agent = callModel({
      id: 'agent',
      model: 'tools/model',
      instructions: 'use tools',
      tools: [
        lookup,
      ],
    });
    const run = harness.run(
      sideBySide([
        agent,
        ask('right', 'slow'),
      ]),
      'go',
      ctx,
    );
    await waitFor(() => client.started === 2);
    await sleep(30);

    await harness.cancel(ctx, {
      drainMs: 2e3,
    });

    expect(await cancelledError(run)).toBe('cancelled');
    expect(toolRan).toBe(true);
    expect(client.started).toBe(2);
    expect(client.aborted).toBe(0);
  });

  it('sends no decide call whose step was still preparing when the drain began', async () => {
    let decided = 0;
    let resolving = false;
    const harness = new AgentHarness({
      name: 'drain',
      params: {},
      _testDecide: async (): Promise<DecideResponse> => {
        decided += 1;
        throw new Error('sent during a drain');
      },
    });
    const ctx = harness.createContext();
    const run = harness.run(
      decide({
        id: 'triage',
        model: async () => {
          resolving = true;
          await sleep(40);
          return 'typesafe/jev-1.14';
        },
        questions: {
          urgent: {
            type: 'boolean',
            instructions: 'Is it urgent?',
          },
        },
      }),
      'help',
      ctx,
    );
    await waitFor(() => resolving);

    await harness.cancel(ctx, {
      drainMs: 2e3,
    });

    expect(await cancelledError(run)).toBe('cancelled');
    expect(decided).toBe(0);
  });

  it('settles at once when nothing is in flight', async () => {
    const client = new SlowClient({});
    const harness = makeHarness(client);
    const events: EmittedEvent[] = [];
    const ctx = watchedContext(harness, events);

    await harness.cancel(ctx, {
      drainMs: 60e3,
    });

    expect(ctx.aborted).toBe(true);
    expect(eventData(events, 'drain_finished').reason).toBe('settled');
  });

  it('counts a decide call as in flight and cuts it off at the deadline', async () => {
    let decideAborted = false;
    const harness = new AgentHarness({
      name: 'drain',
      params: {},
      _testDecide: (request: DecideRequest) =>
        new Promise<DecideResponse>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            decideAborted = true;
            reject(new Error('aborted'));
          });
        }),
    });
    const events: EmittedEvent[] = [];
    const ctx = watchedContext(harness, events);
    const run = harness.run(
      decide({
        id: 'triage',
        model: 'typesafe/jev-1.14',
        questions: {
          urgent: {
            type: 'boolean',
            instructions: 'Is it urgent?',
          },
        },
      }),
      'help',
      ctx,
    );
    await waitFor(() => events.length > 0);
    await sleep(5);

    await harness.cancel(ctx, {
      drainMs: 20,
    });

    expect(await cancelledError(run)).toBe('cancelled');
    expect(decideAborted).toBe(true);
    expect(callsIn(eventData(events, 'drain_finished'), 'cutOff')).toEqual([
      {
        kind: 'decide',
        model: 'typesafe/jev-1.14',
        executionId: expect.any(String),
      },
    ]);
  });
});

describe('abort with drainMs', () => {
  it("reports 'draining' while the turn's round finishes, then aborts the turn", async () => {
    const client = new SlowClient({
      fast: 80,
    });
    const harness = new AgentHarness({
      name: 'drain',
      params: {},
      agentGraph: runCode<ContextData, string, string>({
        id: 'turn',
        execute: async (input, ctx) => {
          await ctx.harness.run(ask('first', 'fast'), input, ctx);
          return String(await ctx.harness.run(ask('second', 'fast'), input, ctx));
        },
      }),
    });
    frameworkCast<{
      client: unknown;
    }>(harness).client = client;
    const events: StreamEvent[] = [];
    const stream = harness.getFullStream();
    void collect(stream, events);
    await harness.execute('hi');
    await waitFor(() => client.started === 1);

    const stopping = harness.abort({
      drainMs: 2e3,
    });
    const status = harness.getStatus();

    assert(status.kind === 'draining');
    expect(status.deadline).toBeGreaterThan(Date.now());
    const report = await stopping;
    assert(report);
    expect(report.reason).toBe('settled');
    expect(report.finished).toEqual([
      expect.objectContaining({
        kind: 'model_round',
        model: 'fast',
        cost: 0.01,
      }),
    ]);
    expect(harness.getStatus().kind).toBe('idle');
    expect(client.started).toBe(1);
    expect(client.aborted).toBe(0);
    expect(harness.getUsage().cost).toBeCloseTo(0.01);
    const types = events.map((e) => e.type);
    expect(types).toContain('drain:drain_started');
    expect(types).toContain('drain:drain_finished');
    expect(types).toContain('drain:turn_aborted');
  });
});
