/**
 * A round the model loop rejects and asks again — a provider terminal error in a 2xx
 * body, or a response with no output — was still billed, so its cost counts.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type { ContextData } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { callModel } from '../../src/builders/step-builders';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import type { StepLedgerRetention } from '../../src/runtime/durable/step-ledger';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { makeMessage } from '../_helpers';

//#region Fakes

const FAILED_COST = 0.01;
const EMPTY_COST = 0.02;
const GOOD_COST = 0.04;

function body(status: string, output: unknown[], cost: number): unknown {
  return {
    id: `resp-${cost}`,
    status,
    ...(status === 'failed'
      ? {
          error: {
            message: 'upstream overloaded',
          },
        }
      : {}),
    output,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cost,
    },
  };
}

const TOOL_COST = 0.02;

const failed = (cost = FAILED_COST): unknown => body('failed', [], cost);
const empty = (): unknown => body('completed', [], EMPTY_COST);
const good = (): unknown =>
  body(
    'completed',
    [
      {
        id: 'msg-1',
        status: 'completed',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'ok',
          },
        ],
      },
    ],
    GOOD_COST,
  );

const toolCall = (): unknown =>
  body(
    'completed',
    [
      {
        type: 'function_call',
        id: 'fc-1',
        callId: 'call-1',
        name: 'ping',
        arguments: '{}',
        status: 'completed',
      },
    ],
    TOOL_COST,
  );

/** A terminal error that reports no usage at all, as an upstream failure may. */
const failedBare = (): unknown => ({
  id: 'resp-bare',
  status: 'failed',
  error: {
    message: 'upstream overloaded',
  },
  output: [],
});

const cachedGood = (): unknown => {
  const answer = frameworkCast<{
    usage: Record<string, unknown>;
  }>(good());
  return {
    ...answer,
    usage: {
      ...answer.usage,
      inputTokensDetails: {
        cachedTokens: 8,
      },
    },
  };
};

/** The provider refused the round outright, so it billed nothing. */
const refused = (): Error =>
  Object.assign(new Error('upstream down'), {
    statusCode: 500,
  });

/** Answers each round with the next body in `bodies`; an `Error` rejects the round. */
class ScriptedClient {
  sent = 0;

  constructor(private readonly bodies: unknown[]) {}

  callModel(): {
    getFullResponsesStream: () => AsyncIterable<unknown>;
    getResponse: () => Promise<unknown>;
  } {
    const next = this.bodies[this.sent];
    this.sent += 1;
    return {
      async *getFullResponsesStream() {},
      getResponse: async () => {
        if (next instanceof Error) {
          throw next;
        }
        return next;
      },
    };
  }
}

function harnessWith(
  client: ScriptedClient,
  storage?: StorageAdapter,
  stepLedgerRetention?: StepLedgerRetention,
): AgentHarness<Record<string, never>> {
  const harness = new AgentHarness({
    name: 'recovery-spend',
    params: {},
    ...(storage
      ? {
          environment: {
            storage: {
              adapter: storage,
              stepLedgerRetention,
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

const ping = tool({
  name: 'ping',
  description: 'Ping.',
  input: z.object({}),
  output: z.object({
    ok: z.boolean(),
  }),
  execute: async () => ({
    ok: true,
  }),
});

const agent = callModel<ContextData, string, string>({
  id: 'agent',
  model: 'test/model',
  tools: [
    ping,
  ],
});

//#endregion

describe('callModel recovery spend', () => {
  it('counts rounds rejected by recovery in the response and the context', async () => {
    const client = new ScriptedClient([
      failed(),
      empty(),
      good(),
    ]);
    const harness = harnessWith(client);
    const ctx = harness.createContext();

    const response = await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'hi'),
      ],
      ctx,
    });

    expect(client.sent).toBe(3);
    expect(response.cost).toBeCloseTo(FAILED_COST + EMPTY_COST + GOOD_COST);
    // The rejected rounds fold into the round the loop kept.
    expect(response.rounds).toHaveLength(1);
    expect(response.rounds?.[0]).toMatchObject({
      inputTokens: 30,
      outputTokens: 15,
    });
    expect(response.usage).toMatchObject({
      inputTokens: 30,
      outputTokens: 15,
    });

    const stepClient = new ScriptedClient([
      failed(),
      empty(),
      good(),
    ]);
    const stepHarness = harnessWith(stepClient);
    const stepCtx = stepHarness.createContext();
    expect(await stepHarness.run(agent, 'go', stepCtx)).toBe('ok');
    expect(stepCtx.cost).toBeCloseTo(FAILED_COST + EMPTY_COST + GOOD_COST);
    expect(stepCtx.billedCost).toBeCloseTo(FAILED_COST + EMPTY_COST + GOOD_COST);
    expect(stepCtx.tokens.total).toBe(45);
  });

  it('charges every rejected round when recovery gives up and the step throws', async () => {
    // Three continuations are allowed; the fourth rejected round throws.
    const client = new ScriptedClient([
      failed(0.01),
      failed(0.02),
      failed(0.03),
      failed(0.04),
    ]);
    const harness = harnessWith(client);
    const ctx = harness.createContext();

    await expect(harness.run(agent, 'go', ctx)).rejects.toThrow(
      'LLM response failed: upstream overloaded',
    );

    expect(client.sent).toBe(4);
    expect(ctx.cost).toBeCloseTo(0.1);
    expect(ctx.billedCost).toBeCloseTo(0.1);
    expect(ctx.tokens.input).toBe(40);
    expect(ctx.tokens.output).toBe(20);
  });

  it('records a rejected round with the round after it, so a resumed loop still counts it', async () => {
    const storage = createInMemoryStorage();
    const first = harnessWith(
      new ScriptedClient([
        failed(),
        toolCall(),
        refused(),
      ]),
      storage,
    );
    const ctx = first.createContext();
    await expect(first.run(agent, 'go', ctx)).rejects.toThrow('upstream down');

    const next = harnessWith(
      new ScriptedClient([
        good(),
      ]),
      storage,
    );
    const resumed = await next.restore(ctx.id);
    assert(resumed);
    expect(await next.run(agent, 'go', resumed)).toBe('ok');

    expect(resumed.cost).toBeCloseTo(FAILED_COST + TOOL_COST + GOOD_COST);
    // The replayed rounds were paid for by the first attempt.
    expect(resumed.billedCost).toBeCloseTo(GOOD_COST);
  });

  it('folds a rejected round into the round after it, so rounds[0] still reports the cache', async () => {
    const harness = harnessWith(
      new ScriptedClient([
        failedBare(),
        cachedGood(),
      ]),
    );

    const response = await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'hi'),
      ],
      ctx: harness.createContext(),
    });

    expect(response.rounds).toHaveLength(1);
    expect(response.rounds?.[0]?.cachedTokens).toBe(8);
    expect(response.cost).toBeCloseTo(GOOD_COST);
  });

  it('charges a failed run with its recorded rounds, and a retry in place does not charge them again', async () => {
    const client = new ScriptedClient([
      failed(),
      toolCall(),
      refused(),
      good(),
    ]);
    const harness = harnessWith(client, createInMemoryStorage());
    const ctx = harness.createContext();

    await expect(harness.run(agent, 'go', ctx)).rejects.toThrow('upstream down');
    expect(ctx.cost).toBeCloseTo(FAILED_COST + TOOL_COST);
    expect(ctx.billedCost).toBeCloseTo(FAILED_COST + TOOL_COST);
    expect(ctx.tokens.total).toBe(30);

    expect(await harness.run(agent, 'go', ctx)).toBe('ok');
    expect(client.sent).toBe(4);
    expect(ctx.cost).toBeCloseTo(FAILED_COST + TOOL_COST + GOOD_COST);
    expect(ctx.billedCost).toBeCloseTo(FAILED_COST + TOOL_COST + GOOD_COST);
    expect(ctx.tokens.total).toBe(45);
  });

  it('charges a round whose record did not land when the step throws', async () => {
    const harness = harnessWith(
      new ScriptedClient([
        toolCall(),
        refused(),
      ]),
      createInMemoryStorage(),
      {
        maxEntryBytes: 1,
      },
    );
    const ctx = harness.createContext();

    await expect(harness.run(agent, 'go', ctx)).rejects.toThrow('upstream down');
    expect(ctx.cost).toBeCloseTo(TOOL_COST);
  });
});
