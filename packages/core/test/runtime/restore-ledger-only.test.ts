// A restore needs a snapshot or a ledger, not both: with only ledger entries it
// replays what was recorded and runs the rest fresh. See specs/23a-step-level-resume.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import assert from 'node:assert';
import type { Context, ContextData } from '@noetic-tools/types';
import { isNoeticConfigError } from '@noetic-tools/types';
import { runCode } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import type { CheckpointStore } from '../../src/runtime/durable/checkpoint-store';
import { CheckpointKeys, createCheckpointStore } from '../../src/runtime/durable/checkpoint-store';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';

type Storage = ReturnType<typeof createInMemoryStorage>;
type RunStep = ReturnType<typeof runCode<ContextData, string, string>>;

function harnessWith(storage: Storage, checkpointStore: CheckpointStore): AgentHarness {
  return new AgentHarness({
    name: 'ledger-only',
    params: {},
    environment: {
      storage: {
        adapter: storage,
        checkpointStore,
      },
    },
  });
}

function durableHarness(storage: Storage): AgentHarness {
  return harnessWith(
    storage,
    createCheckpointStore({
      storage,
    }),
  );
}

/** Every snapshot write fails, so a run leaves only its ledger behind. */
function snapshotlessHarness(storage: Storage): AgentHarness {
  return harnessWith(storage, {
    ...createCheckpointStore({
      storage,
    }),
    save: () => Promise.reject(new Error('snapshot write refused')),
  });
}

function countingStep(id: string, calls: string[], out: (input: string) => string): RunStep {
  return runCode<ContextData, string, string>({
    id,
    execute: async (input: string) => {
      calls.push(id);
      return out(input);
    },
  });
}

function mustRestore(ctx: Context | null): Context {
  if (!ctx) {
    throw new Error('expected a restored context');
  }
  return ctx;
}

describe('restore without a snapshot', () => {
  let warn: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warn = spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('replays recorded steps from the ledger alone and runs the rest fresh', async () => {
    const storage = createInMemoryStorage();
    const harness = snapshotlessHarness(storage);
    const calls: string[] = [];
    const first = countingStep('first', calls, () => 'a');
    const second = countingStep('second', calls, (i) => `${i}b`);
    const ctx = harness.createContext();
    await harness.run(first, 'go', ctx);
    expect(
      await createCheckpointStore({
        storage,
      }).load(ctx.id),
    ).toBeNull();

    const resumedHarness = durableHarness(storage);
    const resumed = mustRestore(await resumedHarness.restore(ctx.id));
    expect(resumed.id).toBe(ctx.id);
    expect(resumed.itemLog.items).toEqual([]);
    calls.length = 0;

    expect(await resumedHarness.run(first, 'go', resumed)).toBe('a');
    expect(await resumedHarness.run(second, 'a', resumed)).toBe('ab');
    expect(calls).toEqual([
      'second',
    ]);
    expect(resumed.stepCount).toBe(2);
  });

  it('returns null when neither a snapshot nor a ledger entry is recorded', async () => {
    const storage = createInMemoryStorage();
    const harness = snapshotlessHarness(storage);
    const ctx = harness.createContext();
    const failing = runCode<ContextData, string, string>({
      id: 'fails',
      execute: async () => {
        throw new Error('boom');
      },
    });
    await expect(harness.run(failing, 'x', ctx)).rejects.toThrow('boom');

    expect(await durableHarness(storage).restore(ctx.id)).toBeNull();
  });

  it('rejects an unknown snapshot version instead of falling back to the ledger', async () => {
    const storage = createInMemoryStorage();
    const harness = durableHarness(storage);
    const ctx = harness.createContext();
    await harness.run(
      countingStep('only', [], () => 'a'),
      'go',
      ctx,
    );
    await storage.set(`${CheckpointKeys.ExecPrefix}${ctx.id}${CheckpointKeys.SnapshotSuffix}`, {
      schemaVersion: 99,
      executionId: ctx.id,
    });

    let thrown: unknown;
    try {
      await durableHarness(storage).restore(ctx.id);
    } catch (error) {
      thrown = error;
    }
    assert(isNoeticConfigError(thrown));
    expect(thrown.code).toBe('CHECKPOINT_SCHEMA_MISMATCH');
  });
});
