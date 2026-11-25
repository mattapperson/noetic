// harness.recordedToolCalls(executionId): the tool calls a resume of an execution
// brings back on its own (#142). See specs/23a-step-level-resume § Tool calls in a round.

import { afterEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type { ContextData } from '@noetic-tools/types';
import { z } from 'zod';
import { callModel, runCode } from '../../src/builders/step-builders';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { recordedToolCalls } from '../../src/harness/recorded-tool-calls';
import type { StepLedgerEntry } from '../../src/runtime/durable/step-ledger';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import type { FakeOpenRouter } from '../_helpers';
import { startFakeOpenRouter } from '../_helpers';

//#region Fixtures

const OutputSchema = z.object({
  type: z.literal('function_call_output'),
});

function answer(text: string): unknown {
  return {
    type: 'message',
    id: 'msg_done',
    role: 'assistant',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text,
        annotations: [],
      },
    ],
  };
}

function functionCall(n: number): unknown {
  return {
    type: 'function_call',
    id: `fc_${n}`,
    call_id: `call_${n}`,
    name: 'ship',
    arguments: JSON.stringify({
      n,
    }),
    status: 'completed',
  };
}

/** `perRound` calls a round until `total` results are in, then an answer. */
function shippingModel(total: number, perRound: number): (input: unknown[]) => unknown[] {
  return (input) => {
    const done = input.filter((entry) => OutputSchema.safeParse(entry).success).length;
    if (done >= total) {
      return [
        answer(`shipped ${done}`),
      ];
    }
    return Array.from(
      {
        length: Math.min(perRound, total - done),
      },
      (_, i) => functionCall(done + i + 1),
    );
  };
}

const servers: FakeOpenRouter[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop();
  }
});

/** A `ship` tool whose first attempt at shipment `hangOn` never returns, as a killed host leaves it. */
function setup(opts: { total: number; perRound: number; hangOn: number }): {
  attempts: number[];
  harness: (storage: StorageAdapter) => AgentHarness;
  agent: ReturnType<typeof callModel<ContextData, string, string>>;
} {
  const server = startFakeOpenRouter(shippingModel(opts.total, opts.perRound));
  servers.push(server);
  const attempts: number[] = [];
  let hung = false;
  const ship = tool({
    name: 'ship',
    description: 'Ship an order once.',
    input: z.object({
      n: z.number(),
    }),
    output: z.object({
      ok: z.boolean(),
    }),
    execute: async ({ n }) => {
      attempts.push(n);
      if (n === opts.hangOn && !hung) {
        hung = true;
        await new Promise(() => {});
      }
      return {
        ok: true,
      };
    },
  });
  return {
    attempts,
    harness: (storage) =>
      new AgentHarness({
        name: 'recorded-calls',
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
    agent: callModel<ContextData, string, string>({
      id: 'agent',
      model: 'test/model',
      tools: [
        ship,
      ],
    }),
  };
}

async function waitFor(done: () => boolean): Promise<void> {
  for (let i = 0; i < 2e3 && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert(done());
}

function entry(
  fields: Partial<StepLedgerEntry> & Pick<StepLedgerEntry, 'path' | 'kind'>,
): StepLedgerEntry {
  return {
    stepId: 'agent',
    output: null,
    completedAt: '2026-01-01T00:00:00.000Z',
    ...fields,
  };
}

function call(callId: string): Record<string, unknown> {
  return {
    id: `fc_${callId}`,
    type: 'function_call',
    status: 'completed',
    callId,
    name: 'ship',
    arguments: '{}',
  };
}

function result(callId: string): Record<string, unknown> {
  return {
    id: `out_${callId}`,
    type: 'function_call_output',
    status: 'completed',
    callId,
    output: '{}',
  };
}

//#endregion

describe('harness.recordedToolCalls', () => {
  it('names the calls of two finished rounds as settled, and the cut-off call as not', async () => {
    const { attempts, harness, agent } = setup({
      total: 3,
      perRound: 1,
      hangOn: 3,
    });
    const storage = createInMemoryStorage();
    const first = harness(storage);
    const ctx = first.createContext();
    // The host dies inside the third round's call.
    void first.run(agent, 'go', ctx).catch(() => {});
    await waitFor(() => attempts.length === 3);

    const next = harness(storage);
    const calls = await next.recordedToolCalls(ctx.id);
    expect(
      calls.map((c) => [
        c.callId,
        c.name,
        c.settled,
      ]),
    ).toEqual([
      [
        'call_1',
        'ship',
        true,
      ],
      [
        'call_2',
        'ship',
        true,
      ],
      [
        'call_3',
        'ship',
        false,
      ],
    ]);
    for (const c of calls) {
      expect(c.path).toContain('round#');
    }

    // The resume replays the settled calls and runs only the cut-off one again.
    const resumed = await next.restore(ctx.id);
    assert(resumed);
    expect(await next.run(agent, 'go', resumed)).toBe('shipped 3');
    expect(attempts).toEqual([
      1,
      2,
      3,
      3,
    ]);
    // Each call appears once in the resumed history.
    const callIds = resumed.itemLog.items.flatMap((item) =>
      item.type === 'function_call'
        ? [
            item.callId,
          ]
        : [],
    );
    expect(callIds).toEqual([
      'call_1',
      'call_2',
      'call_3',
    ]);
  });

  it('settles a call finished in a round that was cut off before it recorded', async () => {
    const { attempts, harness, agent } = setup({
      total: 3,
      perRound: 3,
      hangOn: 3,
    });
    const storage = createInMemoryStorage();
    const first = harness(storage);
    const ctx = first.createContext();
    void first.run(agent, 'go', ctx).catch(() => {});
    await waitFor(() => attempts.length === 3);
    // Let the records the first two calls started land.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const calls = await harness(storage).recordedToolCalls(ctx.id);
    expect(
      calls.map((c) => [
        c.callId,
        c.settled,
      ]),
    ).toEqual([
      [
        'call_1',
        true,
      ],
      [
        'call_2',
        true,
      ],
      [
        'call_3',
        false,
      ],
    ]);
  });

  it('names the calls of a completed model step in a run cut off after it as settled', async () => {
    const { harness, agent } = setup({
      total: 2,
      perRound: 1,
      hangOn: -1,
    });
    let reached = false;
    const hang = runCode<ContextData, string, string>({
      id: 'after',
      execute: async () => {
        reached = true;
        return new Promise<string>(() => {});
      },
    });
    const storage = createInMemoryStorage();
    const first = harness(storage);
    const ctx = first.createContext();
    void first
      .run(
        [
          agent,
          hang,
        ],
        'go',
        ctx,
      )
      .catch(() => {});
    await waitFor(() => reached);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const calls = await harness(storage).recordedToolCalls(ctx.id);
    expect(
      calls.map((c) => [
        c.callId,
        c.settled,
      ]),
    ).toEqual([
      [
        'call_1',
        true,
      ],
      [
        'call_2',
        true,
      ],
    ]);
    // The model step's own record holds them, not a round's.
    for (const c of calls) {
      expect(c.path).not.toContain('round#');
    }
  });

  it('lists a replayKey step’s calls once, under its key, with no round records left behind', async () => {
    const { harness, agent } = setup({
      total: 2,
      perRound: 1,
      hangOn: -1,
    });
    const keyed = {
      ...agent,
      replayKey: () => 'k1',
    };
    let reached = false;
    const hang = runCode<ContextData, string, string>({
      id: 'after',
      execute: async () => {
        reached = true;
        return new Promise<string>(() => {});
      },
    });
    const storage = createInMemoryStorage();
    const first = harness(storage);
    const ctx = first.createContext();
    void first
      .run(
        [
          keyed,
          hang,
        ],
        'go',
        ctx,
      )
      .catch(() => {});
    await waitFor(() => reached);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const calls = await harness(storage).recordedToolCalls(ctx.id);
    expect(
      calls.map((c) => [
        c.callId,
        c.path,
        c.settled,
      ]),
    ).toEqual([
      [
        'call_1',
        'key:k1',
        true,
      ],
      [
        'call_2',
        'key:k1',
        true,
      ],
    ]);
    const kinds = await Promise.all(
      (await storage.list(`execution:${ctx.id}:ledger:`)).map(async (key) => {
        const stored = await storage.get<{
          kind: string;
        }>(key);
        return stored?.kind;
      }),
    );
    expect(kinds.filter((kind) => kind?.startsWith('callModel:'))).toEqual([]);
  });

  it('keeps a replayKey step’s calls after the run finishes, since a later run replays them', async () => {
    const { harness, agent } = setup({
      total: 1,
      perRound: 1,
      hangOn: -1,
    });
    const storage = createInMemoryStorage();
    const h = harness(storage);
    const ctx = h.createContext();
    expect(
      await h.run(
        {
          ...agent,
          replayKey: () => 'k1',
        },
        'go',
        ctx,
      ),
    ).toBe('shipped 1');
    const calls = await harness(storage).recordedToolCalls(ctx.id);
    expect(
      calls.map((c) => [
        c.callId,
        c.path,
      ]),
    ).toEqual([
      [
        'call_1',
        'key:k1',
      ],
    ]);
    await h.clearCheckpoint(ctx.id);
    expect(await harness(storage).recordedToolCalls(ctx.id)).toEqual([]);
  });

  it('is empty once a run with no replayKey steps finishes', async () => {
    const { harness, agent } = setup({
      total: 1,
      perRound: 1,
      hangOn: -1,
    });
    const storage = createInMemoryStorage();
    const h = harness(storage);
    const ctx = h.createContext();
    expect(await h.run(agent, 'go', ctx)).toBe('shipped 1');
    expect(await harness(storage).recordedToolCalls(ctx.id)).toEqual([]);
  });

  it('is empty for an execution with nothing recorded', async () => {
    const { harness } = setup({
      total: 1,
      perRound: 1,
      hangOn: -1,
    });
    expect(await harness(createInMemoryStorage()).recordedToolCalls('unknown')).toEqual([]);
  });
});

describe('recordedToolCalls (window)', () => {
  it('reads requests from round output items and settles them from call records beneath the round', () => {
    const round = entry({
      path: 'agent/round#0',
      kind: 'callModel:round',
      output: {
        items: [
          call('a'),
          call('b'),
        ],
        input: [],
        usage: {
          inputTokens: 1,
          outputTokens: 1,
        },
        cost: 0,
        cut: true,
      },
    });
    const callRecord = entry({
      path: 'agent/round#0/call:a',
      kind: 'callModel:call',
      output: {
        output: '{}',
      },
    });
    const calls = recordedToolCalls({
      entries: new Map([
        [
          round.path,
          round,
        ],
        [
          callRecord.path,
          callRecord,
        ],
      ]),
      seqs: new Map([
        [
          round.path,
          0,
        ],
        [
          callRecord.path,
          1,
        ],
      ]),
      nextSeq: 2,
    });
    expect(calls).toEqual([
      {
        callId: 'a',
        name: 'ship',
        path: 'agent/round#0',
        settled: true,
      },
      {
        callId: 'b',
        name: 'ship',
        path: 'agent/round#0',
        settled: false,
      },
    ]);
  });

  it('keeps two calls with one id apart when different entries hold them', () => {
    const first = entry({
      path: 'one',
      kind: 'callModel',
      items: [
        call('call_1'),
        result('call_1'),
      ],
    });
    const second = entry({
      path: 'two/round#0',
      kind: 'callModel:round',
      output: {
        items: [
          call('call_1'),
        ],
      },
    });
    const calls = recordedToolCalls({
      entries: new Map([
        [
          second.path,
          second,
        ],
        [
          first.path,
          first,
        ],
      ]),
      seqs: new Map([
        [
          first.path,
          0,
        ],
        [
          second.path,
          1,
        ],
      ]),
      nextSeq: 2,
    });
    expect(
      calls.map((c) => [
        c.path,
        c.settled,
      ]),
    ).toEqual([
      [
        'one',
        true,
      ],
      [
        'two/round#0',
        false,
      ],
    ]);
  });

  it('ignores items that are not tool calls and a round output it cannot read', () => {
    const odd = entry({
      path: 'odd/round#0',
      kind: 'callModel:round',
      output: 'not a round',
      items: [
        {
          type: 'message',
        },
        {
          type: 'function_call',
        },
      ],
    });
    const stray = entry({
      path: 'no-call-segment',
      kind: 'callModel:call',
    });
    expect(
      recordedToolCalls({
        entries: new Map([
          [
            odd.path,
            odd,
          ],
          [
            stray.path,
            stray,
          ],
        ]),
        seqs: new Map(),
        nextSeq: 0,
      }),
    ).toEqual([]);
  });
});
