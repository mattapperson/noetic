import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createLocalFsAdapter } from '../../src/adapters/local-fs-adapter';
import { createLocalShellAdapter } from '../../src/adapters/local-shell-adapter';
import { layerData, layerFn } from '../../src/builders/layer-provides-builders';
import { frameworkCast } from '../../src/interpreter/framework-cast';
import { resolveLayerTools } from '../../src/memory/layer-api';
import { workingMemory } from '../../src/memory/layers/working-memory';
import { ContextImpl } from '../../src/runtime/context-impl';
import type { MemoryLayer, MemoryScope } from '../../src/types/memory';
import { Slot } from '../../src/types/memory';
import { makeMockContext, makeMockHarness } from '../_helpers';

//#region Test Helpers

function makeStatefulHarness(): ReturnType<typeof makeMockHarness> {
  const harness = makeMockHarness();
  const stateStore = new Map<string, unknown>();

  harness.getLayerState = <T>(executionId: string, layerId: string): T | undefined => {
    const key = `${executionId}/${layerId}`;
    const val = stateStore.get(key);
    return val === undefined ? undefined : frameworkCast<T>(val);
  };

  harness.setLayerState = <T>(executionId: string, layerId: string, state: T): void => {
    const key = `${executionId}/${layerId}`;
    stateStore.set(key, state);
  };

  return harness;
}

//#endregion

//#region Test Layer Factories

interface CounterState {
  count: number;
}

const COUNTER_SCOPE: MemoryScope = 'execution';

function makeCounterLayer() {
  return {
    id: 'counter',
    slot: Slot.WORKING_MEMORY,
    scope: COUNTER_SCOPE,
    hooks: {},
    provides: {
      value: layerData<number, CounterState>({
        read: (state) => state.count,
      }),
      increment: layerFn<
        {
          amount: number;
        },
        number,
        CounterState
      >({
        description: 'Increment the counter by an amount.',
        input: z.object({
          amount: z.number(),
        }),
        output: z.number(),
        execute: async (args, state) => {
          const newCount = state.count + args.amount;
          return {
            result: newCount,
            state: {
              count: newCount,
            },
          };
        },
      }),
      peek: layerFn<Record<string, never>, number, CounterState>({
        description: 'Read the counter without mutating.',
        input: z.object({}),
        output: z.number(),
        execute: async (_args, state) => ({
          result: state.count,
        }),
      }),
    },
  };
}

function makeEmptyLayer(): MemoryLayer {
  return {
    id: 'empty',
    slot: Slot.OBSERVATIONS,
    scope: 'execution' satisfies MemoryScope,
    hooks: {},
  };
}

//#endregion

//#region ctx.memory

describe('ctx.memory', () => {
  it('reads data from layer state via ctx.memory[layerId]', () => {
    const layer = makeCounterLayer();
    const harness = makeStatefulHarness();
    const ctx = new ContextImpl({
      harness,
      layers: [
        layer,
      ],
    });
    harness.setLayerState(ctx.id, 'counter', {
      count: 42,
    });

    expect(ctx.memory.counter.value).toBe(42);
  });

  it('data reads are live — reflect state changes', () => {
    const layer = makeCounterLayer();
    const harness = makeStatefulHarness();
    const ctx = new ContextImpl({
      harness,
      layers: [
        layer,
      ],
    });
    harness.setLayerState(ctx.id, 'counter', {
      count: 1,
    });

    expect(ctx.memory.counter.value).toBe(1);

    harness.setLayerState(ctx.id, 'counter', {
      count: 99,
    });
    expect(ctx.memory.counter.value).toBe(99);
  });

  it('calls a function and returns the result', async () => {
    const layer = makeCounterLayer();
    const harness = makeStatefulHarness();
    const ctx = new ContextImpl({
      harness,
      layers: [
        layer,
      ],
    });
    harness.setLayerState(ctx.id, 'counter', {
      count: 10,
    });

    const incrementFn = frameworkCast<(args: { amount: number }) => Promise<number>>(
      ctx.memory.counter.increment,
    );
    expect(typeof incrementFn).toBe('function');
    const result = await incrementFn({
      amount: 5,
    });
    expect(result).toBe(15);
  });

  it('function mutates layer state when state is returned', async () => {
    const layer = makeCounterLayer();
    const harness = makeStatefulHarness();
    const ctx = new ContextImpl({
      harness,
      layers: [
        layer,
      ],
    });
    harness.setLayerState(ctx.id, 'counter', {
      count: 10,
    });

    const incrementFn = frameworkCast<(args: { amount: number }) => Promise<number>>(
      ctx.memory.counter.increment,
    );
    await incrementFn({
      amount: 5,
    });

    const updatedState = harness.getLayerState<CounterState>(ctx.id, 'counter');
    expect(updatedState?.count).toBe(15);
  });

  it('function does not mutate state when state is omitted from return', async () => {
    const layer = makeCounterLayer();
    const harness = makeStatefulHarness();
    const ctx = new ContextImpl({
      harness,
      layers: [
        layer,
      ],
    });
    harness.setLayerState(ctx.id, 'counter', {
      count: 10,
    });

    const peekFn = frameworkCast<(args: Record<string, never>) => Promise<number>>(
      ctx.memory.counter.peek,
    );
    const result = await peekFn({});
    expect(result).toBe(10);

    const state = harness.getLayerState<CounterState>(ctx.id, 'counter');
    expect(state?.count).toBe(10);
  });

  it('returns empty handle for layer without provides', () => {
    const layer = makeEmptyLayer();
    const harness = makeStatefulHarness();
    const ctx = new ContextImpl({
      harness,
      layers: [
        layer,
      ],
    });

    expect(Object.keys(ctx.memory.empty)).toEqual([]);
  });

  it('memory is empty object when no layers', () => {
    const harness = makeStatefulHarness();
    const ctx = new ContextImpl({
      harness,
    });

    expect(Object.keys(ctx.memory)).toEqual([]);
  });

  it('lists all layer IDs as keys', () => {
    const counter = makeCounterLayer();
    const empty = makeEmptyLayer();
    const harness = makeStatefulHarness();
    const ctx = new ContextImpl({
      harness,
      layers: [
        counter,
        empty,
      ],
    });

    const keys = Object.keys(ctx.memory);
    expect(keys).toContain('counter');
    expect(keys).toContain('empty');
  });

  it('throws ZodError when function receives invalid args', () => {
    const layer = makeCounterLayer();
    const harness = makeStatefulHarness();
    const ctx = new ContextImpl({
      harness,
      layers: [
        layer,
      ],
    });
    harness.setLayerState(ctx.id, 'counter', {
      count: 0,
    });

    const incrementFn = frameworkCast<(args: unknown) => Promise<unknown>>(
      ctx.memory.counter.increment,
    );
    expect(() => incrementFn(frameworkCast('not-an-object'))).toThrow();
  });
});

//#endregion

//#region resolveLayerTools

describe('resolveLayerTools', () => {
  it('converts layer functions to Tools with namespaced names', () => {
    const layer = makeCounterLayer();
    const harness = makeStatefulHarness();
    const ctx = makeMockContext({
      layers: [
        layer,
      ],
      harness,
    });
    harness.setLayerState(ctx.id, 'counter', {
      count: 0,
    });

    const tools = resolveLayerTools(
      [
        layer,
      ],
      harness,
      ctx,
    );
    const names = tools.map((t) => t.name);
    expect(names).toContain('counter/increment');
    expect(names).toContain('counter/peek');
    expect(names).not.toContain('counter/value');
  });

  it('tool description matches layer function description', () => {
    const layer = makeCounterLayer();
    const harness = makeStatefulHarness();
    const ctx = makeMockContext({
      layers: [
        layer,
      ],
      harness,
    });

    const tools = resolveLayerTools(
      [
        layer,
      ],
      harness,
      ctx,
    );
    const incrementTool = tools.find((t) => t.name === 'counter/increment');
    expect(incrementTool?.description).toBe('Increment the counter by an amount.');
  });

  it('executing a tool updates layer state', async () => {
    const layer = makeCounterLayer();
    const harness = makeStatefulHarness();
    const ctx = makeMockContext({
      layers: [
        layer,
      ],
      harness,
    });
    harness.setLayerState(ctx.id, 'counter', {
      count: 5,
    });

    const tools = resolveLayerTools(
      [
        layer,
      ],
      harness,
      ctx,
    );
    const incrementTool = tools.find((t) => t.name === 'counter/increment');
    expect(incrementTool).toBeDefined();

    const toolCtx = {
      ctx,
      harness,
      fs: harness.fs,
      shell: harness.shell,
      memory: {
        get: () => undefined,
        set: () => {},
      },
      assembledView: [],
      lastStepMeta: null,
    };
    const result = await incrementTool!.execute(
      {
        amount: 3,
      },
      toolCtx,
    );
    expect(result).toBe(8);

    const state = harness.getLayerState<CounterState>(ctx.id, 'counter');
    expect(state?.count).toBe(8);
  });

  it('returns empty array for layers without provides', () => {
    const layer = makeEmptyLayer();
    const harness = makeStatefulHarness();
    const ctx = makeMockContext({
      layers: [
        layer,
      ],
      harness,
    });

    const tools = resolveLayerTools(
      [
        layer,
      ],
      harness,
      ctx,
    );
    expect(tools).toEqual([]);
  });

  it('collects tools from multiple layers', () => {
    const counter = makeCounterLayer();
    const empty = makeEmptyLayer();
    const harness = makeStatefulHarness();
    const ctx = makeMockContext({
      layers: [
        counter,
        empty,
      ],
      harness,
    });

    const tools = resolveLayerTools(
      [
        counter,
        empty,
      ],
      harness,
      ctx,
    );
    expect(tools.length).toBe(2);
  });
});

//#endregion

//#region workingMemory provides

describe('workingMemory provides', () => {
  it('exposes snapshot data and update function', () => {
    const wm = workingMemory();
    expect(wm.provides).toBeDefined();
    expect(wm.provides?.snapshot).toBeDefined();
    expect(wm.provides?.update).toBeDefined();
    expect(wm.provides?.snapshot.kind).toBe('data');
    expect(wm.provides?.update.kind).toBe('function');
  });

  it('snapshot reads current state', () => {
    const wm = workingMemory();
    const snapshot = wm.provides?.snapshot;
    expect(snapshot).toBeDefined();
    expect(snapshot?.kind).toBe('data');
    if (snapshot?.kind !== 'data') {
      throw new Error('unreachable');
    }
    expect(
      snapshot.read({
        notes: 'hello',
      }),
    ).toEqual({
      notes: 'hello',
    });
  });

  it('update merges into object state', async () => {
    const wm = workingMemory();
    const update = wm.provides?.update;
    expect(update).toBeDefined();
    expect(update?.kind).toBe('function');
    if (update?.kind !== 'function') {
      throw new Error('unreachable');
    }
    const result = await update.execute(
      {
        status: 'done',
      },
      {
        notes: 'hello',
      },
      {
        executionId: 'e1',
        threadId: 't1',
        depth: 0,
        stepNumber: 0,
        tokenUsage: {
          input: 0,
          output: 0,
        },
        cost: 0,
        fs: createLocalFsAdapter(),
        shell: createLocalShellAdapter(),
        tokenize: () => 0,
        trace: {
          setAttribute() {},
          addEvent() {},
        },
      },
    );
    expect(result.result).toBeUndefined();
    expect(result.state).toEqual({
      notes: 'hello',
      status: 'done',
    });
  });
});

//#endregion
