import { describe, expect, it } from 'bun:test';
import type { ContextLayer } from '@noetic-tools/context';
import {
  completeLayers,
  createLayerStateStore,
  disposeLayers,
  initLayers,
  recallLayers,
  spawnLayers,
  storeLayers,
} from '@noetic-tools/context';
import type { ExecutionContext } from '@noetic-tools/types';
import { createMessage } from '@noetic-tools/types';
import { NoeticEvent } from '../../src/observability/genai-attributes';
import { makeCtx, makeItemLog, makeLLMResponse, makeStorage } from '../_helpers';

type Attributes = Record<string, string | number | boolean>;

/** An execution context whose span records `layer.hook` events. */
function tracedCtx(overrides?: Partial<ExecutionContext>): {
  ctx: ExecutionContext;
  hookEvents: Attributes[];
} {
  const hookEvents: Attributes[] = [];
  const ctx = makeCtx({
    ...overrides,
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

/** The event fields that do not depend on timing. */
function withoutDuration(events: Attributes[]): Attributes[] {
  return events.map(({ duration, ...rest }) => {
    expect(typeof duration).toBe('number');
    return rest;
  });
}

function layer(
  id: string,
  hooks: ContextLayer['hooks'],
  extra?: Partial<ContextLayer>,
): ContextLayer {
  return {
    id,
    slot: 100,
    scope: 'execution',
    hooks,
    ...extra,
  };
}

describe('layer.hook events', () => {
  it('records each lifecycle hook with status ok', async () => {
    const { ctx, hookEvents } = tracedCtx();
    const store = createLayerStateStore();
    const layers = [
      layer('notes', {
        init: async () => ({
          state: 1,
        }),
        store: async () => ({
          state: 2,
        }),
        onComplete: async () => undefined,
        dispose: async () => {},
      }),
    ];

    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });
    await storeLayers({
      layers,
      response: makeLLMResponse('hi'),
      ctx,
      log: makeItemLog(),
      store,
    });
    await completeLayers({
      layers,
      ctx,
      log: makeItemLog(),
      outcome: 'success',
      store,
    });
    await disposeLayers({
      layers,
      ctx,
      store,
    });

    expect(withoutDuration(hookEvents)).toEqual(
      [
        'init',
        'store',
        'onComplete',
        'dispose',
      ].map((hook) => ({
        layerId: 'notes',
        hook,
        status: 'ok',
      })),
    );
  });

  it("records a recall's budget and item count", async () => {
    const { ctx, hookEvents } = tracedCtx();
    const layers = [
      layer('items', {
        recall: async () => ({
          items: [
            createMessage('a', 'developer'),
            createMessage('b', 'developer'),
          ],
          tokenCount: 30,
        }),
      }),
      layer('empty', {
        recall: async () => null,
      }),
    ];

    await recallLayers({
      layers,
      query: '',
      ctx,
      log: makeItemLog(),
      budgets: new Map([
        [
          'items',
          100,
        ],
        [
          'empty',
          10,
        ],
      ]),
      store: createLayerStateStore(),
    });

    expect(withoutDuration(hookEvents)).toEqual([
      {
        layerId: 'items',
        hook: 'recall',
        status: 'ok',
        itemCount: 2,
        'budget.allocated': 100,
        'budget.used': 30,
        'budget.yielded': 70,
      },
      {
        layerId: 'empty',
        hook: 'recall',
        status: 'ok',
        itemCount: 0,
        'budget.allocated': 10,
        'budget.used': 0,
        'budget.yielded': 10,
      },
    ]);
  });

  it('records a thrown recall as error and a slow one as timeout', async () => {
    const { ctx, hookEvents } = tracedCtx();
    const layers = [
      layer('boom', {
        recall: async () => {
          throw new Error('recall broke');
        },
      }),
      layer(
        'slow',
        {
          recall: () => new Promise(() => {}),
        },
        {
          timeouts: {
            recall: 5,
          },
        },
      ),
    ];

    await recallLayers({
      layers,
      query: '',
      ctx,
      log: makeItemLog(),
      budgets: new Map(),
      store: createLayerStateStore(() => {}),
    });

    expect(withoutDuration(hookEvents)).toEqual([
      {
        layerId: 'boom',
        hook: 'recall',
        status: 'error',
        'error.message': 'recall broke',
      },
      {
        layerId: 'slow',
        hook: 'recall',
        status: 'timeout',
        'error.message': 'Timeout after 5ms',
      },
    ]);
  });

  it('records a disabled layer as skipped', async () => {
    const { ctx, hookEvents } = tracedCtx();
    const store = createLayerStateStore(() => {});
    const layers = [
      layer(
        'flaky',
        {
          init: async () => {
            throw new Error('no backend');
          },
          recall: async () => 'never',
        },
        {
          onInitError: 'disable',
        },
      ),
    ];

    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });
    await recallLayers({
      layers,
      query: '',
      ctx,
      log: makeItemLog(),
      budgets: new Map(),
      store,
    });

    expect(withoutDuration(hookEvents)).toEqual([
      {
        layerId: 'flaky',
        hook: 'init',
        status: 'error',
        'error.message': 'no backend',
      },
      {
        layerId: 'flaky',
        hook: 'recall',
        status: 'skipped',
      },
    ]);
  });

  it('records nothing for a peek', async () => {
    const { ctx, hookEvents } = tracedCtx();

    await recallLayers({
      layers: [
        layer('items', {
          recall: async () => 'text',
        }),
      ],
      query: '',
      ctx,
      log: makeItemLog(),
      budgets: new Map(),
      store: createLayerStateStore(),
      peek: true,
    });

    expect(hookEvents).toHaveLength(0);
  });

  it("records onSpawn on the parent's span", async () => {
    const parent = tracedCtx({
      executionId: 'parent',
    });
    const child = tracedCtx({
      executionId: 'child',
      depth: 1,
    });

    await spawnLayers({
      layers: [
        layer('seed', {
          onSpawn: async () => ({
            childState: 'seeded',
          }),
        }),
      ],
      parentCtx: parent.ctx,
      childCtx: child.ctx,
      store: createLayerStateStore(),
    });

    expect(withoutDuration(parent.hookEvents)).toEqual([
      {
        layerId: 'seed',
        hook: 'onSpawn',
        status: 'ok',
      },
    ]);
    expect(child.hookEvents).toHaveLength(0);
  });
});
