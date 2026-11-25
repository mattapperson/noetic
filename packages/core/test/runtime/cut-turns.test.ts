// Cut turns, the turnOptions hook and per-turn tools.
// See specs/23-durable-execution § Cut turns, § Parked turns.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type {
  CallModelRequest,
  ContextData,
  ExecuteOptions,
  LLMResponse,
  StoredTurn,
} from '@noetic-tools/types';
import { isNoeticError, NoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';
import { callModel } from '../../src/builders/step-builders';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { TurnCuts } from '../../src/harness/turn-cuts';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { assistantMessage } from '../_helpers';

//#region Fixtures

const TTL = 1e3;

interface Clock {
  t: number;
}

/** Storage whose ledger writes throw while `failing` is set. */
interface FlakyStorage extends StorageAdapter {
  failing: boolean;
}

function flakyStorage(refused = ':ledger:'): FlakyStorage {
  const inner = createInMemoryStorage({
    swap: true,
  });
  const swap = inner.swap?.bind(inner);
  assert(swap);
  const refuse = (key: string): void => {
    if (storage.failing && key.includes(refused)) {
      throw new Error('storage unavailable');
    }
  };
  const storage: FlakyStorage = {
    failing: false,
    get: (key) => inner.get(key),
    set: async (key, value) => {
      refuse(key);
      await inner.set(key, value);
    },
    delete: (key) => inner.delete(key),
    list: (prefix) => inner.list(prefix),
    swap: async (key, prev, next) => {
      refuse(key);
      return swap(key, prev, next);
    },
  };
  return storage;
}

/** A model that answers `answer-<n>`, and records the tool names of each call. */
interface CountingModel {
  calls: number;
  tools: string[][];
  call: (request: CallModelRequest) => Promise<LLMResponse>;
}

function countingModel(): CountingModel {
  const tools: string[][] = [];
  const m: CountingModel = {
    calls: 0,
    tools,
    call: async (request: CallModelRequest): Promise<LLMResponse> => {
      m.calls += 1;
      m.tools.push((request.tools ?? []).map((t) => t.name));
      return {
        items: [
          assistantMessage(`answer-${m.calls}`),
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

function harnessOver(opts: {
  storage: StorageAdapter;
  clock: Clock;
  model: CountingModel;
  holder?: string;
  cut?: {
    attempts?: number;
    delayMs?: number;
    maxDelayMs?: number;
  };
  turnOptions?: (turn: StoredTurn) => ExecuteOptions;
}): AgentHarness {
  return new AgentHarness({
    name: 'cut',
    params: {},
    agentGraph: callModel<ContextData, string, string>({
      id: 'respond',
      model: 'test/model',
    }),
    now: () => opts.clock.t,
    environment: {
      storage: {
        adapter: opts.storage,
        lease: {
          holder: opts.holder ?? 'a',
          ttlMs: TTL,
          waitMs: 0,
          ...(opts.cut
            ? {
                cut: opts.cut,
              }
            : {}),
        },
      },
    },
    ...(opts.turnOptions
      ? {
          turnOptions: opts.turnOptions,
        }
      : {}),
    _testCallModel: (request) => opts.model.call(request),
  });
}

const scope = {
  threadId: 't',
};
const delivery = {
  threadId: 't',
  messageId: 'm-1',
};

interface StoredSession {
  turn?: {
    cut?: {
      reason: string;
      count: number;
      at: number;
    };
    stopped?: unknown;
  };
  steers?: Array<{
    id: string;
  }>;
}

async function collectTypes(harness: AgentHarness, into: string[]): Promise<void> {
  for await (const event of harness.getFullStream(scope)) {
    into.push(event.type);
  }
}

const lookup = (name: string) =>
  tool({
    name,
    description: `The ${name} tool.`,
    input: z.object({}),
    output: z.string(),
    execute: async () => name,
  });

//#endregion

describe('TurnCuts', () => {
  it('doubles the back-off for each cut, up to its ceiling', () => {
    const cuts = new TurnCuts({
      delayMs: 100,
      maxDelayMs: 300,
    });
    const at = 1e4;
    expect(
      cuts.dueAt({
        reason: 'lease_lost',
        count: 1,
        at,
      }),
    ).toBe(at + 100);
    expect(
      cuts.dueAt({
        reason: 'lease_lost',
        count: 2,
        at,
      }),
    ).toBe(at + 200);
    expect(
      cuts.dueAt({
        reason: 'lease_lost',
        count: 3,
        at,
      }),
    ).toBe(at + 300);
    expect(
      cuts.dueAt({
        reason: 'lease_lost',
        count: 9,
        at,
      }),
    ).toBe(at + 300);
  });

  it('allows `attempts` cuts of a turn and refuses the one after', () => {
    const cuts = new TurnCuts({
      attempts: 2,
    });
    const turn = {
      messageIds: [
        'm-1',
      ],
    };
    expect(cuts.cut('t', turn, 'ledger_write_failed', 1)?.count).toBe(1);
    expect(cuts.cut('t', turn, 'ledger_write_failed', 2)?.count).toBe(2);
    expect(cuts.cut('t', turn, 'ledger_write_failed', 3)).toBeUndefined();
    // Giving up forgets the count.
    expect(cuts.markOf('t', turn)).toBeUndefined();
  });

  it('counts from the stored mark or its own, whichever is higher, for the same delivery only', () => {
    const cuts = new TurnCuts(undefined);
    cuts.cut(
      't',
      {
        messageIds: [
          'm-1',
        ],
      },
      'lease_lost',
      1,
    );
    const stored = {
      reason: 'lease_lost',
      count: 2,
      at: 5,
    };
    expect(
      cuts.markOf('t', {
        messageIds: [
          'm-1',
        ],
        cut: stored,
      }),
    ).toEqual(stored);
    expect(
      cuts.markOf('t', {
        messageIds: [
          'm-1',
        ],
      })?.count,
    ).toBe(1);
    expect(
      cuts.markOf('t', {
        messageIds: [
          'm-2',
        ],
      }),
    ).toBeUndefined();
    cuts.forget('t');
    expect(
      cuts.markOf('t', {
        messageIds: [
          'm-1',
        ],
      }),
    ).toBeUndefined();
  });

  it('cuts only for a lost lease or a failed durable write', () => {
    const cuts = new TurnCuts(undefined);
    expect(cuts.reasonOf(new Error('boom'))).toBeUndefined();
  });

  it('refuses settings it cannot use', () => {
    for (const cut of [
      {
        attempts: -1,
      },
      {
        attempts: 1.5,
      },
      {
        delayMs: -1,
      },
      {
        delayMs: 10,
        maxDelayMs: 5,
      },
      {
        maxDelayMs: Number.POSITIVE_INFINITY,
      },
    ]) {
      expect(() => new TurnCuts(cut)).toThrow(NoeticConfigError);
    }
  });
});

describe('a turn cut by a failed durable write', () => {
  it('answers cut, stays on record, and a wake after its back-off runs it to the end', async () => {
    const storage = flakyStorage();
    const clock: Clock = {
      t: 1e6,
    };
    const model = countingModel();
    const harness = harnessOver({
      storage,
      clock,
      model,
    });
    const events: string[] = [];
    void collectTypes(harness, events);
    const heard: Array<number | undefined> = [];
    harness.onWakeTimeChange((at) => {
      heard.push(at);
    });
    await harness.start();

    storage.failing = true;
    await harness.execute('hello', delivery);
    const response = await harness.getAgentResponse(scope);
    expect(response.cut).toEqual({
      reason: 'ledger_write_failed',
      attempt: 1,
      wakeAt: clock.t + 1e3,
    });
    expect(response.text).toBe('');
    for (let i = 0; i < 200 && !events.includes('cut:turn_cut'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(events).toContain('cut:turn_cut');
    expect(events).not.toContain('cut:turn_aborted');

    const stored = await storage.get<StoredSession>('session:t');
    expect(stored?.turn?.cut).toEqual({
      reason: 'ledger_write_failed',
      count: 1,
      at: clock.t,
    });
    expect(stored?.turn?.stopped).toBeUndefined();
    expect(await harness.getNextWakeTime()).toBe(clock.t + 1e3);
    expect(heard.at(-1)).toBe(clock.t + 1e3);

    // Not due yet: a routine wake leaves it alone.
    storage.failing = false;
    expect(await harness.wake()).toEqual([]);

    clock.t += 1e3;
    expect(await harness.wake()).toEqual([
      't',
    ]);
    const done = await harness.getAgentResponse(scope);
    expect(done.cut).toBeUndefined();
    expect(done.text).toBe(`answer-${model.calls}`);
    const after = await storage.get<StoredSession>('session:t');
    expect(after?.turn).toBeUndefined();
    expect(await harness.getNextWakeTime()).toBeUndefined();
  });

  it('gives up after `attempts` cuts: the turn fails and a routine wake leaves it alone', async () => {
    const storage = flakyStorage();
    const clock: Clock = {
      t: 1e6,
    };
    const harness = harnessOver({
      storage,
      clock,
      model: countingModel(),
      cut: {
        attempts: 1,
      },
    });
    storage.failing = true;
    await harness.execute('hello', delivery);
    expect((await harness.getAgentResponse(scope)).cut?.attempt).toBe(1);

    clock.t += 1e3;
    expect(await harness.wake()).toEqual([
      't',
    ]);
    try {
      await harness.getAgentResponse(scope);
      expect.unreachable('the second cut fails the turn');
    } catch (error) {
      assert(isNoeticError(error));
      expect(error.noeticError.kind).toBe('ledger_write_failed');
    }
    const stored = await storage.get<StoredSession>('session:t');
    expect(stored?.turn?.stopped).toBeDefined();
    expect(stored?.turn?.cut).toBeUndefined();
    clock.t += 1e5;
    expect(await harness.wake()).toEqual([]);
  });

  it('with `attempts: 0` fails the turn as before', async () => {
    const storage = flakyStorage();
    const harness = harnessOver({
      storage,
      clock: {
        t: 0,
      },
      model: countingModel(),
      cut: {
        attempts: 0,
      },
    });
    storage.failing = true;
    await harness.execute('hello', delivery);
    expect(harness.getAgentResponse(scope)).rejects.toThrow();
  });

  it('keeps a message sent to the cut thread for after it, rather than starting a turn', async () => {
    const storage = flakyStorage();
    const clock: Clock = {
      t: 0,
    };
    const model = countingModel();
    const harness = harnessOver({
      storage,
      clock,
      model,
    });
    storage.failing = true;
    await harness.execute('hello', delivery);
    expect((await harness.getAgentResponse(scope)).cut).toBeDefined();
    storage.failing = false;

    const calls = model.calls;
    await harness.execute('and another thing', {
      threadId: 't',
      messageId: 'm-2',
    });
    await harness.waitForIdle();
    expect(model.calls).toBe(calls);
    const stored = await storage.get<StoredSession>('session:t');
    expect(stored?.steers?.map((s) => s.id)).toEqual([
      'm-2',
    ]);
    expect(stored?.turn?.cut?.count).toBe(1);
  });
});

describe('a turn whose checkpoint cannot be written either', () => {
  it('still counts its cuts across resumes under new executions, and gives up', async () => {
    // Every execution key is refused: no snapshot lands, so each resume starts a
    // new execution of the same messages.
    const storage = flakyStorage('execution:');
    const clock: Clock = {
      t: 0,
    };
    const model = countingModel();
    const harness = harnessOver({
      storage,
      clock,
      model,
      cut: {
        attempts: 2,
      },
    });
    storage.failing = true;
    await harness.execute('hello', delivery);
    expect((await harness.getAgentResponse(scope)).cut?.attempt).toBe(1);
    clock.t += 1e4;
    expect(await harness.wake()).toEqual([
      't',
    ]);
    expect((await harness.getAgentResponse(scope)).cut?.attempt).toBe(2);
    clock.t += 1e4;
    expect(await harness.wake()).toEqual([
      't',
    ]);
    expect(harness.getAgentResponse(scope)).rejects.toThrow();
    await harness.waitForIdle();
    const stored = await storage.get<StoredSession>('session:t');
    expect(stored?.turn?.stopped).toBeDefined();
    clock.t += 1e5;
    expect(await harness.wake()).toEqual([]);
    expect(model.calls).toBe(3);
  });
});

describe('a turn another holder took', () => {
  /** A model whose first call waits for `release`. */
  function gatedModel(tag: string): {
    release: () => void;
    call: (request: CallModelRequest) => Promise<LLMResponse>;
  } {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let calls = 0;
    return {
      release: open,
      call: async () => {
        calls += 1;
        if (calls === 1) {
          await gate;
        }
        return {
          items: [
            assistantMessage(`${tag}-${calls}`),
          ],
          usage: {
            inputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };
  }

  function racer(opts: {
    storage: StorageAdapter;
    clock: Clock;
    holder: string;
    m: {
      call: CountingModel['call'];
    };
  }): AgentHarness {
    const { storage, clock, holder, m } = opts;
    return new AgentHarness({
      name: 'race',
      params: {},
      agentGraph: callModel<ContextData, string, string>({
        id: 'respond',
        model: 'test/model',
      }),
      now: () => clock.t,
      environment: {
        storage: {
          adapter: storage,
          lease: {
            holder,
            ttlMs: TTL,
            waitMs: 0,
            now: () => clock.t,
          },
        },
      },
      _testCallModel: (request) => m.call(request),
    });
  }

  async function until(done: () => Promise<boolean> | boolean): Promise<void> {
    for (let i = 0; i < 2e3 && !(await done()); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert(await done());
  }

  it('is cut while that holder runs it: nothing is written and nothing is counted', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const clock: Clock = {
      t: 0,
    };
    const slowA = gatedModel('a');
    const a = racer({
      storage,
      clock,
      holder: 'a',
      m: slowA,
    });
    await a.execute('hello', delivery);
    await until(async () => (await storage.get('session:t')) !== null);

    clock.t = TTL * 2;
    const slowB = gatedModel('b');
    const b = racer({
      storage,
      clock,
      holder: 'b',
      m: slowB,
    });
    await b.execute('hello', delivery);
    await until(async () => {
      const lease = await storage.get<{
        holder: string;
      }>('turn-lease:t');
      return lease?.holder === 'b';
    });

    slowA.release();
    const cut = (await a.getAgentResponse(scope)).cut;
    assert(cut);
    expect(cut.reason).toBe('lease_lost');
    expect(cut.attempt).toBeUndefined();
    expect(cut.wakeAt).toBeGreaterThan(clock.t);
    const after = await storage.get<StoredSession>('session:t');
    // The turn is B's, untouched: no cut mark, no stop.
    expect(after?.turn?.cut).toBeUndefined();
    expect(after?.turn?.stopped).toBeUndefined();

    slowB.release();
    expect((await b.getAgentResponse(scope)).text).toBe('b-1');
  });

  it('fails as before once that holder finished it, and the message queued behind it still runs here', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const clock: Clock = {
      t: 0,
    };
    const slowA = gatedModel('a');
    const a = racer({
      storage,
      clock,
      holder: 'a',
      m: slowA,
    });
    await a.execute('hello', delivery);
    await until(async () => (await storage.get('session:t')) !== null);
    await a.execute('and then', {
      threadId: 't',
      messageId: 'm-2',
    });

    clock.t = TTL * 2;
    const b = racer({
      storage,
      clock,
      holder: 'b',
      m: countingModel(),
    });
    await b.execute('hello', delivery);
    expect((await b.getAgentResponse(scope)).text).toBe('answer-1');

    slowA.release();
    expect(a.getAgentResponse(scope)).rejects.toThrow();
    // m-2 was not moved into storage for a turn that is over: it runs as A's next turn.
    await until(async () => {
      const stored = await storage.get<{
        done?: Array<{
          messageIds: string[];
        }>;
      }>('session:t');
      return (stored?.done ?? []).some((turn) => turn.messageIds.includes('m-2'));
    });
    const stored = await storage.get<StoredSession>('session:t');
    expect(stored?.steers ?? []).toEqual([]);
  });
});

describe('turnOptions', () => {
  it('gives a woken turn the options a wake was not given, and its tools reach the model', async () => {
    const storage = flakyStorage();
    const clock: Clock = {
      t: 0,
    };
    const model = countingModel();
    const asked: StoredTurn[] = [];
    const harness = harnessOver({
      storage,
      clock,
      model,
      turnOptions: (turn) => {
        asked.push(turn);
        return {
          tools: [
            lookup('rebuilt'),
          ],
        };
      },
    });
    storage.failing = true;
    await harness.execute('hello', {
      ...delivery,
      tools: [
        lookup('rebuilt'),
      ],
    });
    expect((await harness.getAgentResponse(scope)).cut).toBeDefined();
    storage.failing = false;

    // A fresh harness, as after the isolate died, knows nothing of the turn's options.
    const fresh = harnessOver({
      storage,
      clock,
      model,
      turnOptions: (turn) => {
        asked.push(turn);
        return {
          tools: [
            lookup('rebuilt'),
          ],
        };
      },
    });
    clock.t += 1e3;
    expect(await fresh.wake()).toEqual([
      't',
    ]);
    await fresh.getAgentResponse(scope);
    const turn = asked.at(-1);
    assert(turn);
    expect(turn.threadId).toBe('t');
    expect(turn.messageIds).toEqual([
      'm-1',
    ]);
    expect(turn.cut?.count).toBe(1);
    expect(model.tools.at(-1)).toContain('rebuilt');
  });

  it('is not asked when the wake names its options', async () => {
    const storage = flakyStorage();
    const clock: Clock = {
      t: 0,
    };
    let asked = 0;
    const harness = harnessOver({
      storage,
      clock,
      model: countingModel(),
      turnOptions: () => {
        asked += 1;
        return {};
      },
    });
    storage.failing = true;
    await harness.execute('hello', delivery);
    await harness.getAgentResponse(scope);
    storage.failing = false;
    clock.t += 1e3;
    await harness.wake({
      threadId: 't',
      options: {},
    });
    await harness.getAgentResponse(scope);
    expect(asked).toBe(0);
  });
});

describe('ExecuteOptions.tools', () => {
  it('offers the turn its own tools, ahead of a harness tool of the same name', async () => {
    const model = countingModel();
    const harnessLookup = lookup('lookup');
    const turnLookup = lookup('lookup');
    let offered: unknown[] = [];
    const harness = new AgentHarness({
      name: 'tools',
      params: {},
      tools: [
        harnessLookup,
        lookup('other'),
      ],
      agentGraph: callModel<ContextData, string, string>({
        id: 'respond',
        model: 'test/model',
      }),
      _testCallModel: async (request) => {
        offered = request.tools ?? [];
        return model.call(request);
      },
    });
    await harness.execute('hi', {
      tools: [
        turnLookup,
        lookup('extra'),
      ],
    });
    await harness.getAgentResponse();
    expect(offered).toContain(turnLookup);
    expect(offered).not.toContain(harnessLookup);
    expect(model.tools[0]?.sort()).toEqual([
      'extra',
      'lookup',
      'other',
    ]);

    // The next turn without them has the harness's alone.
    await harness.execute('again');
    await harness.getAgentResponse();
    expect(model.tools[1]?.sort()).toEqual([
      'lookup',
      'other',
    ]);
  });
});

describe('a Durable Object that names itself as the lease holder', () => {
  it('finds a turn its dead isolate was running due at once; a stranger waits out the lease', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const clock: Clock = {
      t: 0,
    };
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dying = new AgentHarness({
      name: 'cut',
      params: {},
      agentGraph: callModel<ContextData, string, string>({
        id: 'respond',
        model: 'test/model',
      }),
      now: () => clock.t,
      environment: {
        storage: {
          adapter: storage,
          lease: {
            holder: 'object-1',
            ttlMs: TTL,
            waitMs: 0,
          },
        },
      },
      _testCallModel: async () => {
        await gate;
        return {
          items: [],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
          },
        };
      },
    });
    await dying.execute('hello', delivery);
    for (let i = 0; i < 200 && !(await storage.get('session:t')); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    // The isolate is gone; the object comes back under the same id.
    const model = countingModel();
    const back = harnessOver({
      storage,
      clock,
      model,
      holder: 'object-1',
    });
    expect(await back.getNextWakeTime()).toBe(clock.t);
    const stranger = harnessOver({
      storage,
      clock,
      model,
      holder: 'someone-else',
    });
    expect(await stranger.getNextWakeTime()).toBeGreaterThan(clock.t);

    expect(await back.wake()).toEqual([
      't',
    ]);
    expect((await back.getAgentResponse(scope)).text).toBe('answer-1');
    release();
  });
});
