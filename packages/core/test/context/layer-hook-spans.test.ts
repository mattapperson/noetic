import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextLayer, LayerStateStore } from '@noetic-tools/context';
import {
  afterModelCallLayers,
  beforeToolCallLayers,
  contextToExecCtx,
  createLayerStateStore,
  initLayers,
  notifyDecision,
  projectHistoryLayers,
  recallLayers,
  runAppendPipeline,
} from '@noetic-tools/context';
import type { AgentHarnessContract, DecisionRecord, ExecutionContext } from '@noetic-tools/types';
import { createMessage, SteeringAction } from '@noetic-tools/types';
import { NoeticAttr, NoeticEvent } from '../../src/observability/genai-attributes';
import { SpanImpl } from '../../src/observability/span-impl';
import { InMemoryExporter } from '../../src/observability/trace-exporter';
import { ContextImpl } from '../../src/runtime/context-impl';
import { makeCtx, makeItemLog, makeLLMResponse, makeMockHarness, makeStorage } from '../_helpers';

//#region Helpers

type Attributes = Record<string, string | number | boolean>;

/** An execution context built the way core builds one, over a recording span tree. */
function tracedExecCtx(): {
  ctx: ExecutionContext;
  root: SpanImpl;
  exporter: InMemoryExporter;
} {
  const exporter = new InMemoryExporter();
  const harness: AgentHarnessContract = {
    ...makeMockHarness(),
    traceExporter: exporter,
    createSpan: (name, parent) => new SpanImpl(name, parent),
  };
  const root = new SpanImpl('root', null);
  const context = new ContextImpl({
    harness,
    span: root,
  });
  return {
    ctx: contextToExecCtx(context),
    root,
    exporter,
  };
}

function hookSpans(exporter: InMemoryExporter): SpanImpl[] {
  return exporter.getSpansByName(NoeticEvent.LAYER_HOOK);
}

function attributesOf(span: SpanImpl): Attributes {
  return Object.fromEntries(span.attributes);
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

const RECORD: DecisionRecord = {
  stepId: 'pick',
  at: 0,
  modelId: 'm',
  source: 'native',
  answers: {},
};

/** Runs every newly traced hook of `layers` once against `ctx`. */
async function runSteeringHooks(
  layers: ContextLayer[],
  ctx: ExecutionContext,
  store: LayerStateStore,
): Promise<void> {
  await notifyDecision({
    layers,
    record: RECORD,
    ctx,
    store,
  });
  await beforeToolCallLayers({
    layers,
    toolName: 'shell',
    toolArgs: {},
    ctx,
    store,
  });
  await afterModelCallLayers({
    layers,
    response: makeLLMResponse('hi'),
    ctx,
    store,
  });
  await projectHistoryLayers({
    layers,
    items: [],
    ctx,
    store,
  });
  await runAppendPipeline({
    layers,
    items: [
      createMessage('hello', 'user'),
    ],
    ctx,
    log: makeItemLog(),
    store,
  });
}

const STEERING_HOOKS: ContextLayer['hooks'] = {
  onDecision: async () => undefined,
  beforeToolCall: async () => ({
    decision: {
      action: SteeringAction.Allow,
    },
  }),
  afterModelCall: async () => ({
    decision: {
      action: SteeringAction.Allow,
    },
  }),
  projectHistory: async ({ items }) => ({
    items,
  }),
  onItemAppend: async ({ items }) => ({
    items,
  }),
};

const STEERING_HOOK_NAMES = [
  'onDecision',
  'beforeToolCall',
  'afterModelCall',
  'projectHistory',
  'onItemAppend',
];

//#endregion

describe('layer.hook spans', () => {
  it('opens one ended, exported child span per hook call, and no event', async () => {
    const { ctx, root, exporter } = tracedExecCtx();
    const store = createLayerStateStore();
    const layers = [
      layer('notes', {
        init: async () => ({
          state: 1,
        }),
      }),
    ];

    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });

    const [span, ...rest] = hookSpans(exporter);
    assert(span);
    expect(rest).toHaveLength(0);
    expect(span.parentSpanId).toBe(root.spanId);
    expect(span.traceId).toBe(root.traceId);
    expect(span.endTime).toBeDefined();
    expect(attributesOf(span)).toEqual({
      [NoeticAttr.LAYER_ID]: 'notes',
      [NoeticAttr.LAYER_HOOK]: 'init',
      [NoeticAttr.LAYER_STATUS]: 'ok',
    });
    expect(root.events.filter((e) => e.name === NoeticEvent.LAYER_HOOK)).toHaveLength(0);
  });

  it("stamps a recall's budget and item count", async () => {
    const { ctx, exporter } = tracedExecCtx();

    await recallLayers({
      layers: [
        layer('items', {
          recall: async () => ({
            items: [
              createMessage('a', 'developer'),
            ],
            tokenCount: 30,
          }),
        }),
      ],
      query: '',
      ctx,
      log: makeItemLog(),
      budgets: new Map([
        [
          'items',
          100,
        ],
      ]),
      store: createLayerStateStore(),
    });

    const [span] = hookSpans(exporter);
    assert(span);
    expect(attributesOf(span)).toEqual({
      [NoeticAttr.LAYER_ID]: 'items',
      [NoeticAttr.LAYER_HOOK]: 'recall',
      [NoeticAttr.LAYER_STATUS]: 'ok',
      [NoeticAttr.LAYER_ITEM_COUNT]: 1,
      [NoeticAttr.LAYER_BUDGET_ALLOCATED]: 100,
      [NoeticAttr.LAYER_BUDGET_USED]: 30,
      [NoeticAttr.LAYER_BUDGET_YIELDED]: 70,
    });
  });

  it('ends a thrown or timed-out hook with error attributes', async () => {
    const { ctx, exporter } = tracedExecCtx();

    await recallLayers({
      layers: [
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
      ],
      query: '',
      ctx,
      log: makeItemLog(),
      budgets: new Map(),
      store: createLayerStateStore(() => {}),
    });

    const spans = hookSpans(exporter);
    for (const span of spans) {
      expect(span.endTime).toBeDefined();
    }
    expect(spans.map(attributesOf)).toEqual([
      {
        [NoeticAttr.LAYER_ID]: 'boom',
        [NoeticAttr.LAYER_HOOK]: 'recall',
        [NoeticAttr.LAYER_STATUS]: 'error',
        error: true,
        'error.message': 'recall broke',
      },
      {
        [NoeticAttr.LAYER_ID]: 'slow',
        [NoeticAttr.LAYER_HOOK]: 'recall',
        [NoeticAttr.LAYER_STATUS]: 'timeout',
        error: true,
        'error.message': 'Timeout after 5ms',
      },
    ]);
  });

  it('traces onDecision, beforeToolCall, afterModelCall, projectHistory, and onItemAppend', async () => {
    const { ctx, root, exporter } = tracedExecCtx();

    await runSteeringHooks(
      [
        layer('gate', STEERING_HOOKS),
      ],
      ctx,
      createLayerStateStore(),
    );

    const spans = hookSpans(exporter);
    expect(spans.map((s) => s.attributes.get(NoeticAttr.LAYER_HOOK))).toEqual(STEERING_HOOK_NAMES);
    for (const span of spans) {
      expect(span.parentSpanId).toBe(root.spanId);
      expect(span.attributes.get(NoeticAttr.LAYER_STATUS)).toBe('ok');
    }
  });

  it('records a disabled layer as a skipped span for each newly traced hook', async () => {
    const { ctx, exporter } = tracedExecCtx();
    const store = createLayerStateStore(() => {});
    const layers = [
      layer(
        'flaky',
        {
          init: async () => {
            throw new Error('no backend');
          },
          ...STEERING_HOOKS,
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
    exporter.clear();

    await runSteeringHooks(layers, ctx, store);

    const spans = hookSpans(exporter);
    expect(spans.map((s) => s.attributes.get(NoeticAttr.LAYER_HOOK))).toEqual(STEERING_HOOK_NAMES);
    for (const span of spans) {
      expect(span.attributes.get(NoeticAttr.LAYER_STATUS)).toBe('skipped');
    }
  });

  it('fails a gating beforeToolCall closed and records the error', async () => {
    const { ctx, exporter } = tracedExecCtx();

    const decision = await beforeToolCallLayers({
      layers: [
        layer(
          'gate',
          {
            beforeToolCall: async () => {
              throw new Error('policy offline');
            },
          },
          {
            onBeforeToolCallError: 'deny',
          },
        ),
      ],
      toolName: 'shell',
      toolArgs: {},
      ctx,
      store: createLayerStateStore(() => {}),
    });

    expect(decision.action).toBe(SteeringAction.Deny);
    const [span] = hookSpans(exporter);
    assert(span);
    expect(span.attributes.get(NoeticAttr.LAYER_STATUS)).toBe('error');
    expect(span.attributes.get('error.message')).toBe('policy offline');
  });

  it('falls back to a layer.hook event without createSpan', async () => {
    const events: Attributes[] = [];
    const ctx = makeCtx({
      trace: {
        setAttribute() {},
        addEvent(name, attributes) {
          if (name === NoeticEvent.LAYER_HOOK && attributes) {
            events.push(attributes);
          }
        },
      },
    });

    await runSteeringHooks(
      [
        layer('gate', STEERING_HOOKS),
      ],
      ctx,
      createLayerStateStore(),
    );

    expect(events.map(({ duration, ...rest }) => rest)).toEqual(
      STEERING_HOOK_NAMES.map((hook) => ({
        layerId: 'gate',
        hook,
        status: 'ok',
      })),
    );
  });
});
