// What counts as a recorded effect, and what a newer flow version does about one,
// in the shapes the first tests did not cover: a durable tool a model called, an
// effect under a parent that finished, a stuck error inside inParallel, a message
// for a stuck thread, and the trail across a restart. See specs/23-durable-execution
// § Versions and § The trail.

import { afterEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type { ContextData, DecisionItem } from '@noetic-tools/types';
import { isNoeticError } from '@noetic-tools/types';
import { z } from 'zod';
import { inParallel } from '../../src/builders/control-flow-builders';
import { callModel, invokeTool, runCode } from '../../src/builders/step-builders';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import type { FakeOpenRouter } from '../_helpers';
import { startFakeOpenRouter } from '../_helpers';

//#region Fixtures

/** A durable charge. `charges` is every charge made. */
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
    execute: async ({ amount }) => {
      charges.push(amount);
      return {
        charged: amount,
        receipt: `rcpt-${charges.length}`,
      };
    },
  });
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

function decision(action: 'continue' | 'restart' | 'abandon'): DecisionItem {
  return {
    type: 'noetic:decision',
    action,
  };
}

const thread = {
  threadId: 't',
};
const delivery = {
  threadId: 't',
  messageId: 'm-1',
};

/**
 * Charges `amount`, then does a second thing that throws on the first deploy. With
 * `parallel`, the two run as paths of one inParallel.
 */
function sessionHarness(opts: {
  storage: StorageAdapter;
  version: string;
  amount: number;
  charges: number[];
  fails: boolean;
  parallel?: boolean;
}): AgentHarness {
  const charge = invokeTool({
    id: 'charge',
    tool: chargeTool(opts.charges),
  });
  const after = runCode<ContextData, unknown, string>({
    id: 'after',
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (opts.fails) {
        throw new Error('the host went down');
      }
      return 'done';
    },
  });
  const both = inParallel<
    ContextData,
    {
      amount: number;
    },
    unknown
  >({
    id: 'both',
    mode: 'all',
    paths: () => [
      charge,
      after,
    ],
    merge: (results) => results,
  });
  const args = {
    amount: opts.amount,
  };
  return new AgentHarness({
    name: 'effects',
    params: {},
    version: opts.version,
    agentGraph: runCode<ContextData, string, string>({
      id: 'flow',
      execute: async (_input, execCtx) => {
        if (opts.parallel) {
          await execCtx.harness.run(both, args, execCtx);
          return 'done';
        }
        await execCtx.harness.run(charge, args, execCtx);
        return String(await execCtx.harness.run(after, undefined, execCtx));
      },
    }),
    environment: {
      storage: {
        adapter: opts.storage,
      },
    },
  });
}

/** Runs v1 until it charges 42 and is cut off, then v2 (charging 50) until it stops. */
async function stuckOnV2(parallel = false): Promise<{
  storage: StorageAdapter;
  charges: number[];
  v2: AgentHarness;
}> {
  const storage = createInMemoryStorage();
  const charges: number[] = [];
  const v1 = sessionHarness({
    storage,
    version: 'v1',
    amount: 42,
    charges,
    fails: true,
    parallel,
  });
  await v1.execute('go', delivery);
  await v1.getAgentResponse(thread).catch(() => {});
  expect(charges).toEqual([
    42,
  ]);
  const v2 = sessionHarness({
    storage,
    version: 'v2',
    amount: 50,
    charges,
    fails: false,
    parallel,
  });
  await v2.execute('go', delivery);
  return {
    storage,
    charges,
    v2,
  };
}

//#endregion

describe('a durable tool a model called', () => {
  let server: FakeOpenRouter | undefined;
  afterEach(() => {
    server?.stop();
    server = undefined;
  });

  const OutputSchema = z.object({
    type: z.literal('function_call_output'),
  });

  /** Asks for one charge, then answers. */
  function chargingModel(input: unknown[]): unknown[] {
    const done = input.filter((entry) => OutputSchema.safeParse(entry).success).length;
    if (done >= 1) {
      return [
        {
          type: 'message',
          id: 'msg_done',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'charged',
              annotations: [],
            },
          ],
        },
      ];
    }
    return [
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'charge',
        arguments: JSON.stringify({
          amount: 42,
        }),
        status: 'completed',
      },
    ];
  }

  it('is not charged again when a newer version changes what the step is asked', async () => {
    const fake = startFakeOpenRouter(chargingModel);
    server = fake;
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    const agent = callModel<ContextData, string, string>({
      id: 'agent',
      model: 'test/model',
      tools: [
        chargeTool(charges),
      ],
    });
    const build = (version: string): AgentHarness =>
      new AgentHarness({
        name: 'effects',
        params: {},
        version,
        callModelDefaults: {
          provider: 'openrouter',
          apiKey: 'sk-test',
          baseUrl: fake.baseUrl,
        },
        environment: {
          storage: {
            adapter: storage,
          },
        },
      });
    // v1: the round with the charge is recorded; the answer round is cut off.
    fake.dropAt.add(2);
    const v1 = build('v1');
    const ctx = v1.createContext();
    await v1.run(agent, 'refund order 7', ctx).catch(() => {});
    expect(charges).toEqual([
      42,
    ]);

    const v2 = build('v2');
    const resumed = await v2.restore(ctx.id);
    assert(resumed);
    expect(await kindOf(() => v2.run(agent, 'refund order 8', resumed))).toBe('turn_stuck');
    expect(charges).toEqual([
      42,
    ]);
  });
});

describe('an effect under a step that finished on a resumed run', () => {
  it('is still an effect: a newer version that changes the step is stuck', async () => {
    const storage = createInMemoryStorage();
    const charges: number[] = [];
    let crashes = 1;
    const build = (version: string, amount: number): AgentHarness => {
      const charge = invokeTool({
        id: 'charge',
        tool: chargeTool(charges),
      });
      const pay = runCode<
        ContextData,
        {
          amount: number;
        },
        string
      >({
        id: 'pay',
        execute: async (input, execCtx) => {
          await execCtx.harness.run(charge, input, execCtx);
          // The host dies after the charge, the first time round.
          if (crashes > 0) {
            crashes -= 1;
            throw new Error('the host went down');
          }
          return 'paid';
        },
      });
      const after = runCode<ContextData, unknown, string>({
        id: 'after',
        execute: async () => {
          throw new Error('cut off again');
        },
      });
      return new AgentHarness({
        name: 'effects',
        params: {},
        version,
        agentGraph: runCode<ContextData, string, string>({
          id: 'flow',
          execute: async (_input, execCtx) => {
            await execCtx.harness.run(
              pay,
              {
                amount,
              },
              execCtx,
            );
            return String(await execCtx.harness.run(after, undefined, execCtx));
          },
        }),
        environment: {
          storage: {
            adapter: storage,
          },
        },
      });
    };
    // Run 1 (v1): charged, cut off inside `pay`.
    const first = build('v1', 42);
    await first.execute('go', delivery);
    await first.getAgentResponse(thread).catch(() => {});
    // Run 2 (v1): the charge replays, `pay` finishes and prunes it, then cut off.
    const second = build('v1', 42);
    await second.execute('go', delivery);
    await second.getAgentResponse(thread).catch(() => {});
    expect(charges).toEqual([
      42,
    ]);

    // Run 3 (v2) changes `pay`. Its record still says it had an effect.
    const third = build('v2', 50);
    await third.execute('go', delivery);
    expect(await kindOf(() => third.getAgentResponse(thread))).toBe('turn_stuck');
    expect(charges).toEqual([
      42,
    ]);
  });
});

describe('a stuck step inside inParallel', () => {
  it('stops the turn as stuck, where the host can find it and settle it', async () => {
    const { v2, charges } = await stuckOnV2(true);
    expect(await kindOf(() => v2.getAgentResponse(thread))).toBe('turn_stuck');
    const [stuck] = await v2.listStuckRuns();
    assert(stuck);
    expect(stuck.path).toContain('charge');
    expect(charges).toEqual([
      42,
    ]);

    await v2.execute(decision('continue'), thread);
    expect((await v2.getAgentResponse(thread)).text).toBe('done');
    expect(charges).toEqual([
      42,
      50,
    ]);
  });
});

describe('a message for a thread whose turn is stuck', () => {
  it('waits behind the stuck turn instead of throwing it away', async () => {
    const { v2, charges } = await stuckOnV2();
    await v2.getAgentResponse(thread).catch(() => {});
    expect(await v2.listStuckRuns()).toHaveLength(1);

    await v2.execute('something else', {
      threadId: 't',
      messageId: 'm-2',
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Still stuck, and nothing was charged in the meantime.
    expect(await v2.listStuckRuns()).toHaveLength(1);
    expect(charges).toEqual([
      42,
    ]);
  });
});

describe('restarting a stuck turn', () => {
  it('keeps the trail of what the first run did', async () => {
    const { v2, charges } = await stuckOnV2();
    await v2.getAgentResponse(thread).catch(() => {});

    await v2.execute(decision('restart'), thread);
    expect((await v2.getAgentResponse(thread)).text).toBe('done');
    expect(charges).toEqual([
      42,
      50,
    ]);
    const receipts = (await v2.getAuditTrail(thread))
      .filter((mark) => mark.stepId === 'charge')
      .map((mark) => [
        mark.version,
        mark.receipt,
      ]);
    // The v1 charge happened. A restart does not erase the record of it.
    expect(receipts).toContainEqual([
      'v1',
      'rcpt-1',
    ]);
    expect(receipts).toContainEqual([
      'v2',
      'rcpt-2',
    ]);
  });
});
