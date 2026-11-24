// Each tool call of a round is recorded as it finishes, so a round cut off part way
// resumes without running its finished calls again. Drives the real model client
// against a fake server. See specs/23a-step-level-resume § Tool calls in a round.

import { afterEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type { ContextData } from '@noetic-tools/types';
import { z } from 'zod';
import { callModel } from '../../src/builders/step-builders';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import type { FakeOpenRouter } from '../_helpers';
import { startFakeOpenRouter } from '../_helpers';

//#region Fixtures

const SHIPMENTS = 3;

const OutputSchema = z.object({
  type: z.literal('function_call_output'),
});

/** Asks for every shipment in one round, then answers once it has their results. */
function shippingModel(input: unknown[]): unknown[] {
  const done = input.filter((entry) => OutputSchema.safeParse(entry).success).length;
  if (done >= SHIPMENTS) {
    return [
      {
        type: 'message',
        id: 'msg_done',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: `shipped ${done}`,
            annotations: [],
          },
        ],
      },
    ];
  }
  return Array.from(
    {
      length: SHIPMENTS,
    },
    (_, i) => ({
      type: 'function_call',
      id: `fc_${i + 1}`,
      call_id: `call_${i + 1}`,
      name: 'ship',
      arguments: JSON.stringify({
        n: i + 1,
      }),
      status: 'completed',
    }),
  );
}

interface Attempt {
  n: number;
  key: string | undefined;
}

/**
 * A `ship` tool whose first attempt at shipment `hangOn` never returns, as a host
 * killed mid-call leaves it. `attempts` is every time the tool body ran.
 */
function setup(hangOn: number): {
  attempts: Attempt[];
  harness: (storage: StorageAdapter) => AgentHarness;
  agent: ReturnType<typeof callModel<ContextData, string, string>>;
} {
  const server = startFakeOpenRouter(shippingModel);
  servers.push(server);
  const attempts: Attempt[] = [];
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
    execute: async ({ n }, toolCtx) => {
      attempts.push({
        n,
        key: toolCtx.idempotencyKey,
      });
      if (n === hangOn && !hung) {
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
        name: 'records',
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

const servers: FakeOpenRouter[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop();
  }
});

//#endregion

describe('tool calls recorded within a round', () => {
  it('a round killed after two of three calls resumes by running only the third', async () => {
    const { attempts, harness, agent } = setup(3);
    const storage = createInMemoryStorage();
    const first = harness(storage);
    const ctx = first.createContext();
    // The host dies inside the third call: this run never settles.
    void first.run(agent, 'go', ctx).catch(() => {});
    await waitFor(() => attempts.length === 3);

    const next = harness(storage);
    const resumed = await next.restore(ctx.id);
    assert(resumed);
    expect(await next.run(agent, 'go', resumed)).toBe('shipped 3');

    expect(attempts.map((a) => a.n)).toEqual([
      1,
      2,
      3,
      3,
    ]);
  });

  it('a call made again carries the key it carried the first time', async () => {
    const { attempts, harness, agent } = setup(2);
    const storage = createInMemoryStorage();
    const first = harness(storage);
    const ctx = first.createContext();
    void first.run(agent, 'go', ctx).catch(() => {});
    await waitFor(() => attempts.length === 2);

    const next = harness(storage);
    const resumed = await next.restore(ctx.id);
    assert(resumed);
    await next.run(agent, 'go', resumed);

    // Shipment 2 was cut off and made again; 1 replayed; 3 ran once.
    expect(attempts.map((a) => a.n)).toEqual([
      1,
      2,
      2,
      3,
    ]);
    const [one, cut, again, three] = attempts.map((a) => a.key);
    assert(one && cut && again && three);
    expect(again).toBe(cut);
    expect(cut).toBe(`${ctx.id}:tool:call_2`);
    // A vendor that keeps one outcome per key sees three shipments, not four.
    expect(new Set(attempts.map((a) => a.key)).size).toBe(SHIPMENTS);
  });

  it('a run that is never cut off runs each call once', async () => {
    const { attempts, harness, agent } = setup(0);
    const h = harness(createInMemoryStorage());
    expect(await h.run(agent, 'go', h.createContext())).toBe('shipped 3');
    expect(attempts.map((a) => a.n)).toEqual([
      1,
      2,
      3,
    ]);
  });
});
