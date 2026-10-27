// The model loop records each finished round, so a tool-using step cut off mid-loop
// resumes on a new harness without paying for — or re-running the tools of — the
// rounds it already finished. Drives the real model client against a fake server.

import { afterEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type { ContextData } from '@noetic-tools/types';
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

function setup(onCharge?: (n: number) => void): {
  server: FakeOpenRouter;
  charges: number[];
  harness: (storage: StorageAdapter) => AgentHarness;
  agent: (durable?: boolean) => ReturnType<typeof callModel<ContextData, string, string>>;
} {
  const server = startFakeOpenRouter(chargingModel);
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
    // The recorded rounds are charged when the retry replays them, not by the failure.
    expect(ctx.tokens.total).toBe(0);

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
