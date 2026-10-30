// The model loop records each finished round, so a tool-using step cut off mid-loop
// resumes on a new harness without paying for — or re-running the tools of — the
// rounds it already finished. Drives the real model client against a fake server.

import { afterEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type { ContextData } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { callModel } from '../../src/builders/step-builders';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createStepLedgerStore } from '../../src/runtime/durable/step-ledger';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import type { SessionCtxExtension } from '../../src/runtime/message-queue';
import { MessageQueue } from '../../src/runtime/message-queue';
import type { FakeOpenRouter } from '../_helpers';
import { startFakeOpenRouter } from '../_helpers';

//#region Fixtures

interface EmittedEvent {
  type: string;
  data: Record<string, unknown>;
}

const CHARGES = 5;

/** Asks for `charge` once per round until it has seen CHARGES results, then answers. */
function chargingModel(input: unknown[]): unknown[] {
  const done = input.filter(
    (entry) =>
      z
        .object({
          type: z.literal('function_call_output'),
        })
        .safeParse(entry).success,
  ).length;
  if (done < CHARGES) {
    return [
      {
        type: 'function_call',
        id: `fc_${done}`,
        call_id: `call_${done}`,
        name: 'charge',
        arguments: JSON.stringify({
          n: done + 1,
        }),
        status: 'completed',
      },
    ];
  }
  return [
    {
      type: 'message',
      id: 'msg_done',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: `charged ${done}`,
          annotations: [],
        },
      ],
    },
  ];
}

/** `chargingModel`, thinking before each reply. */
function thinkingModel(input: unknown[]): unknown[] {
  return [
    {
      type: 'reasoning',
      id: `rs_${input.length}`,
      summary: [],
    },
    ...chargingModel(input),
  ];
}

function setup(
  onCharge?: (n: number) => void,
  reply: (input: unknown[]) => unknown[] = chargingModel,
): {
  server: FakeOpenRouter;
  charges: number[];
  harness: (storage: StorageAdapter) => AgentHarness;
  agent: (durable?: boolean) => ReturnType<typeof callModel<ContextData, string, string>>;
} {
  const server = startFakeOpenRouter(reply);
  servers.push(server);
  const charges: number[] = [];
  const charge = tool({
    name: 'charge',
    description: 'Charge a card once.',
    input: z.object({
      n: z.number(),
    }),
    output: z.object({
      ok: z.boolean(),
    }),
    execute: async ({ n }) => {
      charges.push(n);
      onCharge?.(n);
      return {
        ok: true,
      };
    },
  });
  return {
    server,
    charges,
    harness: (storage) =>
      new AgentHarness({
        name: 'rounds',
        params: {},
        callModelDefaults: {
          provider: 'openrouter',
          apiKey: 'sk-test',
          baseUrl: server.baseUrl,
        },
        environment: {
          storage: {
            adapter: storage,
          },
        },
      }),
    agent: (durable = true) =>
      callModel<ContextData, string, string>({
        id: 'agent',
        model: 'test/model',
        tools: [
          charge,
        ],
        durable,
      }),
  };
}

/** The `model_round_recorded` events a context's broadcaster saw. */
function watchRecords(ctx: object): EmittedEvent[] {
  const events: EmittedEvent[] = [];
  frameworkCast<{
    _broadcaster: unknown;
  }>(ctx)._broadcaster = {
    emit: (event: EmittedEvent) => {
      if (event.type === 'rounds:model_round_recorded') {
        events.push(event);
      }
    },
  };
  return events;
}

const servers: FakeOpenRouter[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop();
  }
});

//#endregion

describe('durable model rounds', () => {
  it('resumes a tool loop cut off mid-round without re-running finished rounds', async () => {
    const { server, charges, harness, agent } = setup();
    server.dropAt.add(5);
    const storage = createInMemoryStorage();
    const first = harness(storage);
    const ctx = first.createContext();
    await expect(first.run(agent(), 'go', ctx)).rejects.toThrow();
    expect(charges).toEqual([
      1,
      2,
      3,
      4,
    ]);

    const next = harness(storage);
    const resumed = await next.restore(ctx.id);
    assert(resumed);
    expect(await next.run(agent(), 'go', resumed)).toBe('charged 5');

    // The cut-off round was asked again on the conversation it was asked on before,
    // then the final one; every card was charged exactly once.
    expect(server.rounds).toHaveLength(7);
    expect(server.rounds[5]?.input).toEqual(server.rounds[4]?.input);
    expect(charges).toEqual([
      1,
      2,
      3,
      4,
      5,
    ]);
    // Replayed rounds still count toward the step's usage — they were paid for once.
    expect(resumed.tokens.total).toBe(6 * 15);
  });

  it('counts each recorded round once when a failed run is retried in place', async () => {
    const { server, harness, agent } = setup();
    server.dropAt.add(5);
    const storage = createInMemoryStorage();
    const host = harness(storage);
    const ctx = host.createContext();
    await expect(host.run(agent(), 'go', ctx)).rejects.toThrow();
    // The failed run is charged with the rounds it recorded; the retry replays them
    // without charging them again.
    expect(ctx.tokens.total).toBe(4 * 15);

    expect(await host.run(agent(), 'go', ctx)).toBe('charged 5');
    expect(server.rounds).toHaveLength(7);
    expect(ctx.tokens.total).toBe(6 * 15);
  });

  it('replays a steer applied before the cut, so the resumed loop still sees it', async () => {
    const queue = new MessageQueue();
    const { server, harness, agent } = setup((n) => {
      if (n === 2) {
        queue.enqueue({
          id: 'steer-1',
          input: 'use the backup card',
          deliveryMode: 'between-rounds',
          options: {},
          enqueuedAt: Date.now(),
        });
      }
    });
    server.dropAt.add(5);
    const storage = createInMemoryStorage();
    const first = harness(storage);
    const ctx = Object.assign(first.createContext(), {
      _sessionQueue: queue,
    } satisfies SessionCtxExtension);
    await expect(first.run(agent(), 'go', ctx)).rejects.toThrow();

    const next = harness(storage);
    const resumed = await next.restore(ctx.id);
    assert(resumed);
    expect(await next.run(agent(), 'go', resumed)).toBe('charged 5');

    const mentionsSteer = (round: number): boolean =>
      JSON.stringify(server.rounds[round]?.input).includes('use the backup card');
    expect(mentionsSteer(1)).toBe(false);
    expect(mentionsSteer(2)).toBe(true);
    // The resumed round is asked on the replayed conversation, steer included.
    expect(mentionsSteer(5)).toBe(true);
    expect(server.rounds[5]?.input).toEqual(server.rounds[4]?.input);
  });

  it('resumes a round cut mid-stream from the items it finished', async () => {
    const { server, charges, harness, agent } = setup();
    // Round 3 streams its function call, then the host dies before the response ends.
    server.cutAt.set(3, 1);
    const storage = createInMemoryStorage();
    const first = harness(storage);
    const ctx = first.createContext();
    const records = watchRecords(ctx);
    await expect(first.run(agent(), 'go', ctx)).rejects.toThrow();
    expect(charges).toEqual([
      1,
      2,
    ]);
    // The finished call was recorded before the stream ended.
    expect(records.at(-1)?.data).toEqual({
      round: 2,
      itemIds: [
        'fc_2',
      ],
      done: false,
    });

    const next = harness(storage);
    const resumed = await next.restore(ctx.id);
    assert(resumed);
    expect(await next.run(agent(), 'go', resumed)).toBe('charged 5');

    // The cut round is not asked again: its call runs once and the loop goes on.
    expect(server.rounds).toHaveLength(6);
    expect(JSON.stringify(server.rounds[3]?.input)).toContain('call_2');
    expect(charges).toEqual([
      1,
      2,
      3,
      4,
      5,
    ]);
    // The cut round reported no usage, so only the five answered rounds count.
    expect(resumed.tokens.total).toBe(5 * 15);
  });

  it('asks the model what an uninterrupted run would after resuming a cut round', async () => {
    const whole = setup(undefined, thinkingModel);
    const host = whole.harness(createInMemoryStorage());
    expect(await host.run(whole.agent(), 'go', host.createContext())).toBe('charged 5');

    const { server, harness, agent } = setup(undefined, thinkingModel);
    server.cutAt.set(3, 2);
    const storage = createInMemoryStorage();
    const first = harness(storage);
    const ctx = first.createContext();
    await expect(first.run(agent(), 'go', ctx)).rejects.toThrow();
    const next = harness(storage);
    const resumed = await next.restore(ctx.id);
    assert(resumed);
    expect(await next.run(agent(), 'go', resumed)).toBe('charged 5');

    expect(server.rounds).toHaveLength(6);
    expect(server.rounds[3]?.input).toEqual(whole.server.rounds[3]?.input);
  });

  it('asks a cut round again when it finished nothing to go on from', async () => {
    const { server, charges, harness, agent } = setup(undefined, thinkingModel);
    // Round 3 finishes its reasoning, then dies before the function call finishes.
    server.cutAt.set(3, 1);
    const storage = createInMemoryStorage();
    const first = harness(storage);
    const ctx = first.createContext();
    await expect(first.run(agent(), 'go', ctx)).rejects.toThrow();

    const next = harness(storage);
    const resumed = await next.restore(ctx.id);
    assert(resumed);
    expect(await next.run(agent(), 'go', resumed)).toBe('charged 5');
    expect(server.rounds).toHaveLength(7);
    expect(server.rounds[3]?.input).toEqual(server.rounds[2]?.input);
    expect(charges).toHaveLength(5);
  });

  it('ends a resumed loop with an answer its cut stream finished', async () => {
    const { server, charges, harness, agent } = setup();
    // The final round streams its answer, then dies before the response ends.
    server.cutAt.set(6, 1);
    const storage = createInMemoryStorage();
    const first = harness(storage);
    const ctx = first.createContext();
    await expect(first.run(agent(), 'go', ctx)).rejects.toThrow();

    const next = harness(storage);
    const resumed = await next.restore(ctx.id);
    assert(resumed);
    expect(await next.run(agent(), 'go', resumed)).toBe('charged 5');
    expect(server.rounds).toHaveLength(6);
    expect(charges).toHaveLength(5);
  });

  it('records each round the loop goes on from once its record lands', async () => {
    const { harness, agent } = setup();
    const host = harness(createInMemoryStorage());
    const ctx = host.createContext();
    const records = watchRecords(ctx);
    expect(await host.run(agent(), 'go', ctx)).toBe('charged 5');
    const done = records.filter((event) => event.data.done === true);
    expect(done.map((event) => event.data.round)).toEqual([
      0,
      1,
      2,
      3,
      4,
    ]);
    // Each round's cut record lands before its own; the final round has only its cut,
    // dropped once the loop ends.
    for (const round of [
      0,
      1,
      2,
      3,
      4,
      5,
    ]) {
      const ofRound = records.filter((event) => event.data.round === round);
      expect(ofRound[0]?.data.done).toBe(false);
    }
    expect(records.at(-1)?.data).toEqual({
      round: 5,
      itemIds: [
        'msg_done',
      ],
      done: false,
    });
  });

  it('drops the items of a round the loop rejects and asks again', async () => {
    const { server, harness, agent } = setup();
    // Round 1 streams its call but ends incomplete; its retry dies before any item.
    server.incompleteAt.add(1);
    server.cutAt.set(2, 0);
    const storage = createInMemoryStorage();
    const host = harness(storage);
    const ctx = host.createContext();
    await expect(host.run(agent(), 'go', ctx)).rejects.toThrow();

    const { entries } = await createStepLedgerStore({
      storage,
    }).load(ctx.id);
    expect(entries.size).toBe(0);
  });

  it('drops the items of a round the loop gives up on', async () => {
    const { server, charges, harness, agent } = setup();
    for (const round of [
      1,
      2,
      3,
      4,
    ]) {
      server.incompleteAt.add(round);
    }
    const storage = createInMemoryStorage();
    const host = harness(storage);
    const ctx = host.createContext();
    await expect(host.run(agent(), 'go', ctx)).rejects.toThrow('incomplete');
    expect(server.rounds).toHaveLength(4);

    const { entries } = await createStepLedgerStore({
      storage,
    }).load(ctx.id);
    expect(entries.size).toBe(0);
    expect(charges).toHaveLength(0);
  });

  it('asks the final round again when a retry follows a failure past the loop', async () => {
    const { server, harness } = setup();
    const charge = tool({
      name: 'charge',
      description: 'Charge a card once.',
      input: z.object({
        n: z.number(),
      }),
      output: z.object({
        ok: z.boolean(),
      }),
      execute: async () => ({
        ok: true,
      }),
    });
    // The model answers in prose, so the structured output never parses.
    const strict = callModel<ContextData, string, unknown>({
      id: 'agent',
      model: 'test/model',
      tools: [
        charge,
      ],
      output: z.object({
        charged: z.number(),
      }),
    });
    const host = harness(createInMemoryStorage());
    const ctx = host.createContext();
    await expect(host.run(strict, 'go', ctx)).rejects.toThrow('failed to parse output');
    expect(server.rounds).toHaveLength(6);

    await expect(host.run(strict, 'go', ctx)).rejects.toThrow('failed to parse output');
    expect(server.rounds).toHaveLength(7);
  });

  it('records no rounds for a step kept out of the ledger', async () => {
    const { server, harness, agent } = setup();
    server.dropAt.add(3);
    const storage = createInMemoryStorage();
    const first = harness(storage);
    const ctx = first.createContext();
    await expect(first.run(agent(false), 'go', ctx)).rejects.toThrow();

    const { entries } = await createStepLedgerStore({
      storage,
    }).load(ctx.id);
    expect(entries.size).toBe(0);
  });
});
