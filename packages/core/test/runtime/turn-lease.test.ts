// One writer per turn: the turn lease, the fenced step ledger, and two harnesses
// racing one turn. See specs/23-durable-execution § One writer per turn.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type { CallModelRequest, ContextData, Item, LLMResponse } from '@noetic-tools/types';
import { isNoeticError, NoeticErrorImpl } from '@noetic-tools/types';
import { callModel, runCode } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import type { StepLedgerEntry } from '../../src/runtime/durable/step-ledger';
import { createStepLedgerStore, StepLedger } from '../../src/runtime/durable/step-ledger';
import type { LedgerFence, TurnLeaseOptions } from '../../src/runtime/durable/turn-lease';
import { canSwap, TurnLease } from '../../src/runtime/durable/turn-lease';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { assistantMessage } from '../_helpers';

//#region Fixtures

const TTL = 1e3;
const SWAP = {
  swap: true,
};

interface Clock {
  t: number;
}

function leaseOptions(storage: StorageAdapter, holder: string, clock: Clock): TurnLeaseOptions {
  assert(canSwap(storage));
  return {
    storage,
    holder,
    ttlMs: TTL,
    waitMs: 0,
    now: () => clock.t,
  };
}

/** The `lease_lost` / `ledger_write_failed` payload an operation rejects with. */
async function failure(run: () => Promise<unknown>): Promise<{
  kind: string;
}> {
  try {
    await run();
  } catch (error) {
    assert(isNoeticError(error));
    return error.noeticError;
  }
  return expect.unreachable('expected a rejection');
}

function entry(path: string, output: string): StepLedgerEntry {
  return {
    path,
    stepId: path,
    kind: 'runCode',
    output,
    completedAt: new Date(0).toISOString(),
  };
}

/** A fence at a fixed term that records whether it was told it lost. */
function fenceAt(term: number): LedgerFence & {
  lostBecause?: string;
} {
  const fence: LedgerFence & {
    lostBecause?: string;
  } = {
    term,
    assert: () => {},
    lose: (reason) => {
      fence.lostBecause = reason;
      return new NoeticErrorImpl({
        kind: 'lease_lost',
        executionId: 'x',
        term,
        reason,
      });
    },
  };
  return fence;
}

function fencedLedger(storage: StorageAdapter, term: number, nextSeq = 0): StepLedger {
  const ledger = new StepLedger({
    executionId: 'x',
    store: createStepLedgerStore({
      storage,
    }),
    recovered: {
      entries: new Map(),
      seqs: new Map(),
      nextSeq,
    },
  });
  ledger.fence(fenceAt(term));
  return ledger;
}

//#endregion

describe('StorageAdapter.swap (in-memory)', () => {
  it('creates a key only when nothing is stored', async () => {
    const storage = createInMemoryStorage(SWAP);
    assert(storage.swap);
    expect(await storage.swap('k', null, 'first')).toBe(true);
    expect(await storage.swap('k', null, 'second')).toBe(false);
    expect(await storage.get<string>('k')).toBe('first');
  });

  it('replaces a value only when it still equals what the caller read', async () => {
    const storage = createInMemoryStorage(SWAP);
    assert(storage.swap);
    await storage.set('k', {
      n: 1,
    });
    expect(
      await storage.swap(
        'k',
        {
          n: 2,
        },
        {
          n: 3,
        },
      ),
    ).toBe(false);
    expect(
      await storage.swap(
        'k',
        {
          n: 1,
        },
        {
          n: 3,
        },
      ),
    ).toBe(true);
    expect(
      await storage.get<{
        n: number;
      }>('k'),
    ).toEqual({
      n: 3,
    });
  });
});

describe('TurnLease', () => {
  it('gives the first taker term 1 and refuses a second holder while it is held', async () => {
    const storage = createInMemoryStorage(SWAP);
    const clock: Clock = {
      t: 5e3,
    };
    const held = await TurnLease.take(leaseOptions(storage, 'a', clock), 't');
    expect(held.term).toBe(1);

    const refused = await failure(() => TurnLease.take(leaseOptions(storage, 'b', clock), 't'));
    expect(refused.kind).toBe('lease_lost');
  });

  it('lets another holder take over only once the time has run out', async () => {
    const storage = createInMemoryStorage(SWAP);
    const clock: Clock = {
      t: 5e3,
    };
    await TurnLease.take(leaseOptions(storage, 'a', clock), 't');

    clock.t = 5e3 + TTL - 1;
    expect((await failure(() => TurnLease.take(leaseOptions(storage, 'b', clock), 't'))).kind).toBe(
      'lease_lost',
    );
    clock.t = 5e3 + TTL;
    const taken = await TurnLease.take(leaseOptions(storage, 'b', clock), 't');
    expect(taken.term).toBe(2);
  });

  it('waits for a held lease to run out, then takes it', async () => {
    const storage = createInMemoryStorage(SWAP);
    const clock: Clock = {
      t: 0,
    };
    await TurnLease.take(leaseOptions(storage, 'a', clock), 't');
    // The holder dies: nothing renews, and its time runs out while the taker waits.
    setTimeout(() => {
      clock.t = TTL;
    }, 20);
    const taken = await TurnLease.take(
      {
        ...leaseOptions(storage, 'b', clock),
        waitMs: 2e3,
      },
      't',
    );
    expect(taken.term).toBe(2);
  });

  it('gives up on a lease that is still held when the wait ends', async () => {
    const storage = createInMemoryStorage(SWAP);
    const clock: Clock = {
      t: 0,
    };
    await TurnLease.take(leaseOptions(storage, 'a', clock), 't');
    const refused = await failure(() =>
      TurnLease.take(
        {
          ...leaseOptions(storage, 'b', clock),
          waitMs: 30,
        },
        't',
      ),
    );
    expect(refused.kind).toBe('lease_lost');
  });

  it('stops asserting once its time runs out without a renewal', async () => {
    const storage = createInMemoryStorage(SWAP);
    const clock: Clock = {
      t: 0,
    };
    const lease = await TurnLease.take(leaseOptions(storage, 'a', clock), 't');
    clock.t = TTL - 1;
    expect(() => lease.assert()).not.toThrow();
    clock.t = TTL;
    expect(() => lease.assert()).toThrow('lost its lease');
    expect(lease.lost).toBe(true);
  });

  it('a renewal pushes the deadline out', async () => {
    const storage = createInMemoryStorage(SWAP);
    const clock: Clock = {
      t: 0,
    };
    const lease = await TurnLease.take(leaseOptions(storage, 'a', clock), 't');
    clock.t = TTL - 1;
    await lease.renew();
    clock.t = TTL + 1;
    expect(() => lease.assert()).not.toThrow();
  });

  it('a holder that was replaced finds out on renewal and tells the turn', async () => {
    const storage = createInMemoryStorage(SWAP);
    const clock: Clock = {
      t: 0,
    };
    const stale = await TurnLease.take(leaseOptions(storage, 'a', clock), 't');
    const reasons: string[] = [];
    stale.keep((reason) => reasons.push(reason));
    clock.t = TTL;
    await TurnLease.take(leaseOptions(storage, 'b', clock), 't');

    await stale.renew();
    expect(stale.lost).toBe(true);
    expect(reasons).toEqual([
      'another harness took the lease',
    ]);
    await stale.release();
  });

  it('a released lease can be taken at once, at the next term', async () => {
    const storage = createInMemoryStorage(SWAP);
    const clock: Clock = {
      t: 0,
    };
    const first = await TurnLease.take(leaseOptions(storage, 'a', clock), 't');
    await first.release();
    const second = await TurnLease.take(leaseOptions(storage, 'b', clock), 't');
    expect(second.term).toBe(2);
  });

  it('names the bound execution in the error it raises', async () => {
    const storage = createInMemoryStorage(SWAP);
    const clock: Clock = {
      t: 0,
    };
    const lease = await TurnLease.take(leaseOptions(storage, 'a', clock), 't');
    lease.bind('exec-1');
    const error = lease.lose('replaced');
    expect(error.noeticError).toEqual({
      kind: 'lease_lost',
      executionId: 'exec-1',
      term: 1,
      reason: 'replaced',
    });
  });
});

describe('a fenced step ledger', () => {
  it('tags what it records with the lease term', async () => {
    const storage = createInMemoryStorage(SWAP);
    await fencedLedger(storage, 4).record(entry('/a#0', 'out'));
    const stored = await createStepLedgerStore({
      storage,
    }).load('x');
    expect(stored.entries.get('/a#0')?.term).toBe(4);
  });

  it('a replaced harness loses when a higher term already holds the sequence number', async () => {
    const storage = createInMemoryStorage(SWAP);
    await fencedLedger(storage, 5).record(entry('/a#0', 'new'));

    const stale = fencedLedger(storage, 4);
    const lost = await failure(() => stale.record(entry('/a#0', 'old')));
    expect(lost.kind).toBe('lease_lost');
    const stored = await createStepLedgerStore({
      storage,
    }).load('x');
    expect(stored.entries.get('/a#0')?.output).toBe('new');
  });

  it("overwrites a replaced harness's late write at the same sequence number", async () => {
    const storage = createInMemoryStorage(SWAP);
    await fencedLedger(storage, 4).record(entry('/a#0', 'old'));

    expect(await fencedLedger(storage, 5).record(entry('/a#0', 'new'))).toBe(true);
    const stored = await createStepLedgerStore({
      storage,
    }).load('x');
    expect(stored.entries.get('/a#0')).toMatchObject({
      output: 'new',
      term: 5,
    });
  });

  it("ignores a replaced harness's entry recorded after a higher term's", async () => {
    const storage = createInMemoryStorage(SWAP);
    await fencedLedger(storage, 5, 0).record(entry('/a#0', 'new'));
    // The stale harness's own counter had run ahead, so its write lands later in order.
    await fencedLedger(storage, 4, 3).record(entry('/a#0', 'old'));

    const stored = await createStepLedgerStore({
      storage,
    }).load('x');
    expect(stored.entries.get('/a#0')?.output).toBe('new');
    expect(stored.nextSeq).toBe(4);
  });

  it('stops the turn when a write fails, where an unfenced ledger only warns', async () => {
    const failing: StorageAdapter = {
      ...createInMemoryStorage(SWAP),
      swap: async () => {
        throw new Error('disk full');
      },
      set: async () => {
        throw new Error('disk full');
      },
    };
    const failed = await failure(() => fencedLedger(failing, 1).record(entry('/a#0', 'out')));
    expect(failed).toMatchObject({
      kind: 'ledger_write_failed',
      executionId: 'x',
      path: '/a#0',
    });

    const unfenced = new StepLedger({
      executionId: 'x',
      store: createStepLedgerStore({
        storage: failing,
      }),
    });
    expect(await unfenced.record(entry('/a#0', 'out'))).toBe(false);
  });
});

describe('two harnesses racing one turn', () => {
  interface Model {
    calls: number;
    call: (request: CallModelRequest) => Promise<LLMResponse>;
    release: () => void;
  }

  /** A model that answers `<tag>-<n>`; its first call waits for `release` when `gated`. */
  function model(tag: string, gated: boolean): Model {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const m: Model = {
      calls: 0,
      release: open,
      call: async () => {
        m.calls += 1;
        const n = m.calls;
        if (gated && n === 1) {
          await gate;
        }
        return {
          items: [
            assistantMessage(`${tag}-${n}`),
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

  const turn = (id: string) =>
    callModel<ContextData, string, string>({
      id,
      model: 'test/model',
    });

  const twoTurns = runCode<ContextData, string, string>({
    id: 'two-turns',
    execute: async (input, execCtx) => {
      const a = String(await execCtx.harness.run(turn('plan'), input, execCtx));
      return String(await execCtx.harness.run(turn('answer'), a, execCtx));
    },
  });

  function harnessOver(opts: { storage: StorageAdapter; m: Model; holder: string; clock: Clock }) {
    const { storage, m, holder, clock } = opts;
    return new AgentHarness({
      name: 'race',
      params: {},
      agentGraph: twoTurns,
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

  const scope = {
    threadId: 't',
  };
  const delivery = {
    threadId: 't',
    messageId: 'm-1',
  };

  function assistantTexts(items: ReadonlyArray<Item>): string[] {
    return items.flatMap((item) => {
      if (item.type !== 'message' || item.role !== 'assistant') {
        return [];
      }
      return typeof item.content === 'string'
        ? [
            item.content,
          ]
        : [
            item.content.map((part) => ('text' in part ? part.text : '')).join(''),
          ];
    });
  }

  async function waitFor(done: () => boolean): Promise<void> {
    for (let i = 0; i < 2e3 && !done(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert(done());
  }

  it('refuses a second harness while the first holds the turn', async () => {
    const storage = createInMemoryStorage(SWAP);
    const clock: Clock = {
      t: 0,
    };
    const slow = model('a', true);
    const first = harnessOver({
      storage,
      m: slow,
      holder: 'a',
      clock,
    });
    await first.execute('hello', delivery);
    await waitFor(() => slow.calls === 1);

    const eager = model('b', false);
    const second = harnessOver({
      storage,
      m: eager,
      holder: 'b',
      clock,
    });
    await second.execute('hello', delivery);
    const refused = await failure(() => second.getAgentResponse(scope));
    expect(refused.kind).toBe('lease_lost');
    expect(eager.calls).toBe(0);

    slow.release();
    const response = await first.getAgentResponse(scope);
    expect(assistantTexts(response.items)).toEqual([
      'a-1',
      'a-2',
    ]);
  });

  it("only the new holder's work lands, and the replaced harness stops before paying again", async () => {
    const storage = createInMemoryStorage(SWAP);
    const clock: Clock = {
      t: 0,
    };
    const stalled = model('a', true);
    const first = harnessOver({
      storage,
      m: stalled,
      holder: 'a',
      clock,
    });
    await first.execute('hello', delivery);
    await waitFor(() => stalled.calls === 1);

    // The first harness goes quiet past its lease; a second one picks the turn up.
    clock.t = TTL;
    const taker = model('b', false);
    const second = harnessOver({
      storage,
      m: taker,
      holder: 'b',
      clock,
    });
    await second.execute('hello', delivery);
    const response = await second.getAgentResponse(scope);
    expect(assistantTexts(response.items)).toEqual([
      'b-1',
      'b-2',
    ]);

    // The first harness's model call comes back to a turn it no longer holds.
    stalled.release();
    await expect(first.getAgentResponse(scope)).rejects.toThrow();
    expect(stalled.calls).toBe(1);

    // Storage holds the second harness's turn and nothing of the first's.
    const stored = await storage.get<{
      items: Item[];
      turn?: unknown;
    }>('session:t');
    assert(stored);
    expect(assistantTexts(stored.items)).toEqual([
      'b-1',
      'b-2',
    ]);
    expect(stored.turn).toBeUndefined();
  });
});
