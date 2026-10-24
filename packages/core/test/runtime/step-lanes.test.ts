// Every dispatch runs on its own lane, so concurrent execute() calls on one context
// keep deterministic, non-interleaved paths. See specs/23a-step-level-resume § Identity.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Context, ContextData } from '@noetic-tools/types';
import { runCode } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { ContextImpl } from '../../src/runtime/context-impl';
import { createCheckpointStore } from '../../src/runtime/durable/checkpoint-store';
import { createStepLedgerStore } from '../../src/runtime/durable/step-ledger';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';

type Storage = ReturnType<typeof createInMemoryStorage>;
type RunStep = ReturnType<typeof runCode<ContextData, string, string>>;

function durableHarness(storage: Storage): AgentHarness {
  return new AgentHarness({
    name: 'lane-test',
    params: {},
    environment: {
      storage: {
        adapter: storage,
        checkpointStore: createCheckpointStore({
          storage,
        }),
      },
    },
  });
}

/** A leaf that waits `delays[id]` ms before answering, so tests control settle order. */
function slowLeaf(id: string, calls: string[], delays: Record<string, number>): RunStep {
  return runCode<ContextData, string, string>({
    id,
    execute: async (input: string) => {
      calls.push(id);
      await new Promise((resolve) => setTimeout(resolve, delays[id] ?? 0));
      return `${input}>${id}`;
    },
  });
}

/** A `run` step that dispatches each child through the harness, as the hydrator does. */
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

async function ledgerPaths(storage: Storage, executionId: string): Promise<string[]> {
  const { entries } = await createStepLedgerStore({
    storage,
  }).load(executionId);
  return [
    ...entries.keys(),
  ].sort();
}

function mustRestore(ctx: Context | null): Context {
  if (!ctx) {
    throw new Error('expected a restored context');
  }
  return ctx;
}

/** Two workflows run concurrently on one context; `delays` decides which settles first. */
async function runPair({
  harness,
  ctx,
  calls,
  delays,
}: {
  harness: AgentHarness;
  ctx: Context;
  calls: string[];
  delays: Record<string, number>;
}): Promise<string[]> {
  const left = sequenceOf(harness, 'left', [
    slowLeaf('l1', calls, delays),
    slowLeaf('l2', calls, delays),
  ]);
  const right = sequenceOf(harness, 'right', [
    slowLeaf('r1', calls, delays),
    slowLeaf('r2', calls, delays),
  ]);
  return Promise.all([
    harness.run(left, 'L', ctx),
    harness.run(right, 'R', ctx),
  ]);
}

const EXPECTED_PATHS = [
  '/left#0',
  '/left#0/l1#0',
  '/left#0/l2#0',
  '/right#0',
  '/right#0/r1#0',
  '/right#0/r2#0',
];

describe('step lanes', () => {
  let warn: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warn = spyOn(console, 'warn');
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('keeps concurrent execute() calls on one context from interleaving paths', async () => {
    const storage = createInMemoryStorage();
    const harness = durableHarness(storage);
    const ctx = harness.createContext();
    const calls: string[] = [];

    expect(
      await runPair({
        harness,
        ctx,
        calls,
        delays: {
          l1: 20,
          r1: 1,
          r2: 30,
          l2: 1,
        },
      }),
    ).toEqual([
      'L>l1>l2',
      'R>r1>r2',
    ]);
    expect(await ledgerPaths(storage, ctx.id)).toEqual(EXPECTED_PATHS);
    expect(warn).not.toHaveBeenCalled();
    expect(ctx.stepCount).toBe(6);
  });

  it('gives the same paths whichever call settles first', async () => {
    const fastLeft = createInMemoryStorage();
    const fastRight = createInMemoryStorage();
    const leftHarness = durableHarness(fastLeft);
    const rightHarness = durableHarness(fastRight);
    const leftCtx = leftHarness.createContext();
    const rightCtx = rightHarness.createContext();

    await runPair({
      harness: leftHarness,
      ctx: leftCtx,
      calls: [],
      delays: {
        r1: 15,
        r2: 15,
      },
    });
    await runPair({
      harness: rightHarness,
      ctx: rightCtx,
      calls: [],
      delays: {
        l1: 15,
        l2: 15,
      },
    });

    expect(await ledgerPaths(fastLeft, leftCtx.id)).toEqual(EXPECTED_PATHS);
    expect(await ledgerPaths(fastRight, rightCtx.id)).toEqual(EXPECTED_PATHS);
  });

  it('replays both concurrent calls after a resume, whatever the new settle order', async () => {
    const storage = createInMemoryStorage();
    const harness = durableHarness(storage);
    const ctx = harness.createContext();
    const calls: string[] = [];
    await runPair({
      harness,
      ctx,
      calls,
      delays: {
        l1: 20,
      },
    });

    const resumedHarness = durableHarness(storage);
    const resumed = mustRestore(await resumedHarness.restore(ctx.id));
    calls.length = 0;
    expect(
      await runPair({
        harness: resumedHarness,
        ctx: resumed,
        calls,
        delays: {
          r1: 20,
        },
      }),
    ).toEqual([
      'L>l1>l2',
      'R>r1>r2',
    ]);
    expect(calls).toEqual([]);
  });

  it('numbers same-id concurrent calls in dispatch order', async () => {
    const storage = createInMemoryStorage();
    const harness = durableHarness(storage);
    const ctx = harness.createContext();
    const leaf = slowLeaf('worker', [], {
      worker: 5,
    });

    await Promise.all([
      harness.run(leaf, 'a', ctx),
      harness.run(leaf, 'b', ctx),
    ]);

    const { entries } = await createStepLedgerStore({
      storage,
    }).load(ctx.id);
    expect(entries.get('/worker#0')?.output).toBe('a>worker');
    expect(entries.get('/worker#1')?.output).toBe('b>worker');
  });

  it('lists every in-flight step in the frontier, in dispatch order', async () => {
    const harness = new AgentHarness({
      name: 'frontier',
      params: {},
    });
    const ctx = harness.createContext();
    assertContextImpl(ctx);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = (id: string): RunStep =>
      runCode<ContextData, string, string>({
        id,
        execute: async (input: string) => {
          await gate;
          return input;
        },
      });

    const running = Promise.all([
      harness.run(held('first'), 'x', ctx),
      harness.run(held('second'), 'y', ctx),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.serialiseFrontier().map((frame) => frame.stepId)).toEqual([
      'first',
      'second',
    ]);

    release();
    await running;
    expect(ctx.serialiseFrontier()).toEqual([]);
  });

  it('shares state writes made on a lane with the context', async () => {
    const harness = new AgentHarness({
      name: 'lane-state',
      params: {},
    });
    const ctx = harness.createContext({
      state: {
        count: 0,
      },
    });
    const bump = runCode<ContextData, string, string>({
      id: 'bump',
      execute: async (input: string, stepCtx) => {
        stepCtx.state = {
          count: 1,
        };
        return input;
      },
    });

    await harness.run(bump, 'x', ctx);
    expect(ctx.state).toEqual({
      count: 1,
    });
  });
});

function assertContextImpl(ctx: Context): asserts ctx is ContextImpl {
  if (!(ctx instanceof ContextImpl)) {
    throw new Error('expected a ContextImpl');
  }
}
