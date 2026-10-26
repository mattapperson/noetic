import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextLayer, LayerStateStore } from '@noetic-tools/context';
import { createLayerStateStore, returnLayers } from '@noetic-tools/context';
import type { ExecutionContext, ParentUpdateParams } from '@noetic-tools/types';
import { createMessage } from '@noetic-tools/types';
import { NoeticEvent } from '../../src/observability/genai-attributes';
import { makeCtx, makeItemLog, makeLayer, sleep } from '../_helpers';

type Attributes = Record<string, string | number | boolean>;

interface Diagnostic {
  layerId: string;
  hook: string;
  error: unknown;
}

function recordingStore(): {
  store: LayerStateStore;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const store = createLayerStateStore((layerId, hook, error) => {
    diagnostics.push({
      layerId,
      hook,
      error,
    });
  });
  return {
    store,
    diagnostics,
  };
}

function childCtx(executionId: string): {
  ctx: ExecutionContext;
  hookEvents: Attributes[];
} {
  const hookEvents: Attributes[] = [];
  const ctx = makeCtx({
    executionId,
    depth: 1,
    trace: {
      setAttribute() {},
      addEvent(name, attributes) {
        if (name === NoeticEvent.LAYER_HOOK && attributes) {
          hookEvents.push(attributes);
        }
      },
    },
  });
  return {
    ctx,
    hookEvents,
  };
}

/** A layer whose `onParentUpdate` copies the parent's value into the child. */
function followLayer(calls: ParentUpdateParams<unknown>[] = []): ContextLayer {
  return makeLayer('plan', {
    hooks: {
      onParentUpdate: async (params) => {
        calls.push(params);
        return {
          childState: params.parentState,
        };
      },
    },
  });
}

/** Lets queued deliveries run. */
const settle = (): Promise<void> => sleep(0);

describe('onParentUpdate', () => {
  it('delivers a parent write to a live child with both states', async () => {
    const { store } = recordingStore();
    const calls: ParentUpdateParams<unknown>[] = [];
    const { ctx } = childCtx('child');
    store.set('child', 'plan', 'child-v0');
    store.adopt?.({
      parentExecutionId: 'parent',
      ctx,
      layers: [
        followLayer(calls),
      ],
      log: makeItemLog(),
    });

    store.set('parent', 'plan', 'v1');
    await settle();

    expect(
      calls.map(({ parentState, childState }) => [
        parentState,
        childState,
      ]),
    ).toEqual([
      [
        'v1',
        'child-v0',
      ],
    ]);
    expect(calls[0]?.childCtx).toBe(ctx);
    expect(store.get('child', 'plan')).toBe('v1');
  });

  it('appends returned items to the child log', async () => {
    const { store } = recordingStore();
    const log = makeItemLog();
    store.adopt?.({
      parentExecutionId: 'parent',
      ctx: childCtx('child').ctx,
      layers: [
        makeLayer('plan', {
          hooks: {
            onParentUpdate: async ({ parentState }) => ({
              items: [
                createMessage(`plan changed: ${String(parentState)}`, 'developer'),
              ],
            }),
          },
        }),
      ],
      log,
    });

    store.set('parent', 'plan', 'v2');
    await settle();

    expect(log.items).toHaveLength(1);
    expect(JSON.stringify(log.items[0])).toContain('plan changed: v2');
    // No `childState` key: the child's state is left alone.
    expect(store.has?.('child', 'plan')).toBe(false);
  });

  it('delivers to every live child of the parent, and only for the written layer', async () => {
    const { store } = recordingStore();
    const seen: string[] = [];
    const watcher = (name: string): ContextLayer =>
      makeLayer('plan', {
        hooks: {
          onParentUpdate: async () => {
            seen.push(name);
            return undefined;
          },
        },
      });
    for (const name of [
      'a',
      'b',
    ]) {
      store.adopt?.({
        parentExecutionId: 'parent',
        ctx: childCtx(name).ctx,
        layers: [
          watcher(name),
        ],
        log: makeItemLog(),
      });
    }
    store.adopt?.({
      parentExecutionId: 'other-parent',
      ctx: childCtx('c').ctx,
      layers: [
        watcher('c'),
      ],
      log: makeItemLog(),
    });

    store.set('parent', 'plan', 'v1');
    store.set('parent', 'notes', 'unrelated');
    await settle();

    expect(seen.sort()).toEqual([
      'a',
      'b',
    ]);
  });

  it('delivers one child its updates one at a time, in write order', async () => {
    const { store } = recordingStore();
    const order: string[] = [];
    store.adopt?.({
      parentExecutionId: 'parent',
      ctx: childCtx('child').ctx,
      layers: [
        makeLayer('plan', {
          hooks: {
            onParentUpdate: async ({ parentState }) => {
              order.push(`start ${String(parentState)}`);
              await sleep(parentState === 'v1' ? 10 : 0);
              order.push(`end ${String(parentState)}`);
              return undefined;
            },
          },
        }),
      ],
      log: makeItemLog(),
    });

    store.set('parent', 'plan', 'v1');
    store.set('parent', 'plan', 'v2');
    await sleep(30);

    expect(order).toEqual([
      'start v1',
      'end v1',
      'start v2',
      'end v2',
    ]);
  });

  it('leaves a layer without the hook alone', async () => {
    const { store, diagnostics } = recordingStore();
    const { ctx, hookEvents } = childCtx('child');
    store.set('child', 'plan', 'mine');
    store.adopt?.({
      parentExecutionId: 'parent',
      ctx,
      layers: [
        makeLayer('plan'),
      ],
      log: makeItemLog(),
    });

    store.set('parent', 'plan', 'theirs');
    await settle();

    expect(store.get('child', 'plan')).toBe('mine');
    expect(hookEvents).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it('skips a layer the child opted out of', async () => {
    const { store } = recordingStore();
    const calls: ParentUpdateParams<unknown>[] = [];
    store.disable?.('child', 'plan');
    store.adopt?.({
      parentExecutionId: 'parent',
      ctx: childCtx('child').ctx,
      layers: [
        followLayer(calls),
      ],
      log: makeItemLog(),
    });

    store.set('parent', 'plan', 'v1');
    await settle();

    expect(calls).toEqual([]);
  });

  it('logs a failing hook and never fails the parent write', async () => {
    const { store, diagnostics } = recordingStore();
    const { ctx, hookEvents } = childCtx('child');
    store.adopt?.({
      parentExecutionId: 'parent',
      ctx,
      layers: [
        makeLayer('plan', {
          hooks: {
            onParentUpdate: async () => {
              throw new Error('child busy');
            },
          },
        }),
      ],
      log: makeItemLog(),
    });

    expect(() => store.set('parent', 'plan', 'v1')).not.toThrow();
    expect(store.get('parent', 'plan')).toBe('v1');
    await settle();

    expect(diagnostics).toHaveLength(1);
    const [diagnostic] = diagnostics;
    assert(diagnostic);
    expect(diagnostic.layerId).toBe('plan');
    expect(diagnostic.hook).toBe('onParentUpdate');
    expect(diagnostic.error).toBeInstanceOf(Error);
    expect(hookEvents.map(({ duration: _, ...rest }) => rest)).toEqual([
      {
        layerId: 'plan',
        hook: 'onParentUpdate',
        status: 'error',
        'error.message': 'child busy',
      },
    ]);
  });

  it('times out a slow hook under timeouts.onParentUpdate', async () => {
    const { store, diagnostics } = recordingStore();
    const { ctx, hookEvents } = childCtx('child');
    store.adopt?.({
      parentExecutionId: 'parent',
      ctx,
      layers: [
        {
          ...makeLayer('plan', {
            hooks: {
              onParentUpdate: () => new Promise(() => {}),
            },
          }),
          timeouts: {
            onParentUpdate: 5,
          },
        },
      ],
      log: makeItemLog(),
    });

    store.set('parent', 'plan', 'v1');
    await sleep(20);

    expect(diagnostics.map((d) => d.hook)).toEqual([
      'onParentUpdate',
    ]);
    expect(hookEvents.map((e) => e.status)).toEqual([
      'timeout',
    ]);
  });

  it('records a layer.hook event on the child span', async () => {
    const { store } = recordingStore();
    const { ctx, hookEvents } = childCtx('child');
    store.adopt?.({
      parentExecutionId: 'parent',
      ctx,
      layers: [
        followLayer(),
      ],
      log: makeItemLog(),
    });

    store.set('parent', 'plan', 'v1');
    await settle();

    expect(
      hookEvents.map(({ duration, ...rest }) => [
        typeof duration,
        rest,
      ]),
    ).toEqual([
      [
        'number',
        {
          layerId: 'plan',
          hook: 'onParentUpdate',
          status: 'ok',
        },
      ],
    ]);
  });

  it('passes a child update on to its own live children', async () => {
    const { store } = recordingStore();
    for (const [id, parent] of [
      [
        'child',
        'parent',
      ],
      [
        'grandchild',
        'child',
      ],
    ] as const) {
      store.adopt?.({
        parentExecutionId: parent,
        ctx: childCtx(id).ctx,
        layers: [
          followLayer(),
        ],
        log: makeItemLog(),
      });
    }

    store.set('parent', 'plan', 'v1');
    await settle();

    expect(store.get('grandchild', 'plan')).toBe('v1');
  });

  it('release waits for a running delivery and skips the queued ones', async () => {
    const { store } = recordingStore();
    const seen: unknown[] = [];
    store.adopt?.({
      parentExecutionId: 'parent',
      ctx: childCtx('child').ctx,
      layers: [
        makeLayer('plan', {
          hooks: {
            onParentUpdate: async ({ parentState }) => {
              seen.push(parentState);
              await sleep(5);
              return {
                childState: parentState,
              };
            },
          },
        }),
      ],
      log: makeItemLog(),
    });

    store.set('parent', 'plan', 'v1');
    store.set('parent', 'plan', 'v2');
    await settle();
    await store.release?.('child');

    expect(seen).toEqual([
      'v1',
    ]);
    expect(store.get('child', 'plan')).toBe('v1');
    expect(store.liveChildren?.()).toBe(0);
  });

  it('cleanup forgets the child and drops the result of a running delivery', async () => {
    const { store } = recordingStore();
    store.adopt?.({
      parentExecutionId: 'parent',
      ctx: childCtx('child').ctx,
      layers: [
        makeLayer('plan', {
          hooks: {
            onParentUpdate: async ({ parentState }) => {
              await sleep(5);
              return {
                childState: parentState,
              };
            },
          },
        }),
      ],
      log: makeItemLog(),
    });

    store.set('parent', 'plan', 'v1');
    await settle();
    store.cleanup('child');
    expect(store.liveChildren?.()).toBe(0);
    await sleep(10);

    // The late result would recreate the child's state entry: a leak.
    expect(store.has?.('child', 'plan')).toBe(false);
  });

  it('returnLayers stops updates before the onReturn merge', async () => {
    const { store } = recordingStore();
    const parentCtx = makeCtx({
      executionId: 'parent',
    });
    const { ctx } = childCtx('child');
    const calls: ParentUpdateParams<unknown>[] = [];
    const layer: ContextLayer = {
      ...followLayer(calls),
      hooks: {
        ...followLayer(calls).hooks,
        onReturn: async ({ childState }) => ({
          parentState: `merged ${String(childState)}`,
        }),
      },
    };
    store.set('child', 'plan', 'child-work');
    store.adopt?.({
      parentExecutionId: 'parent',
      ctx,
      layers: [
        layer,
      ],
      log: makeItemLog(),
    });

    await returnLayers({
      layers: [
        layer,
      ],
      parentCtx,
      childCtx: ctx,
      childLog: makeItemLog(),
      result: 'done',
      store,
    });
    await settle();

    // The merge wrote the parent's state, but the returned child heard nothing.
    expect(store.get('parent', 'plan')).toBe('merged child-work');
    expect(calls).toEqual([]);
    expect(store.liveChildren?.()).toBe(0);
  });
});
