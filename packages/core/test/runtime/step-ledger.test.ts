// Step-level resume: a restored execution replays the outputs a previous run
// recorded instead of re-running those steps. See specs/23a-step-level-resume.

import { describe, expect, it } from 'bun:test';
import type { StorageAdapter } from '@noetic-tools/context';
import type { Context, ContextData } from '@noetic-tools/types';
import { isNoeticConfigError } from '@noetic-tools/types';
import { inParallel } from '../../src/builders/control-flow-builders';
import { schedule } from '../../src/builders/every';
import { loop } from '../../src/builders/loop-builder';
import { runCode } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { resolveLedgerKey } from '../../src/interpreter/execute';
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
import { runThenCrash } from '../_helpers';

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
    expect(await runThenCrash(harness, tree, 'go', ctx)).toBe('ab');
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
    expect(await runThenCrash(harness, tree, 'go', ctx)).toBe('run-1');

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
      // A loop that records prunes its body's entries; keep them to inspect.
      durable: false,
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
    await runThenCrash(harness, tree, '', ctx);

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
      // A fan-out that records prunes its legs' entries; keep them to inspect.
      durable: false,
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
    await runThenCrash(harness, tree, 'go', ctx);

    const legPaths = (await ledgerPaths(storage, ctx.id)).filter((p) => p.includes('leg-'));
    expect(new Set(legPaths).size).toBe(2);
  });

  it('re-runs a step whose identity changed at that path', async () => {
    const storage = createInMemoryStorage();
    const harness = durableHarness(storage);
    const calls: string[] = [];

    const ctx = harness.createContext();
    await runThenCrash(
      harness,
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
    await runThenCrash(harness, original, 'go', ctx);

    const resumed = await harness.restore(ctx.id);
    calls.length = 0;
    const editedChild = sequenceOf(harness, 'root', [
      countingStep('beta', calls, () => 'b'),
    ]);

    expect(await harness.run(editedChild, 'go', mustRestore(resumed))).toBe('a');
    expect(calls).toEqual([]);
  });

  it('records nothing when the harness opts out of checkpoints', async () => {
    const storage = createInMemoryStorage();
    const harness = new AgentHarness({
      name: 'ephemeral',
      params: {},
      durability: false,
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

  it('boundary: stops recording once the entry cap is reached', async () => {
    /* A resume walks the run from the top, so the head of the ledger is what it reads
     * first. Keeping the head and dropping what comes after keeps every replayed value
     * consistent with the ones before it. */
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
    await ledger.record(entryOfBytes('c', 4));
    expect(ledger.stats.droppedFull).toBe(0); // at the cap — nothing dropped yet

    await ledger.record(entryOfBytes('d', 4));
    expect(ledger.stats.droppedFull).toBe(1); // one past — not recorded

    expect([
      ...(await store.load('exec')).entries.keys(),
    ]).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(await ledgerKeys(storage, 'exec')).toHaveLength(3);
  });

  it('prunes entries beneath a parent once the parent records', async () => {
    const storage = createInMemoryStorage();
    const store = createStepLedgerStore({
      storage,
    });
    const ledger = new StepLedger({
      executionId: 'exec',
      store,
      retention: {
        maxEntries: 2,
      },
    });

    await ledger.record(entryOfBytes('/p#0/x#0', 4));
    await ledger.record(entryOfBytes('/p#0[0]/y#0', 4));
    await ledger.record(entryOfBytes('/p#0', 4));
    // Both children are gone, so the parent fits under a cap of two with room to spare.
    await ledger.record(entryOfBytes('/q#0', 4));

    expect(ledger.stats.pruned).toBe(2);
    expect(ledger.stats.droppedFull).toBe(0);
    expect([
      ...(await store.load('exec')).entries.keys(),
    ]).toEqual([
      '/p#0',
      '/q#0',
    ]);
  });

  it('counts a path once when a later record replaces its entry', async () => {
    const storage = createInMemoryStorage();
    const store = createStepLedgerStore({
      storage,
    });
    const ledger = new StepLedger({
      executionId: 'exec',
      store,
    });

    await ledger.record(entryOfBytes('/p#0', 4));
    await ledger.record(entryOfBytes('/p#0', 8));
    await ledger.record(entryOfBytes('/q#0', 4));

    expect(ledger.stats.recorded).toBe(2);
    expect(await ledgerKeys(storage, 'exec')).toHaveLength(2);
  });

  it('drops the entry at one path and leaves the rest', async () => {
    const storage = createInMemoryStorage();
    const store = createStepLedgerStore({
      storage,
    });
    const ledger = new StepLedger({
      executionId: 'exec',
      store,
    });

    await ledger.record(entryOfBytes('/p#0', 4));
    await ledger.record(entryOfBytes('/q#0', 4));
    await ledger.drop('/p#0');
    // A path with no entry is a no-op.
    await ledger.drop('/r#0');

    expect(ledger.stats.pruned).toBe(1);
    expect([
      ...(await store.load('exec')).entries.keys(),
    ]).toEqual([
      '/q#0',
    ]);
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
     * would restart inside the live window whenever pruning left a gap, and the first
     * new append would overwrite an entry the resumed run still has to replay. */
    const storage = createInMemoryStorage();
    const store = createStepLedgerStore({
      storage,
    });
    const first = new StepLedger({
      executionId: 'exec',
      store,
    });
    await first.record(entryOfBytes('/p#0/x#0', 4));
    await first.record(entryOfBytes('/p#0', 4)); // prunes seq 0, leaving a gap
    await first.record(entryOfBytes('/q#0', 4));

    const resumed = new StepLedger({
      executionId: 'exec',
      store,
      recovered: await store.load('exec'),
    });
    await resumed.record(entryOfBytes('/r#0', 4));

    // '/r#0' landed on a fresh key rather than clobbering '/p#0' or '/q#0'.
    expect([
      ...(await store.load('exec')).entries.keys(),
    ]).toEqual([
      '/p#0',
      '/q#0',
      '/r#0',
    ]);
  });
});

describe('step ledger retention through the harness', () => {
  it('resumes over a bounded head: recorded steps replay, the rest re-run', async () => {
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
    // Not durable, so no parent entry can replay the whole tree and mask the cap.
    const tree = {
      ...sequenceOf(harness, 'root', steps),
      durable: false,
    };

    const ctx = harness.createContext();
    await runThenCrash(harness, tree, 'go', ctx);
    expect(calls).toHaveLength(5);
    expect(await ledgerKeys(storage, ctx.id)).toHaveLength(3);

    const resumed = mustRestore(await harness.restore(ctx.id));
    calls.length = 0;
    const output = await harness.run(tree, 'go', resumed);

    // The cap held the first three, so only the last two ran again — and the
    // output still matches the original run.
    expect(calls).toEqual([
      's4',
      's5',
    ]);
    expect(output).toBe('out-5');
  });

  it('re-runs a step whose output was too large to record', async () => {
    const storage = createInMemoryStorage();
    const harness = durableHarness(storage, {
      maxEntryBytes: 64,
    });
    const calls: string[] = [];
    const small = countingStep('small', calls, () => 'ok');
    const big = countingStep('big', calls, () => 'z'.repeat(1e3));
    const tree = {
      ...sequenceOf(harness, 'root', [
        small,
        big,
      ]),
      durable: false,
    };

    const ctx = harness.createContext();
    await runThenCrash(harness, tree, 'go', ctx);
    expect((await ledgerPaths(storage, ctx.id)).some((p) => p.includes('big'))).toBe(false);

    const resumed = mustRestore(await harness.restore(ctx.id));
    calls.length = 0;
    const replayed = await harness.run(tree, 'go', resumed);

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
    await runThenCrash(
      harness,
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

// Replay identity (spec 23a § Identity): `durable: false` opts a step out of the
// ledger, and `replayKey` swaps its positional path for a content key.
describe('step replay controls', () => {
  it('durable: false writes no entry and re-runs on resume, re-applying its state change', async () => {
    const storage = createInMemoryStorage();
    const harness = durableHarness(storage);
    const state = new Map<string, number>();
    let runs = 0;
    const tree = runCode<ContextData, string, void>({
      id: 'tally-orchestrator',
      durable: false,
      execute: async () => {
        runs += 1;
        state.set('tally', (state.get('tally') ?? 0) + 1);
      },
    });

    const ctx = harness.createContext();
    await harness.run(tree, 'go', ctx);
    expect(await ledgerPaths(storage, ctx.id)).toEqual([]);

    state.clear();
    const resumed = mustRestore(await harness.restore(ctx.id));
    await harness.run(tree, 'go', resumed);
    expect(runs).toBe(2);
    // A replayed `undefined` would have skipped this; the re-run applied it again.
    expect(state.get('tally')).toBe(1);
  });

  it('still replays a durable child under a non-durable parent', async () => {
    const storage = createInMemoryStorage();
    const harness = durableHarness(storage);
    const calls: string[] = [];
    const child = countingStep('expensive-leaf', calls, (i) => `${i}!`);
    let parentRuns = 0;
    const parent = runCode<ContextData, string, string>({
      id: 'cheap-parent',
      durable: false,
      execute: async (input: string, execCtx) => {
        parentRuns += 1;
        return String(await harness.run(child, input, execCtx));
      },
    });

    const ctx = harness.createContext();
    expect(await runThenCrash(harness, parent, 'go', ctx)).toBe('go!');
    const paths = await ledgerPaths(storage, ctx.id);
    expect(paths.some((p) => p.includes('expensive-leaf'))).toBe(true);
    expect(paths.some((p) => p.endsWith('cheap-parent#0'))).toBe(false);

    calls.length = 0;
    const resumed = mustRestore(await harness.restore(ctx.id));
    expect(await harness.run(parent, 'go', resumed)).toBe('go!');
    expect(parentRuns).toBe(2);
    expect(calls).toEqual([]);
  });

  it('replayKey hands each worker its own batch output when batches swap between runs', async () => {
    const storage = createInMemoryStorage();
    const harness = durableHarness(storage);
    const calls: string[] = [];
    let queue: string[] = [];
    const leaf = runCode<ContextData, string, string>({
      id: 'grade-batch',
      replayKey: (batch: string) => `grade:${batch}`,
      execute: async (batch: string) => {
        calls.push(batch);
        return `answer-${batch}`;
      },
    });
    const worker = (id: string): RunStep =>
      runCode<ContextData, string, string>({
        id,
        durable: false,
        execute: async (_input: string, execCtx) => {
          const batch = queue.shift();
          if (batch === undefined) {
            throw new Error('queue drained');
          }
          return `${batch}=${String(await harness.run(leaf, batch, execCtx))}`;
        },
      });
    const pool = inParallel<ContextData, string, string>({
      id: 'worker-pool',
      mode: 'all',
      durable: false,
      paths: () => [
        worker('worker-a'),
        worker('worker-b'),
      ],
      merge: (results: string[]) => results.join(','),
    });

    const ctx = harness.createContext();
    queue = [
      'b1',
      'b2',
    ];
    expect(await harness.run(pool, 'go', ctx)).toBe('b1=answer-b1,b2=answer-b2');
    expect(calls.sort()).toEqual([
      'b1',
      'b2',
    ]);

    // Worker A now picks b2 and worker B picks b1: positional replay would swap answers.
    calls.length = 0;
    queue = [
      'b2',
      'b1',
    ];
    const resumed = mustRestore(await harness.restore(ctx.id));
    expect(await harness.run(pool, 'go', resumed)).toBe('b2=answer-b2,b1=answer-b1');
    expect(calls).toEqual([]);
  });

  it('runs fresh when a different step id or kind reuses a replay key', async () => {
    const storage = createInMemoryStorage();
    const harness = durableHarness(storage);
    const calls: string[] = [];
    const keyed = (id: string, out: string): RunStep =>
      runCode<ContextData, string, string>({
        id,
        replayKey: () => 'shared-key',
        execute: async () => {
          calls.push(id);
          return out;
        },
      });

    const ctx = harness.createContext();
    await harness.run(keyed('keyed-original', 'old'), 'go', ctx);
    expect(await ledgerPaths(storage, ctx.id)).toContain('key:shared-key');

    calls.length = 0;
    const resumed = mustRestore(await harness.restore(ctx.id));
    expect(await harness.run(keyed('keyed-renamed', 'new'), 'go', resumed)).toBe('new');
    expect(calls).toEqual([
      'keyed-renamed',
    ]);
  });

  it('skips the ledger, without failing the step, when replayKey throws', async () => {
    const storage = createInMemoryStorage();
    const harness = durableHarness(storage);
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args);
    };
    let runs = 0;
    const tree = runCode<ContextData, string, string>({
      id: 'bad-key',
      replayKey: () => {
        throw new Error('no key for you');
      },
      execute: async () => {
        runs += 1;
        return `run-${runs}`;
      },
    });

    try {
      const ctx = harness.createContext();
      expect(await harness.run(tree, 'go', ctx)).toBe('run-1');
      expect(await ledgerPaths(storage, ctx.id)).toEqual([]);
      expect(warnings.some((w) => String(w[0]).includes('bad-key'))).toBe(true);

      const resumed = mustRestore(await harness.restore(ctx.id));
      expect(await harness.run(tree, 'go', resumed)).toBe('run-2');
    } finally {
      console.warn = originalWarn;
    }
  });

  it('resolves the ledger key: path by default, key: for replayKey, none for opt-outs', () => {
    const harness = durableHarness(createInMemoryStorage());
    const ctx = harness.createContext();
    const body = countingStep('tick-body', [], (i) => i);

    expect(resolveLedgerKey(body, 'x', ctx)).toBe('');
    expect(
      resolveLedgerKey(
        runCode<ContextData, string, string>({
          id: 'content-keyed',
          replayKey: (input: string) => `in:${input}`,
          execute: async (i: string) => i,
        }),
        'x',
        ctx,
      ),
    ).toBe('key:in:x');
    expect(
      resolveLedgerKey(
        runCode<ContextData, string, string>({
          id: 'opted-out',
          durable: false,
          replayKey: () => 'ignored',
          execute: async (i: string) => i,
        }),
        'x',
        ctx,
      ),
    ).toBeUndefined();
    // A schedule never completes, so it is never recorded — even when asked to be.
    expect(
      resolveLedgerKey(
        schedule<ContextData, string, string>({
          id: 'ticker',
          step: body,
          interval: 1e3,
          durable: true,
        }),
        'x',
        ctx,
      ),
    ).toBeUndefined();
  });

  it('resolves no key on a harness without a ledger, so replayKey is never called', () => {
    const harness = new AgentHarness({
      name: 'no-ledger',
      params: {},
    });
    let called = false;
    const step = runCode<ContextData, string, string>({
      id: 'uncalled-key',
      replayKey: () => {
        called = true;
        return 'k';
      },
      execute: async (i: string) => i,
    });
    expect(resolveLedgerKey(step, 'x', harness.createContext())).toBeUndefined();
    expect(called).toBe(false);
  });

  it('discards only a diverging key: entry, not entries that share its prefix', () => {
    const entry = (path: string, stepId: string): StepLedgerEntry => ({
      path,
      stepId,
      kind: 'runCode',
      output: stepId,
      completedAt: '2026-10-24T00:00:00.000Z',
    });
    const ledger = new StepLedger({
      executionId: 'keyed',
      recovered: {
        entries: new Map([
          [
            'key:batch',
            entry('key:batch', 'leaf'),
          ],
          [
            'key:batch/1',
            entry('key:batch/1', 'other'),
          ],
        ]),
        seqs: new Map([
          [
            'key:batch',
            0,
          ],
          [
            'key:batch/1',
            1,
          ],
        ]),
        nextSeq: 2,
      },
    });

    expect(
      ledger.take('key:batch', {
        id: 'renamed',
        kind: 'runCode',
        inputHash: undefined,
      }),
    ).toBeUndefined();
    expect(
      ledger.take('key:batch', {
        id: 'leaf',
        kind: 'runCode',
        inputHash: undefined,
      }),
    ).toBeUndefined();
    expect(
      ledger.take('key:batch/1', {
        id: 'other',
        kind: 'runCode',
        inputHash: undefined,
      })?.output,
    ).toBe('other');
  });
});
