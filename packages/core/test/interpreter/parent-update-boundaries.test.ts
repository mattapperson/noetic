import { describe, expect, it } from 'bun:test';
import type { ContextData, ContextLayer } from '@noetic-tools/context';
import { createLayerStateStore } from '@noetic-tools/context';
import type { Context, StepInParallelAll, StepSpawn } from '@noetic-tools/types';
import { executeSpawn } from '../../src/interpreter/execute-action';
import { executeInParallel } from '../../src/interpreter/execute-control';
import { ContextImpl } from '../../src/runtime/context-impl';
import { makeLayer, makeMockHarness, simpleExecute, sleep } from '../_helpers';

/** A layer that seeds children with the parent's plan and follows its updates. */
function planLayer(updates: string[], heard?: () => void): ContextLayer {
  return makeLayer('plan', {
    hooks: {
      onSpawn: async ({ parentState }) => ({
        childState: parentState,
      }),
      onParentUpdate: async ({ parentState }) => {
        updates.push(String(parentState));
        heard?.();
        return {
          childState: parentState,
        };
      },
    },
  });
}

function parentContext(layer: ContextLayer): ContextImpl {
  return new ContextImpl({
    harness: makeMockHarness(),
    layers: [
      layer,
    ],
  });
}

describe('onParentUpdate across child boundaries', () => {
  it('a spawn child hears parent writes while it runs, and none after it returns', async () => {
    const store = createLayerStateStore();
    const updates: string[] = [];
    const { promise: heard, resolve } = Promise.withResolvers<void>();
    const layer = planLayer(updates, resolve);
    const ctx = parentContext(layer);
    store.set(ctx.id, 'plan', 'v1');

    const step: StepSpawn<ContextData, string, string> = {
      kind: 'spawn',
      id: 'worker',
      child: {
        kind: 'runCode',
        id: 'work',
        execute: async (_input: string, child: Context<ContextData>): Promise<string> => {
          store.set(ctx.id, 'plan', 'v2');
          await heard;
          await sleep(0);
          return String(store.get(child.id, 'plan'));
        },
      },
    };

    const output = await executeSpawn(step, '', ctx, simpleExecute, {
      layerStore: store,
      parentLayers: [
        layer,
      ],
    });
    expect(output).toBe('v2');

    store.set(ctx.id, 'plan', 'v3');
    await sleep(0);
    expect(updates).toEqual([
      'v2',
    ]);
    expect(store.liveChildren?.()).toBe(0);
  });

  it('forgets a spawn child that fails', async () => {
    const store = createLayerStateStore();
    const layer = planLayer([]);
    const ctx = parentContext(layer);
    store.set(ctx.id, 'plan', 'v1');

    const step: StepSpawn<ContextData, string, string> = {
      kind: 'spawn',
      id: 'doomed',
      child: {
        kind: 'runCode',
        id: 'boom',
        execute: async (): Promise<string> => {
          throw new Error('child failed');
        },
      },
    };

    await expect(
      executeSpawn(step, '', ctx, simpleExecute, {
        layerStore: store,
        parentLayers: [
          layer,
        ],
      }),
    ).rejects.toThrow('child failed');
    expect(store.liveChildren?.()).toBe(0);
  });

  it('inParallel paths hear parent writes made by a sibling', async () => {
    const store = createLayerStateStore();
    const updates: string[] = [];
    const { promise: heard, resolve } = Promise.withResolvers<void>();
    const layer = planLayer(updates, resolve);
    const ctx = parentContext(layer);
    store.set(ctx.id, 'plan', 'v1');

    const step: StepInParallelAll<ContextData, string, string> = {
      kind: 'inParallel',
      id: 'fan-out',
      mode: 'all',
      paths: () => [
        {
          kind: 'runCode',
          id: 'reader',
          execute: async (_input: string, child: Context<ContextData>): Promise<string> => {
            await heard;
            await sleep(0);
            return String(store.get(child.id, 'plan'));
          },
        },
        {
          kind: 'runCode',
          id: 'writer',
          execute: async (): Promise<string> => {
            store.set(ctx.id, 'plan', 'v2');
            return 'wrote';
          },
        },
      ],
      merge: (results) => results.join(','),
    };

    const merged = await executeInParallel(step, '', ctx, simpleExecute, {
      layerStore: store,
    });

    expect(merged).toBe('v2,wrote');
    // Both paths were live for the write: the reader and the writer itself.
    expect(updates).toEqual([
      'v2',
      'v2',
    ]);
    expect(store.liveChildren?.()).toBe(0);
  });

  it('delivers to every live spawn child of the parent', async () => {
    const store = createLayerStateStore();
    const updates: string[] = [];
    let count = 0;
    const { promise: bothHeard, resolve } = Promise.withResolvers<void>();
    const layer = planLayer(updates, () => {
      count += 1;
      if (count === 2) {
        resolve();
      }
    });
    const ctx = parentContext(layer);
    store.set(ctx.id, 'plan', 'v1');
    const { promise: bothRunning, resolve: started } = Promise.withResolvers<void>();
    let running = 0;

    const worker = (id: string): StepSpawn<ContextData, string, string> => ({
      kind: 'spawn',
      id,
      child: {
        kind: 'runCode',
        id: `${id}-body`,
        execute: async (_input: string, child: Context<ContextData>): Promise<string> => {
          running += 1;
          if (running === 2) {
            started();
          }
          await bothHeard;
          await sleep(0);
          return String(store.get(child.id, 'plan'));
        },
      },
    });
    const opts = {
      layerStore: store,
      parentLayers: [
        layer,
      ],
    };

    const results = Promise.all([
      executeSpawn(worker('a'), '', ctx, simpleExecute, opts),
      executeSpawn(worker('b'), '', ctx, simpleExecute, opts),
    ]);
    await bothRunning;
    expect(store.liveChildren?.()).toBe(2);
    store.set(ctx.id, 'plan', 'v2');

    expect(await results).toEqual([
      'v2',
      'v2',
    ]);
    expect(store.liveChildren?.()).toBe(0);
  });
});
