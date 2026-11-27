// One writer per turn: the turn lease, the fenced step ledger, and two harnesses
// racing one turn. See specs/23-durable-execution § One writer per turn.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/context';
import type { CallModelRequest, ContextData, Item, LLMResponse } from '@noetic-tools/types';
import { isNoeticError, NoeticConfigError, NoeticErrorImpl } from '@noetic-tools/types';
import { callModel, runCode } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import type { StepLedgerEntry } from '../../src/runtime/durable/step-ledger';
import { createStepLedgerStore, StepLedger } from '../../src/runtime/durable/step-ledger';
import type { LedgerFence, TurnLeaseOptions } from '../../src/runtime/durable/turn-lease';
import { canSwap, TurnLease } from '../../src/runtime/durable/turn-lease';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { assistantMessage, slowStorage } from '../_helpers';

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
    verify: async () => {},
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

describe('TurnLease against a bad clock or slow storage', () => {
  it('learns from storage that it was replaced, though its own clock says it holds', async () => {
    const storage = createInMemoryStorage(SWAP);
    const slow: Clock = {
      t: 0,
    };
    const fast: Clock = {
      t: TTL,
    };
    const stale = await TurnLease.take(leaseOptions(storage, 'a', slow), 't');
    await TurnLease.take(leaseOptions(storage, 'b', fast), 't');

    // By its own clock the first holder is fine.
    expect(() => stale.assert()).not.toThrow();
    const lost = await failure(() => stale.verify());
    expect(lost.kind).toBe('lease_lost');
    expect(stale.lost).toBe(true);
  });

  it('does not evict itself when two renewals overlap on slow storage', async () => {
    const storage = slowStorage(createInMemoryStorage(SWAP), 20);
    const clock: Clock = {
      t: 0,
    };
    const lease = await TurnLease.take(leaseOptions(storage, 'a', clock), 't');
    await Promise.all([
      lease.renew(),
      lease.renew(),
      lease.renew(),
    ]);
    expect(lease.lost).toBe(false);
    await lease.verify();
  });

  it('a release waits for a renewal in flight, so the lease is free afterwards', async () => {
    const storage = slowStorage(createInMemoryStorage(SWAP), 20);
    const clock: Clock = {
      t: 0,
    };
    const lease = await TurnLease.take(leaseOptions(storage, 'a', clock), 't');
    const renewing = lease.renew();
    await lease.release();
    await renewing;
    const next = await TurnLease.take(leaseOptions(storage, 'b', clock), 't');
    expect(next.term).toBe(2);
  });

  it('takes a thread whose lease record is not one it can read', async () => {
    const storage = createInMemoryStorage(SWAP);
    await storage.set('turn-lease:t', {
      holder: 'someone',
      junk: true,
    });
    const clock: Clock = {
      t: 0,
    };
    clock.t = 1.7e12;
    const lease = await TurnLease.take(leaseOptions(storage, 'a', clock), 't');
    // Not back to 1: entries an earlier holder left in the ledger would outrank
    // it, and every write of the thread would lose from then on.
    expect(lease.term).toBe(1.7e12);
    await lease.release();
    expect((await TurnLease.take(leaseOptions(storage, 'b', clock), 't')).term).toBe(1.7e12 + 1);
  });

  it('keeps the term of a record it cannot otherwise read', async () => {
    const storage = createInMemoryStorage(SWAP);
    await storage.set('turn-lease:t', {
      term: 41,
      holder: 7,
    });
    const clock: Clock = {
      t: 0,
    };
    expect((await TurnLease.take(leaseOptions(storage, 'a', clock), 't')).term).toBe(42);
  });

  it("is not the session record of a thread named after another's lease", async () => {
    const storage = createInMemoryStorage(SWAP);
    const clock: Clock = {
      t: 0,
    };
    await TurnLease.take(leaseOptions(storage, 'a', clock), 't');
    // A thread may be called anything, 't:lease' included.
    expect(await storage.get('session:t:lease')).toBeNull();
    expect(await storage.list('session:')).toEqual([]);
  });

  it('keeps taking a thread whose lease record gained a field it does not know', async () => {
    const storage = createInMemoryStorage(SWAP);
    await storage.set('turn-lease:t', {
      term: 7,
      holder: 'old',
      heldUntil: 0,
      region: 'eu',
    });
    const clock: Clock = {
      t: 0,
    };
    const lease = await TurnLease.take(leaseOptions(storage, 'a', clock), 't');
    expect(lease.term).toBe(8);
  });

  it('stops waiting for a held lease when told to', async () => {
    const storage = createInMemoryStorage(SWAP);
    const clock: Clock = {
      t: 0,
    };
    await TurnLease.take(leaseOptions(storage, 'a', clock), 't');
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 20);
    const started = Date.now();
    const refused = await failure(() =>
      TurnLease.take(
        {
          ...leaseOptions(storage, 'b', clock),
          waitMs: 5e3,
        },
        't',
        {
          signal: abort.signal,
        },
      ),
    );
    // Told to stop is not the same as losing the lease.
    expect(refused.kind).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(1e3);
  });
});

describe('a fenced step ledger', () => {
  it('blocks dispatch if a replacement saved its intent while the stale CAS was in flight', async () => {
    const saved = createInMemoryStorage(SWAP);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const key = 'execution:x:pending:step';
    const storage: StorageAdapter = {
      ...saved,
      async swap(key, prior, next) {
        if (next === 'stale intent') {
          entered.resolve();
          await release.promise;
        }
        return await saved.swap!(key, prior, next);
      },
    };
    const first = await TurnLease.take(
      leaseOptions(storage, 'a', {
        t: 0,
      }),
      't',
    );
    const stale = fencedLedger(storage, first.term);
    stale.fence(first);
    const blocked = failure(() => stale.writeIntent(storage, key, null, 'stale intent'));
    await entered.promise;

    const second = await TurnLease.take(
      leaseOptions(storage, 'b', {
        t: TTL,
      }),
      't',
    );
    const current = fencedLedger(storage, second.term);
    current.fence(second);
    try {
      await current.writeIntent(storage, key, null, 'current intent');
    } finally {
      release.resolve();
      await second.release();
    }
    expect((await blocked).kind).toBe('lease_lost');
    expect(await storage.get(key)).toBe('current intent');
  });

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

  it('a harness whose clock runs behind cannot overwrite the turn another one finished', async () => {
    const storage = createInMemoryStorage(SWAP);
    // The first harness's clock never moves; the second's is a lease period ahead.
    const behind: Clock = {
      t: 0,
    };
    const ahead: Clock = {
      t: TTL,
    };
    const stalled = model('a', true);
    const first = harnessOver({
      storage,
      m: stalled,
      holder: 'a',
      clock: behind,
    });
    await first.execute('hello', delivery);
    await waitFor(() => stalled.calls === 1);

    const taker = model('b', false);
    const second = harnessOver({
      storage,
      m: taker,
      holder: 'b',
      clock: ahead,
    });
    await second.execute('hello', delivery);
    expect(assistantTexts((await second.getAgentResponse(scope)).items)).toEqual([
      'b-1',
      'b-2',
    ]);

    // By its own clock the first harness still holds the turn. The record's term
    // says otherwise, so its write is refused.
    stalled.release();
    const lost = await failure(() => first.getAgentResponse(scope));
    expect(lost.kind).toBe('lease_lost');
    const stored = await storage.get<{
      items: Item[];
      term?: number;
    }>('session:t');
    assert(stored);
    expect(assistantTexts(stored.items)).toEqual([
      'b-1',
      'b-2',
    ]);
    expect(stored.term).toBe(2);
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

    // The first harness's model call comes back to a turn it no longer holds, and
    // that the new holder has finished: nothing is left to cut, so it fails.
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

describe('lease settings', () => {
  const build = (lease: { ttlMs?: number; waitMs?: number; holder?: string }): AgentHarness =>
    new AgentHarness({
      name: 'lease-options',
      params: {},
      environment: {
        storage: {
          adapter: createInMemoryStorage(SWAP),
          lease,
        },
      },
    });

  it('refuses a lease of no length, of no end, or with no holder', () => {
    for (const lease of [
      {
        ttlMs: 0,
      },
      {
        ttlMs: -1,
      },
      {
        ttlMs: Number.POSITIVE_INFINITY,
      },
      {
        ttlMs: Number.NaN,
      },
      {
        waitMs: -1,
      },
      {
        waitMs: Number.NaN,
      },
      {
        holder: '',
      },
    ]) {
      let code: string | undefined;
      try {
        build(lease);
      } catch (error) {
        assert(error instanceof NoeticConfigError);
        code = error.code;
      }
      expect(code).toBe('INVALID_LEASE_OPTIONS');
    }
  });

  it('takes the smallest lease and no wait at all', () => {
    expect(() =>
      build({
        ttlMs: 1,
        waitMs: 0,
      }),
    ).not.toThrow();
  });
});

describe('aborting a thread that waits for a lease', () => {
  it('ends the wait: the turn is cancelled, not left waiting out the other holder', async () => {
    const storage = createInMemoryStorage(SWAP);
    await storage.set('turn-lease:t', {
      term: 3,
      holder: 'another-harness',
      heldUntil: Date.now() + 6e4,
    });
    const harness = new AgentHarness({
      name: 'lease-abort',
      params: {},
      agentGraph: runCode<ContextData, string, string>({
        id: 'never',
        execute: async () => 'ran',
      }),
      environment: {
        storage: {
          adapter: storage,
          lease: {
            waitMs: 6e4,
          },
        },
      },
    });
    const scope = {
      threadId: 't',
    };
    await harness.execute('go', scope);
    const answer = harness.getAgentResponse(scope).then(
      () => 'answered',
      () => 'failed',
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const started = Date.now();
    await harness.abort(scope);
    expect(await answer).toBe('failed');
    expect(Date.now() - started).toBeLessThan(2e3);
    // The other harness's lease was not touched.
    expect(await storage.get('turn-lease:t')).toMatchObject({
      term: 3,
      holder: 'another-harness',
    });
    await harness.close();
  });
});

describe('a renewal that landed though storage reported a failure', () => {
  it('is not taken for another harness having the lease', async () => {
    const inner = createInMemoryStorage(SWAP);
    let failNext = false;
    const flaky: StorageAdapter = {
      ...inner,
      get: (key) => inner.get(key),
      set: (key, value) => inner.set(key, value),
      delete: (key) => inner.delete(key),
      list: (prefix) => inner.list(prefix),
      swap: async (key, prev, next) => {
        const won = await inner.swap?.(key, prev, next);
        if (failNext) {
          failNext = false;
          // The write is in storage. The answer never reached the caller.
          throw new Error('connection reset');
        }
        return won === true;
      },
    };
    assert(canSwap(flaky));
    const clock: Clock = {
      t: 0,
    };
    const lease = await TurnLease.take(leaseOptions(flaky, 'a', clock), 't');
    let lost: string | undefined;
    lease.keep((reason) => {
      lost = reason;
    });
    clock.t = 10;
    failNext = true;
    await lease.renew();
    // It remembers the old deadline; storage holds the new one, under its name.
    clock.t = 20;
    await lease.renew();
    await lease.release();
    expect(lost).toBeUndefined();
    // And the lease it handed back is free for the next taker.
    expect((await TurnLease.take(leaseOptions(flaky, 'b', clock), 't')).term).toBe(2);
  });
});

describe('the wake time of a turn that is running', () => {
  it('is one lease period ahead, for a host to come back to if the process is gone', async () => {
    const storage = createInMemoryStorage(SWAP);
    let release: (() => void) | undefined;
    const harness = new AgentHarness({
      name: 'watchdog',
      params: {},
      agentGraph: runCode<ContextData, string, string>({
        id: 'slow',
        execute: async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return 'done';
        },
      }),
      environment: {
        storage: {
          adapter: storage,
          lease: {
            ttlMs: 5e3,
          },
        },
      },
    });
    const times: Array<number | undefined> = [];
    harness.onWakeTimeChange((at) => {
      times.push(at);
    });
    const scope = {
      threadId: 't',
    };
    const before = Date.now();
    await harness.execute('go', scope);
    for (let i = 0; i < 500 && release === undefined; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert(release);
    const during = await harness.getNextWakeTime();
    assert(during !== undefined);
    // After the lease has run out, and not long after.
    expect(during).toBeGreaterThanOrEqual(before + 5e3);
    expect(during).toBeLessThanOrEqual(Date.now() + 5e3 + 2e3);
    // The host was told as the turn began, not only when it ends.
    expect(times.some((at) => at !== undefined && at >= before + 5e3)).toBe(true);

    release();
    expect((await harness.getAgentResponse(scope)).text).toBe('done');
    expect(await harness.getNextWakeTime()).toBeUndefined();
    expect(times.at(-1)).toBeUndefined();
    await harness.close();
  });
});
