import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData } from '@noetic-tools/context';
import type { Step } from '@noetic-tools/types';
import { z } from 'zod';
import { channel } from '../../src/builders/channel-builder';
import { runCode } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { ChannelStore } from '../../src/runtime/channel-store';
import { createCheckpointStore } from '../../src/runtime/durable/checkpoint-store';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { runThenCrash } from '../_helpers';

const status = channel('status', {
  schema: z.string(),
  mode: 'value',
});
const jobs = channel('jobs', {
  schema: z.number(),
  mode: 'queue',
  capacity: 5,
});
const events = channel('events', {
  schema: z.string(),
  mode: 'topic',
});

function writeStep(): Step<ContextData, string, string> {
  return {
    kind: 'runCode',
    id: 'write',
    execute: async (input: string, ctx) => {
      await ctx.send(status, input);
      await ctx.send(jobs, 1);
      await ctx.send(jobs, 2);
      await ctx.send(events, 'lost');
      return input;
    },
  };
}

/** Options for harnesses that share one durable storage, as across a restart. */
function durableOpts(): ConstructorParameters<typeof AgentHarness>[0] {
  const storage = createInMemoryStorage();
  return {
    name: 'test',
    params: {},
    environment: {
      storage: {
        adapter: storage,
        checkpointStore: createCheckpointStore({
          storage,
        }),
      },
    },
  };
}

/** Drain a queue channel through a context, oldest first. */
function drain(read: () => number | null): number[] {
  const out: number[] = [];
  for (let v = read(); v !== null; v = read()) {
    out.push(v);
  }
  return out;
}

describe('channel state and checkpoints', () => {
  it('without a CheckpointStore, channel state outlives the run for the harness lifetime', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const ctx = harness.createContext();
    await harness.run(writeStep(), 'done', ctx);
    const later = harness.createContext();
    expect(harness.tryRecv(status, later)).toBe('done');
    expect(harness.tryRecv(jobs, later)).toBe(1);
    expect(ctx.itemLog.items).toEqual([]);
  });

  it('snapshots only the channels an execution claimed, skipping topics', async () => {
    const store = new ChannelStore();
    store.claim(status, 'a');
    store.claim(events, 'a');
    store.claim(jobs, 'b');
    await store.send(status, 'v');
    await store.send(jobs, 3);
    expect(store.snapshot('a')).toEqual([
      {
        name: 'status',
        mode: 'value',
        value: 'v',
        hasValue: true,
      },
    ]);
    store.closeExecution('a');
    // A finished execution can still be checkpointed.
    expect(store.snapshot('a')).toHaveLength(1);
  });

  it('restore keeps live state over the snapshot', async () => {
    const store = new ChannelStore();
    await store.send(status, 'live');
    store.restore('a', [
      {
        name: 'status',
        mode: 'value',
        value: 'stale',
        hasValue: true,
      },
    ]);
    expect(store.tryRecv(status)).toBe('live');
    expect(store.snapshot('a')).toEqual([
      {
        name: 'status',
        mode: 'value',
        value: 'live',
        hasValue: true,
      },
    ]);
  });

  it('checkpoints value and queue state and restores it into a fresh harness', async () => {
    const opts = durableOpts();
    const first = new AgentHarness(opts);
    const ctx = first.createContext();
    await first.run(writeStep(), 'running', ctx);

    const snapshot = await first.checkpointStore?.load(ctx.id);
    assert(snapshot?.channels);
    expect(snapshot.channels).toEqual([
      {
        name: 'status',
        mode: 'value',
        value: 'running',
        hasValue: true,
      },
      {
        name: 'jobs',
        mode: 'queue',
        capacity: 5,
        queue: [
          1,
          2,
        ],
      },
    ]);

    const second = new AgentHarness(opts);
    const restored = await second.restore(ctx.id);
    assert(restored);
    expect(restored.tryRecv(status)).toBe('running');
    expect(drain(() => restored.tryRecv(jobs))).toEqual([
      1,
      2,
    ]);
    expect(restored.itemLog.items).toEqual([]);
  });

  // Spec 23a § Identity: a `durable: false` step re-runs on resume, so a send it
  // made before the checkpoint lands again on top of the restored queue. A
  // durable step is replayed from the ledger and does not send twice.
  it('a re-run durable: false sender duplicates items in a restored queue', async () => {
    const sender = (durable: boolean): Step<ContextData, string, string> =>
      runCode<ContextData, string, string>({
        id: durable ? 'durable-sender' : 'cheap-sender',
        durable,
        execute: async (input: string, ctx) => {
          await ctx.send(jobs, 7);
          return input;
        },
      });

    const runAndResume = async (durable: boolean): Promise<number[]> => {
      const opts = durableOpts();
      const first = new AgentHarness(opts);
      const ctx = first.createContext();
      await runThenCrash(first, sender(durable), 'go', ctx);

      const second = new AgentHarness(opts);
      const resumed = await second.restore(ctx.id);
      assert(resumed);
      await second.run(sender(durable), 'go', resumed);
      return drain(() => resumed.tryRecv(jobs));
    };

    expect(await runAndResume(false)).toEqual([
      7,
      7,
    ]);
    expect(await runAndResume(true)).toEqual([
      7,
    ]);
  });
});
