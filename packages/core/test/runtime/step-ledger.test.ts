// Step-level resume: a restored execution replays the outputs a previous run
// recorded instead of re-running those steps. See specs/23a-step-level-resume.

import { describe, expect, it } from 'bun:test';
import type { StorageAdapter } from '@noetic-tools/context';
import type { Context, ContextData } from '@noetic-tools/types';
import { isNoeticConfigError } from '@noetic-tools/types';
import { inParallel } from '../../src/builders/control-flow-builders';
import { loop } from '../../src/builders/loop-builder';
import { runCode } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createCheckpointStore } from '../../src/runtime/durable/checkpoint-store';
import type { StepLedgerEntry, StepLedgerRetention } from '../../src/runtime/durable/step-ledger';
import {
  createStepLedgerStore,
  DEFAULT_STEP_LEDGER_RETENTION,
  resolveStepLedgerRetention,
  StepLedger,
  stepLedgerPrefix,
} from '../../src/runtime/durable/step-ledger';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { until } from '../../src/until/predicates';

type Storage = ReturnType<typeof createInMemoryStorage>;
type RunStep = ReturnType<typeof runCode<ContextData, string, string>>;

function durableHarness(storage: Storage, retention?: StepLedgerRetention): AgentHarness {
  return new AgentHarness({
    name: 'ledger-test',
    params: {},
    environment: {
      storage: {
        adapter: storage,
        checkpointStore: createCheckpointStore({
          storage,
        }),
        stepLedgerRetention: retention,
      },
    },
  });
}

/** A step that records every dispatch, so a re-run is observable. */
function countingStep(id: string, calls: string[], out: (input: string) => string): RunStep {
  return runCode<ContextData, string, string>({
    id,
    execute: async (input: string) => {
      calls.push(id);
      return out(input);
    },
  });
}

/** Compose children the way the workflow hydrator does — a `run` step that dispatches
 *  each child through the harness. There is no standalone `sequence` builder. */
function sequenceOf(harness: AgentHarness, id: string, children: RunStep[]): RunStep {
  return runCode<ContextData, string, string>({
    id,
    execute: async (input: string, execCtx) => {
      let current = input;
      for (const child of children) {
        current = String(await harness.run(child, current, execCtx));
      }
      return current;
    },
  });
}

/** Narrow a restore result, failing the test loudly when nothing was recorded. */
function mustRestore(ctx: Context | null): Context {
  if (!ctx) {
    throw new Error('expected a restored context');
  }
  return ctx;
}

async function ledgerPaths(storage: Storage, executionId: string): Promise<string[]> {
  return [
    ...(
      await createStepLedgerStore({
        storage,
      }).load(executionId)
    ).entries.keys(),
  ];
}

/** Raw storage keys, so eviction is observed as bytes gone rather than a counter. */
async function ledgerKeys(storage: Storage, executionId: string): Promise<string[]> {
  return (await storage.list(stepLedgerPrefix(executionId))).sort();
}

/** An entry whose JSON output encodes to exactly `bytes` — `"…"` quotes included. */
function entryOfBytes(path: string, bytes: number): StepLedgerEntry {
  return {
    path,
    stepId: path,
    kind: 'runCode',
    output: 'x'.repeat(bytes - 2),
    completedAt: '2026-07-26T00:00:00.000Z',
  };
}

describe('step ledger', () => {
  it('records completed steps so a resumed run replays instead of re-running', async () => {
    const storage = createInMemoryStorage();
    const harness = durableHarness(storage);
    const calls: string[] = [];
    const tree = sequenceOf(harness, 'root', [
      countingStep('first', calls, () => 'a'),
      countingStep('second', calls, (i) => `${i}b`),
    ]);

    const ctx = harness.createContext();
    expect(await harness.run(tree, 'go', ctx)).toBe('ab');
    expect(calls).toEqual([
      'first',
      'second',
    ]);

    const resumed = await harness.restore(ctx.id);
    expect(resumed).not.toBeNull();
    calls.length = 0;

    // Same answer, and neither step was dispatched a second time.
    expect(await harness.run(tree, 'go', mustRestore(resumed))).toBe('ab');
    expect(calls).toEqual([]);
  });

  it('replays the RECORDED output, not a fresh one, for a non-deterministic step', async () => {
    // Why resume is memoization rather than skip: a re-run would produce a different
    // value than the rest of the run already observed.
    const storage = createInMemoryStorage();
    const harness = durableHarness(storage);
    let nth = 0;
    const tree = runCode<ContextData, string, string>({
      id: 'nondet',
      execute: async () => {
        nth += 1;
        return `run-${nth}`;
      },
    });

    const ctx = harness.createContext();
    expect(await harness.run(tree, 'go', ctx)).toBe('run-1');

    const resumed = await harness.restore(ctx.id);
    expect(await harness.run(tree, 'go', mustRestore(resumed))).toBe('run-1');
    expect(nth).toBe(1);
  });

  it('gives each loop iteration its own key, so one cannot replay into another', async () => {
    const storage = createInMemoryStorage();
    const harness = durableHarness(storage);
    const seen: string[] = [];
    const tree = loop<ContextData, string, string>({
      id: 'spin',
      steps: [
        runCode<ContextData, string, string>({
          id: 'body',
          execute: async (input: string) => {
            seen.push(input);
            return `${input}.`;
          },
        }),
      ],
      until: until.maxSteps(3),
    });

    const ctx = harness.createContext();
    await harness.run(tree, '', ctx);

    /* Every dispatch of the SAME step id got its own ledger key. If iterations shared
     * one key the count would collapse to 1 and the second iteration would have
     * replayed the first's output instead of seeing its own input. */
    const bodyPaths = (await ledgerPaths(storage, ctx.id)).filter((p) => p.includes('body'));
    expect(seen.length).toBeGreaterThan(0);
    expect(bodyPaths.length).toBe(seen.length);
    expect(new Set(bodyPaths).size).toBe(seen.length);
    // Each input differs, so no iteration replayed a sibling's recorded output.
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('gives sibling inParallel paths distinct keys', async () => {
    const storage = createInMemoryStorage();
    const harness = durableHarness(storage);
    const tree = inParallel<ContextData, string, string>({
      id: 'fan',
      mode: 'all',
      paths: () => [
        runCode<ContextData, string, string>({
          id: 'leg-a',
          execute: async () => 'x',
        }),
        runCode<ContextData, string, string>({
          id: 'leg-b',
          execute: async () => 'y',
        }),
      ],
      merge: (results: string[]) => results.join(''),
    });

    const ctx = harness.createContext();
    await harness.run(tree, 'go', ctx);

    const legPaths = (await ledgerPaths(storage, ctx.id)).filter((p) => p.includes('leg-'));
    expect(new Set(legPaths).size).toBe(2);
  });

  it('re-runs a step whose identity changed at that path', async () => {
    const storage = createInMemoryStorage();
    const harness = durableHarness(storage);
    const calls: string[] = [];

    const ctx = harness.createContext();
    await harness.run(
      countingStep('alpha', calls, () => 'a'),
      'go',
      ctx,
    );
    expect(calls).toEqual([
      'alpha',
    ]);

    // A different step now occupies that path, so the recorded output no longer applies.
    const resumed = await harness.restore(ctx.id);
    calls.length = 0;
    const edited = countingStep('beta', calls, () => 'b');
    expect(await harness.run(edited, 'go', mustRestore(resumed))).toBe('b');
    expect(calls).toEqual([
      'beta',
    ]);
  });

  it('replays a completed parent wholesale, without revisiting its children', async () => {
    /* The ledger replays at the coarsest COMPLETED granularity. A composite step is
     * an ordinary `run` step here (that is how the hydrator builds `sequence`), so a
     * parent that finished records the whole subtree's output and a resumed run never
     * descends into it. Efficient for a true resume; it also means editing a child
     * under an unchanged parent has no effect, so a host that changed the workflow
     * must clear the ledger rather than resume onto it. */
    const storage = createInMemoryStorage();
    const harness = durableHarness(storage);
    const calls: string[] = [];

    const ctx = harness.createContext();
    const original = sequenceOf(harness, 'root', [
      countingStep('alpha', calls, () => 'a'),
    ]);
    await harness.run(original, 'go', ctx);

    const resumed = await harness.restore(ctx.id);
    calls.length = 0;
    const editedChild = sequenceOf(harness, 'root', [
      countingStep('beta', calls, () => 'b'),
    ]);

    expect(await harness.run(editedChild, 'go', mustRestore(resumed))).toBe('a');
    expect(calls).toEqual([]);
  });

  it('records nothing when the harness has no checkpoint store', async () => {
    const storage = createInMemoryStorage();
    const harness = new AgentHarness({
      name: 'ephemeral',
      params: {},
      environment: {
        storage: {
          adapter: storage,
        },
      },
    });
    const calls: string[] = [];

    const ctx = harness.createContext();
    await harness.run(
      countingStep('only', calls, () => 'a'),
      'go',
      ctx,
    );

    expect(await ledgerPaths(storage, ctx.id)).toEqual([]);
    expect(await harness.restore(ctx.id)).toBeNull();
  });

  it('does not record a failed step, so a resumed run dispatches it again', async () => {
    const storage = createInMemoryStorage();
    const harness = durableHarness(storage);
    let attempts = 0;
    const tree = runCode<ContextData, string, string>({
      id: 'flaky',
      execute: async () => {
        attempts += 1;
        throw new Error('boom');
      },
    });

    const ctx = harness.createContext();
    await expect(harness.run(tree, 'go', ctx)).rejects.toThrow();

    expect((await ledgerPaths(storage, ctx.id)).filter((p) => p.includes('flaky'))).toEqual([]);
    expect(attempts).toBe(1);
  });
});

// Retention: sharding made an append O(1) but left the TOTAL unbounded. Both caps
// degrade resume rather than break it — an entry that is missing for any reason simply
// re-runs its step. See specs/23a-step-level-resume § "Size and retention".
describe('step ledger retention config', () => {
  it('defaults both caps when nothing is configured', () => {
    expect(resolveStepLedgerRetention()).toEqual({
      maxEntryBytes: DEFAULT_STEP_LEDGER_RETENTION.maxEntryBytes,
      maxEntries: DEFAULT_STEP_LEDGER_RETENTION.maxEntries,
    });
  });

  it('keeps the default for the axis that was not overridden', () => {
    expect(
      resolveStepLedgerRetention({
        maxEntries: 7,
      }),
    ).toEqual({
      maxEntryBytes: DEFAULT_STEP_LEDGER_RETENTION.maxEntryBytes,
      maxEntries: 7,
    });
  });

  it('accepts Infinity as "no cap"', () => {
    expect(
      resolveStepLedgerRetention({
        maxEntries: Number.POSITIVE_INFINITY,
        maxEntryBytes: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({
      maxEntryBytes: Number.POSITIVE_INFINITY,
      maxEntries: Number.POSITIVE_INFINITY,
    });
  });

  /* A silently-wrong cap would drop every entry while the run still looked healthy,
   * so each of these is a loud config error rather than a clamp. */
  const badCaps: ReadonlyArray<
    [
      string,
      StepLedgerRetention,
    ]
  > = [
    [
      'zero entries',
      {
        maxEntries: 0,
      },
    ],
    [
      'negative entries',
      {
        maxEntries: -1,
      },
    ],
    [
      'zero bytes',
      {
        maxEntryBytes: 0,
      },
    ],
    [
      'NaN bytes',
      {
        maxEntryBytes: Number.NaN,
      },
    ],
    [
      '-Infinity bytes',
      {
        maxEntryBytes: Number.NEGATIVE_INFINITY,
      },
    ],
  ];
  for (const [label, retention] of badCaps) {
    it(`rejects ${label} with STEP_LEDGER_RETENTION_INVALID`, () => {
      try {
        resolveStepLedgerRetention(retention);
        throw new Error('expected a config error');
      } catch (e) {
        if (!isNoeticConfigError(e)) {
          throw e;
        }
        expect(e.code).toBe('STEP_LEDGER_RETENTION_INVALID');
        expect(e.hint.length).toBeGreaterThan(0);
      }
    });
  }

  it('validates at harness construction, not at first record', () => {
    const storage = createInMemoryStorage();
    expect(() =>
      durableHarness(storage, {
        maxEntries: -5,
      }),
    ).toThrow('stepLedgerRetention.maxEntries');
  });

  it('boundary: an entry at the byte cap is recorded, one byte over is not', async () => {
    const storage = createInMemoryStorage();
    const store = createStepLedgerStore({
      storage,
    });
    const ledger = new StepLedger({
      executionId: 'exec',
      store,
      retention: {
        maxEntryBytes: 32,
      },
    });

    await ledger.record(entryOfBytes('under', 31));
    await ledger.record(entryOfBytes('at-cap', 32));
    await ledger.record(entryOfBytes('over', 33));

    expect([
      ...(await store.load('exec')).entries.keys(),
    ]).toEqual([
      'under',
      'at-cap',
    ]);
    expect(ledger.stats.recorded).toBe(2);
    expect(ledger.stats.droppedOversize).toBe(1);
  });

  it('measures UTF-8 bytes, not code units', async () => {
    // 'é' is one UTF-16 code unit but two UTF-8 bytes: 5 of them plus the JSON
    // quotes is exactly 12 bytes, and a 6th pushes it to 14.
    const storage = createInMemoryStorage();
    const store = createStepLedgerStore({
      storage,
    });
    const ledger = new StepLedger({
      executionId: 'exec',
      store,
      retention: {
        maxEntryBytes: 12,
      },
    });

    await ledger.record({
      path: 'fits',
      stepId: 'fits',
      kind: 'runCode',
      output: 'é'.repeat(5),
      completedAt: '2026-07-26T00:00:00.000Z',
    });
    await ledger.record({
      path: 'over',
      stepId: 'over',
      kind: 'runCode',
      output: 'é'.repeat(6),
      completedAt: '2026-07-26T00:00:00.000Z',
    });

    expect([
      ...(await store.load('exec')).entries.keys(),
    ]).toEqual([
      'fits',
    ]);
  });

  it('records an undefined output, which has no size to bound', async () => {
    const storage = createInMemoryStorage();
    const store = createStepLedgerStore({
      storage,
    });
    const ledger = new StepLedger({
      executionId: 'exec',
      store,
      retention: {
        maxEntryBytes: 1,
      },
    });

    await ledger.record({
      path: 'void',
      stepId: 'void',
      kind: 'runCode',
      output: undefined,
      completedAt: '2026-07-26T00:00:00.000Z',
    });

    expect(ledger.stats.recorded).toBe(1);
    expect(ledger.stats.droppedOversize).toBe(0);
  });

  it('does not record an output that cannot be JSON-encoded', async () => {
    const storage = createInMemoryStorage();
    const store = createStepLedgerStore({
      storage,
    });
    const ledger = new StepLedger({
      executionId: 'exec',
      store,
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await ledger.record({
      path: 'cyclic',
      stepId: 'cyclic',
      kind: 'runCode',
      output: circular,
      completedAt: '2026-07-26T00:00:00.000Z',
    });

    expect(await ledgerKeys(storage, 'exec')).toEqual([]);
    expect(ledger.stats.droppedUnserialisable).toBe(1);
  });

  it('boundary: evicts oldest-first only once the entry cap is exceeded', async () => {
    const storage = createInMemoryStorage();
    const store = createStepLedgerStore({
      storage,
    });
    const ledger = new StepLedger({
      executionId: 'exec',
      store,
      retention: {
        maxEntries: 3,
      },
    });

    await ledger.record(entryOfBytes('a', 4));
    await ledger.record(entryOfBytes('b', 4));
    expect(ledger.stats.evicted).toBe(0);

    await ledger.record(entryOfBytes('c', 4));
    expect(ledger.stats.evicted).toBe(0); // at the cap — nothing to evict yet

    await ledger.record(entryOfBytes('d', 4));
    expect(ledger.stats.evicted).toBe(1); // one over — the oldest goes

    const retained = [
      ...(await store.load('exec')).entries.keys(),
    ];
    expect(retained).toEqual([
      'b',
      'c',
      'd',
    ]);
    expect(await ledgerKeys(storage, 'exec')).toHaveLength(3);
  });

  it('a storage-outage burst of failed appends never evicts live entries (D3)', async () => {
    const storage = createInMemoryStorage();
    const store = createStepLedgerStore({
      storage,
    });
    let failing = false;
    const flaky: typeof store = {
      ...store,
      append: async (executionId, seq, entry) => {
        if (failing) {
          throw new Error('storage outage');
        }
        return store.append(executionId, seq, entry);
      },
    };
    const ledger = new StepLedger({
      executionId: 'exec',
      store: flaky,
      retention: {
        maxEntries: 5,
      },
    });

    for (let i = 0; i < 5; i++) {
      await ledger.record(entryOfBytes(`live-${i}`, 8));
    }
    failing = true;
    for (let i = 0; i < 10; i++) {
      await ledger.record(entryOfBytes(`lost-${i}`, 8));
    }
    failing = false;

    expect(await ledgerKeys(storage, 'exec')).toHaveLength(5);
    expect(ledger.stats.evicted).toBe(0);

    await ledger.record(entryOfBytes('live-5', 8));
    const retained = [
      ...(await store.load('exec')).entries.keys(),
    ];
    expect(retained).toHaveLength(5);
    expect(retained).not.toContain('live-0');
    expect(retained).toContain('live-5');
    expect(ledger.stats.evicted).toBe(1);
  });

  it('gives concurrent records distinct keys', async () => {
    /* Fork legs record through the one shared ledger while in flight together. If the
     * sequence number were read after an await they would land on the same key and one
     * leg's entry would vanish. */
    const storage = createInMemoryStorage();
    const store = createStepLedgerStore({
      storage,
    });
    const ledger = new StepLedger({
      executionId: 'exec',
      store,
    });

    await Promise.all([
      ledger.record(entryOfBytes('leg-a', 8)),
      ledger.record(entryOfBytes('leg-b', 8)),
      ledger.record(entryOfBytes('leg-c', 8)),
    ]);

    expect(await ledgerKeys(storage, 'exec')).toHaveLength(3);
    expect((await store.load('exec')).entries.size).toBe(3);
  });

  it('never reuses a sequence number after a resume, so no live entry is overwritten', async () => {
    /* `nextSeq` has to come from storage: deriving it from the recovered entry COUNT
     * would restart inside the live window whenever retention left a gap, and the first
     * new append would overwrite an entry the resumed run still has to replay. */
    const storage = createInMemoryStorage();
    const store = createStepLedgerStore({
      storage,
    });
    const first = new StepLedger({
      executionId: 'exec',
      store,
      retention: {
        maxEntries: 2,
      },
    });
    await first.record(entryOfBytes('a', 4));
    await first.record(entryOfBytes('b', 4));
    await first.record(entryOfBytes('c', 4)); // evicts 'a'

    const resumed = new StepLedger({
      executionId: 'exec',
      store,
      recovered: await store.load('exec'),
      retention: {
        maxEntries: 2,
      },
    });
    await resumed.record(entryOfBytes('d', 4));

    // 'd' landed on a fresh key and evicted 'b' rather than clobbering it.
    expect([
      ...(await store.load('exec')).entries.keys(),
    ]).toEqual([
      'c',
      'd',
    ]);
  });
});

describe('step ledger retention through the harness', () => {
  it('resumes over a bounded suffix: evicted steps re-run, retained ones replay', async () => {
    const storage = createInMemoryStorage();
    const harness = durableHarness(storage, {
      maxEntries: 3,
    });
    const calls: string[] = [];
    const steps = [
      1,
      2,
      3,
      4,
      5,
    ].map((n) => countingStep(`s${n}`, calls, () => `out-${n}`));

    // A host driving steps itself: five top-level dispatches on one context, so no
    // parent entry can replay the whole tree and mask eviction.
    const ctx = harness.createContext();
    for (const s of steps) {
      await harness.run(s, 'go', ctx);
    }
    expect(calls).toHaveLength(5);
    expect(await ledgerKeys(storage, ctx.id)).toHaveLength(3);

    const resumed = mustRestore(await harness.restore(ctx.id));
    calls.length = 0;
    const outputs: string[] = [];
    for (const s of steps) {
      outputs.push(String(await harness.run(s, 'go', resumed)));
    }

    // The two oldest entries were evicted, so those steps ran again; the retained
    // suffix replayed. Every output still matches the original run.
    expect(calls).toEqual([
      's1',
      's2',
    ]);
    expect(outputs).toEqual([
      'out-1',
      'out-2',
      'out-3',
      'out-4',
      'out-5',
    ]);
  });

  it('re-runs a step whose output was too large to record', async () => {
    const storage = createInMemoryStorage();
    const harness = durableHarness(storage, {
      maxEntryBytes: 64,
    });
    const calls: string[] = [];
    const small = countingStep('small', calls, () => 'ok');
    const big = countingStep('big', calls, () => 'z'.repeat(1e3));

    const ctx = harness.createContext();
    await harness.run(small, 'go', ctx);
    await harness.run(big, 'go', ctx);
    expect((await ledgerPaths(storage, ctx.id)).some((p) => p.includes('big'))).toBe(false);

    const resumed = mustRestore(await harness.restore(ctx.id));
    calls.length = 0;
    await harness.run(small, 'go', resumed);
    const replayed = await harness.run(big, 'go', resumed);

    expect(calls).toEqual([
      'big',
    ]);
    expect(replayed).toBe('z'.repeat(1e3));
  });

  it('clearCheckpoint drops the snapshot and every ledger shard', async () => {
    /* The story for "the workflow changed, do not resume onto this": clearing the
     * snapshot alone would strand the ledger's per-step keys, since nothing else
     * enumerates them. */
    const storage = createInMemoryStorage();
    const harness = durableHarness(storage);
    const calls: string[] = [];

    const ctx = harness.createContext();
    await harness.run(
      countingStep('alpha', calls, () => 'a'),
      'go',
      ctx,
    );
    expect(await ledgerKeys(storage, ctx.id)).not.toEqual([]);

    await harness.clearCheckpoint(ctx.id);

    expect(await ledgerKeys(storage, ctx.id)).toEqual([]);
    expect(await harness.restore(ctx.id)).toBeNull();
  });
});

// ── load(): batch read (issue #58) ───────────────────────────────────
//
// `load()` lists the ledger prefix and then reads every key. Reading them one
// await at a time is an N+1 on the recovery path — the moment a D1- or
// network-backed adapter can least afford a burst of round trips. It must go
// through `storageGetMany`, which uses the adapter's batch read when there is
// one and sweeps `get` in parallel when there is not.

interface LedgerStorageSpy {
  storage: StorageAdapter;
  getCalls: string[];
  getManyCalls: string[][];
}

/** Wrap an in-memory adapter, counting reads. `withGetMany: false` hides the
 *  batch read, standing in for an adapter published before it existed. */
function spyOn(inner: Storage, withGetMany: boolean): LedgerStorageSpy {
  const getCalls: string[] = [];
  const getManyCalls: string[][] = [];
  const base: StorageAdapter = {
    get: async <T>(key: string): Promise<T | null> => {
      getCalls.push(key);
      return inner.get<T>(key);
    },
    set: (key, value) => inner.set(key, value),
    delete: (key) => inner.delete(key),
    list: (prefix) => inner.list(prefix),
  };
  if (!withGetMany) {
    return {
      storage: base,
      getCalls,
      getManyCalls,
    };
  }
  return {
    storage: {
      ...base,
      getMany: async <T>(keys: string[]): Promise<Map<string, T>> => {
        getManyCalls.push([
          ...keys,
        ]);
        const found = new Map<string, T>();
        for (const key of keys) {
          const value = await inner.get<T>(key);
          if (value === null) {
            continue;
          }
          found.set(key, value);
        }
        return found;
      },
    },
    getCalls,
    getManyCalls,
  };
}

function entryAt(path: string, stepId: string, output: string): StepLedgerEntry {
  return {
    path,
    stepId,
    kind: 'runCode',
    output,
    completedAt: '2026-01-01T00:00:00.000Z',
  };
}

async function seedLedger(
  storage: StorageAdapter,
  executionId: string,
  count: number,
): Promise<void> {
  const store = createStepLedgerStore({
    storage,
  });
  for (let seq = 0; seq < count; seq++) {
    await store.append(executionId, seq, entryAt(`/root/${seq}`, `step-${seq}`, `out-${seq}`));
  }
}

describe('step ledger load', () => {
  it('reads the whole ledger in one batch when the adapter supports it', async () => {
    const inner = createInMemoryStorage();
    await seedLedger(inner, 'exec-batch', 5);
    const spy = spyOn(inner, true);

    const loaded = await createStepLedgerStore({
      storage: spy.storage,
    }).load('exec-batch');

    expect(loaded.entries.size).toBe(5);
    expect(spy.getManyCalls.length).toBe(1);
    expect(spy.getManyCalls[0].length).toBe(5);
    expect(spy.getCalls).toEqual([]);
  });

  it('falls back to per-key reads on an adapter with no batch read', async () => {
    const inner = createInMemoryStorage();
    await seedLedger(inner, 'exec-fallback', 3);
    const spy = spyOn(inner, false);

    const loaded = await createStepLedgerStore({
      storage: spy.storage,
    }).load('exec-fallback');

    expect(loaded.entries.size).toBe(3);
    expect(spy.getCalls.length).toBe(3);
    expect(spy.getManyCalls).toEqual([]);
    expect(loaded.entries.get('/root/1')?.output).toBe('out-1');
  });

  it('recovers identical entries through either path', async () => {
    const inner = createInMemoryStorage();
    await seedLedger(inner, 'exec-parity', 4);

    const viaBatch = await createStepLedgerStore({
      storage: spyOn(inner, true).storage,
    }).load('exec-parity');
    const viaFallback = await createStepLedgerStore({
      storage: spyOn(inner, false).storage,
    }).load('exec-parity');

    expect([
      ...viaBatch.entries.keys(),
    ]).toEqual([
      ...viaFallback.entries.keys(),
    ]);
    expect([
      ...viaBatch.entries.values(),
    ]).toEqual([
      ...viaFallback.entries.values(),
    ]);
  });

  it('keeps the last entry recorded at a path, so dispatch order survives batching', async () => {
    const inner = createInMemoryStorage();
    const store = createStepLedgerStore({
      storage: inner,
    });
    // Same path, recorded twice — a loop body re-entering the same slot. The
    // later sequence number must win, which only holds if `load` walks the keys
    // in `list()` order rather than whatever order the batch read returns.
    await store.append('exec-order', 0, entryAt('/root/body', 'body', 'first'));
    await store.append('exec-order', 1, entryAt('/root/body', 'body', 'second'));

    // A batch read returns a map, and nothing in the contract says its iteration
    // order matches the key order asked for — a real backend may return rows in
    // whatever order the query produced. Reverse it here so a `load` that walked
    // the map instead of the keys would recover 'first' and fail.
    const reversing: StorageAdapter = {
      ...inner,
      getMany: async <T>(keys: string[]): Promise<Map<string, T>> => {
        const found = new Map<string, T>();
        for (const key of [
          ...keys,
        ].reverse()) {
          const value = await inner.get<T>(key);
          if (value === null) {
            continue;
          }
          found.set(key, value);
        }
        return found;
      },
    };

    const loaded = await createStepLedgerStore({
      storage: reversing,
    }).load('exec-order');

    expect(loaded.entries.size).toBe(1);
    expect(loaded.entries.get('/root/body')?.output).toBe('second');
  });

  it('still skips a corrupt row that arrives through the batch read', async () => {
    const inner = createInMemoryStorage();
    await seedLedger(inner, 'exec-corrupt', 2);
    await inner.set(`${stepLedgerPrefix('exec-corrupt')}00000009`, {
      path: '',
      nonsense: true,
    });

    const loaded = await createStepLedgerStore({
      storage: spyOn(inner, true).storage,
    }).load('exec-corrupt');

    expect(loaded.entries.size).toBe(2);
    expect(loaded.entries.has('')).toBe(false);
  });
});
