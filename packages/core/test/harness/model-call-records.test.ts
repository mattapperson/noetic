// Each tool call of a round is recorded as it finishes, so a round cut off part way
// resumes without running its finished calls again. Drives the real model client
// against a fake server. See specs/23a-step-level-resume § Tool calls in a round.

import { afterEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type { ContextData, HeldCall, Item } from '@noetic-tools/types';
import { z } from 'zod';
import { callModel } from '../../src/builders/step-builders';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import type { FakeOpenRouter } from '../_helpers';
import { slowStorage, startFakeOpenRouter } from '../_helpers';

//#region Fixtures

const SHIPMENTS = 3;

const OutputSchema = z.object({
  type: z.literal('function_call_output'),
});

const CallRecordSchema = z.object({
  kind: z.literal('callModel:call'),
  output: z.object({
    itemId: z.string(),
  }),
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
function setup(
  hangOn: number,
  durable?: boolean,
  /** Characters of padding in each result, to make it large. */
  pad = 0,
): {
  attempts: Attempt[];
  /** Each time the tool's UI was asked to draw: `call:1`, `result:1`. */
  drawn: string[];
  harness: (storage: StorageAdapter) => AgentHarness;
  agent: ReturnType<typeof callModel<ContextData, string, string>>;
} {
  const server = startFakeOpenRouter(shippingModel);
  servers.push(server);
  const attempts: Attempt[] = [];
  const drawn: string[] = [];
  const fragment = {
    dialect: 'openui-lang/0.5',
    source: 'root = Text("shipment")',
  };
  let hung = false;
  const ship = tool({
    name: 'ship',
    description: 'Ship an order once.',
    input: z.object({
      n: z.number(),
    }),
    output: z.object({
      ok: z.boolean(),
      pad: z.string().optional(),
    }),
    durable,
    ui: {
      call: ({ n }) => {
        drawn.push(`call:${n}`);
        return fragment;
      },
      result: (_output, { n }) => {
        drawn.push(`result:${n}`);
        return fragment;
      },
    },
    execute: async ({ n }, toolCtx) => {
      attempts.push({
        n,
        key: toolCtx.idempotencyKey,
      });
      if (n === hangOn && !hung) {
        hung = true;
        await new Promise(() => {});
      }
      return pad > 0
        ? {
            ok: true,
            pad: 'x'.repeat(pad),
          }
        : {
            ok: true,
          };
    },
  });
  return {
    attempts,
    drawn,
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
    // The run, where in it the call was made, and the call's id.
    expect(cut.startsWith(`${ctx.id}:tool:`)).toBe(true);
    expect(cut).toContain('round#0');
    expect(cut.endsWith(':call_2')).toBe(true);
    // A vendor that keeps one outcome per key sees three shipments, not four.
    expect(new Set(attempts.map((a) => a.key)).size).toBe(SHIPMENTS);
  });

  it('keeps finished calls recorded when storage is slow', async () => {
    // Regression: records of the round still being written pruned the call records.
    const { attempts, harness, agent } = setup(3);
    const storage = slowStorage(createInMemoryStorage(), 15);
    const first = harness(storage);
    const ctx = first.createContext();
    void first.run(agent, 'go', ctx).catch(() => {});
    await waitFor(() => attempts.length === 3);
    // Let the writes the first two calls started land, as they would before a crash.
    await new Promise((resolve) => setTimeout(resolve, 200));

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

describe('a durable tool', () => {
  /** Runs until the host "dies" inside shipment 2, then resumes on a new harness. */
  async function cutOffInShipmentTwo(fixture: ReturnType<typeof setup>): Promise<{
    storage: StorageAdapter;
    next: AgentHarness;
    scope: {
      executionId: string;
    };
    finished: Promise<unknown>;
  }> {
    const storage = createInMemoryStorage();
    const first = fixture.harness(storage);
    const ctx = first.createContext();
    void first.run(fixture.agent, 'go', ctx).catch(() => {});
    await waitFor(() => fixture.attempts.length === 2);

    const next = fixture.harness(storage);
    const resumed = await next.restore(ctx.id);
    assert(resumed);
    return {
      storage,
      next,
      scope: {
        executionId: ctx.id,
      },
      finished: next.run(fixture.agent, 'go', resumed),
    };
  }

  async function heldOutcome(
    harness: AgentHarness,
    scope: {
      executionId: string;
    },
  ): Promise<HeldCall> {
    for (let i = 0; i < 2e3; i += 1) {
      const [held] = await harness.pending(scope);
      if (held) {
        return held;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return expect.unreachable('no call was held');
  }

  it('is not run again after a crash: its outcome is held for a person', async () => {
    const fixture = setup(2, true);
    const { next, scope, finished } = await cutOffInShipmentTwo(fixture);

    const held = await heldOutcome(next, scope);
    expect(held).toMatchObject({
      callId: 'call_2',
      name: 'ship',
      reason: 'outcome',
      args: {
        n: 2,
      },
    });
    // Shipment 1 replayed, shipment 2 was not attempted again, and 3 ran.
    expect(fixture.attempts.map((a) => a.n)).toEqual([
      1,
      2,
      3,
    ]);

    // The person checked: it did ship.
    await next.resolveHeld(scope, {
      callId: held.callId,
      output: {
        ok: true,
      },
    });
    expect(await finished).toBe('shipped 3');
    expect(fixture.attempts.map((a) => a.n)).toEqual([
      1,
      2,
      3,
    ]);
  });

  it('runs again, with the same key, when the person says to', async () => {
    const fixture = setup(2, true);
    const { next, scope, finished } = await cutOffInShipmentTwo(fixture);
    const held = await heldOutcome(next, scope);

    await next.resolveHeld(scope, {
      callId: held.callId,
      action: 'allow',
    });
    expect(await finished).toBe('shipped 3');
    const second = fixture.attempts.filter((a) => a.n === 2);
    expect(second).toHaveLength(2);
    expect(second[1]?.key).toBe(second[0]?.key);
    expect(await next.pending(scope)).toEqual([]);
  });

  it('is refused when the person says not to run it', async () => {
    const fixture = setup(2, true);
    const { next, scope, finished } = await cutOffInShipmentTwo(fixture);
    const held = await heldOutcome(next, scope);

    await next.resolveHeld(scope, {
      callId: held.callId,
      action: 'deny',
      guidance: 'the order was cancelled',
    });
    expect(await finished).toBe('shipped 3');
    expect(fixture.attempts.filter((a) => a.n === 2)).toHaveLength(1);
  });

  it('leaves no intent behind when nothing goes wrong', async () => {
    const fixture = setup(0, true);
    const storage = createInMemoryStorage();
    const h = fixture.harness(storage);
    const ctx = h.createContext();
    expect(await h.run(fixture.agent, 'go', ctx)).toBe('shipped 3');
    expect(await storage.list(`execution:${ctx.id}:intent:`)).toEqual([]);
    expect(
      await h.pending({
        executionId: ctx.id,
      }),
    ).toEqual([]);
  });
});

describe('a tool with durable: false', () => {
  it('is not recorded, so every call of a cut round runs again', async () => {
    const fixture = setup(3, false);
    const storage = createInMemoryStorage();
    const first = fixture.harness(storage);
    const ctx = first.createContext();
    void first.run(fixture.agent, 'go', ctx).catch(() => {});
    await waitFor(() => fixture.attempts.length === 3);

    const next = fixture.harness(storage);
    const resumed = await next.restore(ctx.id);
    assert(resumed);
    expect(await next.run(fixture.agent, 'go', resumed)).toBe('shipped 3');
    expect(fixture.attempts.map((a) => a.n)).toEqual([
      1,
      2,
      3,
      1,
      2,
      3,
    ]);
  });
});

describe('what a replayed call leaves', () => {
  /** Runs until the host "dies" inside shipment 3, then resumes on a new harness. */
  async function cutOffInShipmentThree(fixture: ReturnType<typeof setup>): Promise<{
    before: string[];
    after: Item[];
  }> {
    const storage = createInMemoryStorage();
    const first = fixture.harness(storage);
    const ctx = first.createContext();
    void first.run(fixture.agent, 'go', ctx).catch(() => {});
    await waitFor(() => fixture.attempts.length === 3);
    // The ids of the result items the first process appended, from its call records.
    const before: string[] = [];
    for (const key of await storage.list(`execution:${ctx.id}:ledger:`)) {
      const parsed = CallRecordSchema.safeParse(await storage.get(key));
      if (parsed.success) {
        before.push(parsed.data.output.itemId);
      }
    }

    const next = fixture.harness(storage);
    const resumed = await next.restore(ctx.id);
    assert(resumed);
    expect(await next.run(fixture.agent, 'go', resumed)).toBe('shipped 3');
    return {
      before,
      after: [
        ...resumed.itemLog.items,
      ],
    };
  }

  const outputIds = (items: Item[]): Array<string | undefined> =>
    items.filter((item) => item.type === 'function_call_output').map((item) => item.id);

  it('records a result of 100,000 characters, so its call is not made again', async () => {
    // Regression: the record held the result twice and no longer fit the entry cap
    // at about half of it, so every finished call ran again on resume.
    const fixture = setup(3, undefined, 1e5);
    await cutOffInShipmentThree(fixture);
    expect(fixture.attempts.map((a) => a.n)).toEqual([
      1,
      2,
      3,
      3,
    ]);
  });

  it('appends the result item it appended the first time, under the same id', async () => {
    const fixture = setup(3);
    const { before, after } = await cutOffInShipmentThree(fixture);
    const [one, two] = before;
    assert(one && two);
    // A client that saw these items before the crash is not handed two more.
    expect(outputIds(after).slice(0, 2).sort()).toEqual(
      [
        one,
        two,
      ].sort(),
    );
    expect(new Set(outputIds(after)).size).toBe(SHIPMENTS);
  });

  it("draws the call in the tool's UI again, as it was drawn the first time", async () => {
    const fixture = setup(3);
    const drawnBefore = (): number => fixture.drawn.length;
    const storage = createInMemoryStorage();
    const first = fixture.harness(storage);
    const ctx = first.createContext();
    void first.run(fixture.agent, 'go', ctx).catch(() => {});
    await waitFor(() => fixture.attempts.length === 3);
    const seen = drawnBefore();
    expect(fixture.drawn).toEqual([
      'call:1',
      'result:1',
      'call:2',
      'result:2',
      'call:3',
    ]);

    const next = fixture.harness(storage);
    const resumed = await next.restore(ctx.id);
    assert(resumed);
    await next.run(fixture.agent, 'go', resumed);
    // The new process's UI starts empty: every call reaches its result in it.
    expect(fixture.drawn.slice(seen)).toEqual([
      'call:1',
      'result:1',
      'call:2',
      'result:2',
      'call:3',
      'result:3',
    ]);
  });
});

describe('a host that dies right after a durable call is recorded', () => {
  it('leaves nothing of the call behind once the run resumes: no intent, no hold', async () => {
    const fixture = setup(0, true);
    const inner = createInMemoryStorage();
    const isIntent = (key: string): boolean => key.includes(':intent:');
    // The first process stops dead at the first thing it does after recording a
    // result: dropping the call's intent.
    let dead = false;
    const dying: StorageAdapter = {
      ...inner,
      get: (key) => inner.get(key),
      set: (key, value) => (dead ? new Promise(() => {}) : inner.set(key, value)),
      list: (prefix) => inner.list(prefix),
      delete: (key) => {
        if (isIntent(key)) {
          dead = true;
        }
        return dead ? new Promise(() => {}) : inner.delete(key);
      },
    };
    const first = fixture.harness(dying);
    const ctx = first.createContext();
    void first.run(fixture.agent, 'go', ctx).catch(() => {});
    await waitFor(() => dead);
    expect((await inner.list('')).filter(isIntent)).toHaveLength(1);

    const next = fixture.harness(inner);
    const resumed = await next.restore(ctx.id);
    assert(resumed);
    expect(await next.run(fixture.agent, 'go', resumed)).toBe('shipped 3');
    // Shipment 1 was on record: it is not made again, and nobody is asked about it.
    expect(fixture.attempts.map((a) => a.n)).toEqual([
      1,
      2,
      3,
    ]);
    expect((await inner.list('')).filter(isIntent)).toEqual([]);
    expect(
      await next.pending({
        executionId: ctx.id,
      }),
    ).toEqual([]);
  });
});
