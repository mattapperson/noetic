import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { MemoryLayer } from '@noetic-tools/memory';
import {
  afterModelCallLayers,
  beforeToolCallLayers,
  createLayerStateStore,
  initLayers,
  steering,
} from '@noetic-tools/memory';
import type { SteeringConfig, SteeringRule, SteeringState } from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError, SteeringAction } from '@noetic-tools/types';
import { makeCtx, makeLLMResponse, makeStorage } from '../_helpers';

/** Create a steering layer cast to MemoryLayer for use in lifecycle functions. */
function createSteeringLayer(config: SteeringConfig): MemoryLayer {
  return frameworkCast<MemoryLayer>(steering(config));
}

function denyToolRule(toolName: string): SteeringRule {
  return {
    id: `deny-${toolName}`,
    name: `Deny ${toolName}`,
    appliesTo: [
      'beforeToolCall',
    ],
    predicate: (params) => {
      if ('toolName' in params && params.toolName === toolName) {
        return {
          action: SteeringAction.Deny,
          guidance: `Tool '${toolName}' is not allowed`,
        };
      }
      return {
        action: SteeringAction.Allow,
      };
    },
  };
}

function allowAllRule(): SteeringRule {
  return {
    id: 'allow-all',
    name: 'Allow all',
    appliesTo: [
      'beforeToolCall',
      'afterModelCall',
    ],
    predicate: () => ({
      action: SteeringAction.Allow,
    }),
  };
}

function guideToolRule(toolName: string, guidance: string): SteeringRule {
  return {
    id: `guide-${toolName}`,
    name: `Guide ${toolName}`,
    appliesTo: [
      'beforeToolCall',
    ],
    predicate: (params) => {
      if ('toolName' in params && params.toolName === toolName) {
        return {
          action: SteeringAction.Guide,
          guidance,
        };
      }
      return {
        action: SteeringAction.Allow,
      };
    },
  };
}

function denyModelRule(): SteeringRule {
  return {
    id: 'deny-model',
    name: 'Deny model',
    appliesTo: [
      'afterModelCall',
    ],
    predicate: () => ({
      action: SteeringAction.Deny,
      guidance: 'Model output rejected',
    }),
  };
}

function guideModelRule(guidance: string): SteeringRule {
  return {
    id: 'guide-model',
    name: 'Guide model',
    appliesTo: [
      'afterModelCall',
    ],
    predicate: () => ({
      action: SteeringAction.Guide,
      guidance,
    }),
  };
}

interface SteeringSetup {
  layer: MemoryLayer;
  store: ReturnType<typeof createLayerStateStore>;
}

async function setupSteering(config: SteeringConfig): Promise<SteeringSetup> {
  const layer = createSteeringLayer(config);
  const store = createLayerStateStore();
  const ctx = makeCtx();
  await initLayers({
    layers: [
      layer,
    ],
    ctx,
    storage: makeStorage(),
    store,
  });
  return {
    layer,
    store,
  };
}

describe('steering layer', () => {
  describe('programmatic rules', () => {
    it('denies tool call when rule matches', async () => {
      const { layer, store } = await setupSteering({
        rules: [
          denyToolRule('dangerous-tool'),
        ],
      });
      const ctx = makeCtx();

      const decision = await beforeToolCallLayers({
        layers: [
          layer,
        ],
        toolName: 'dangerous-tool',
        toolArgs: {},
        ctx,
        store,
      });

      expect(decision.action).toBe(SteeringAction.Deny);
      expect(decision.guidance).toBe("Tool 'dangerous-tool' is not allowed");
    });

    it('allows tool call when rule does not match', async () => {
      const { layer, store } = await setupSteering({
        rules: [
          denyToolRule('dangerous-tool'),
        ],
      });
      const ctx = makeCtx();

      const decision = await beforeToolCallLayers({
        layers: [
          layer,
        ],
        toolName: 'safe-tool',
        toolArgs: {},
        ctx,
        store,
      });

      expect(decision.action).toBe(SteeringAction.Allow);
    });

    it('most restrictive wins — deny beats guide', async () => {
      const rules = [
        guideToolRule('multi-tool', 'Try a different approach'),
        denyToolRule('multi-tool'),
      ];
      const { layer, store } = await setupSteering({
        rules,
      });
      const ctx = makeCtx();

      const decision = await beforeToolCallLayers({
        layers: [
          layer,
        ],
        toolName: 'multi-tool',
        toolArgs: {},
        ctx,
        store,
      });

      expect(decision.action).toBe(SteeringAction.Deny);
    });

    it('guide action returns guidance text', async () => {
      const { layer, store } = await setupSteering({
        rules: [
          guideToolRule('my-tool', 'Use parameter X instead'),
        ],
      });
      const ctx = makeCtx();

      const decision = await beforeToolCallLayers({
        layers: [
          layer,
        ],
        toolName: 'my-tool',
        toolArgs: {},
        ctx,
        store,
      });

      expect(decision.action).toBe(SteeringAction.Guide);
      expect(decision.guidance).toBe('Use parameter X instead');
    });

    it('afterModelCall deny works', async () => {
      const { layer, store } = await setupSteering({
        rules: [
          denyModelRule(),
        ],
      });
      const ctx = makeCtx();
      const response = makeLLMResponse('Hello');

      const decision = await afterModelCallLayers({
        layers: [
          layer,
        ],
        response,
        ctx,
        store,
      });

      expect(decision.action).toBe(SteeringAction.Deny);
      expect(decision.guidance).toBe('Model output rejected');
    });

    it('afterModelCall guide works', async () => {
      const { layer, store } = await setupSteering({
        rules: [
          guideModelRule('Be more specific'),
        ],
      });
      const ctx = makeCtx();
      const response = makeLLMResponse('vague answer');

      const decision = await afterModelCallLayers({
        layers: [
          layer,
        ],
        response,
        ctx,
        store,
      });

      expect(decision.action).toBe(SteeringAction.Guide);
      expect(decision.guidance).toBe('Be more specific');
    });
  });

  describe('ledger', () => {
    it('records tool call entries in ledger', async () => {
      const rules = [
        allowAllRule(),
      ];
      const { layer, store } = await setupSteering({
        rules,
      });
      const ctx = makeCtx();

      await beforeToolCallLayers({
        layers: [
          layer,
        ],
        toolName: 'test-tool',
        toolArgs: {
          query: 'hello',
        },
        ctx,
        store,
      });

      const state = store.get<SteeringState>(ctx.executionId, 'steering');
      expect(state).toBeDefined();
      assert(state);
      expect(state.ledger.length).toBe(1);
      expect(state.ledger[0].kind).toBe('tool_call');
      expect(state.ledger[0].toolName).toBe('test-tool');
    });

    it('records model turn entries in ledger', async () => {
      const rules = [
        allowAllRule(),
      ];
      const { layer, store } = await setupSteering({
        rules,
      });
      const ctx = makeCtx();
      const response = makeLLMResponse('hi');

      await afterModelCallLayers({
        layers: [
          layer,
        ],
        response,
        ctx,
        store,
      });

      const state = store.get<SteeringState>(ctx.executionId, 'steering');
      expect(state).toBeDefined();
      assert(state);
      expect(state.ledger.length).toBe(1);
      expect(state.ledger[0].kind).toBe('model_turn');
    });

    it('trims ledger at maxLedgerEntries', async () => {
      const rules = [
        allowAllRule(),
      ];
      const layer = createSteeringLayer({
        rules,
        maxLedgerEntries: 3,
      });
      const store = createLayerStateStore();
      const ctx = makeCtx();
      await initLayers({
        layers: [
          layer,
        ],
        ctx,
        storage: makeStorage(),
        store,
      });

      // Add 5 entries
      for (let i = 0; i < 5; i++) {
        await beforeToolCallLayers({
          layers: [
            layer,
          ],
          toolName: `tool-${i}`,
          toolArgs: {},
          ctx,
          store,
        });
      }

      const state = store.get<SteeringState>(ctx.executionId, 'steering');
      expect(state).toBeDefined();
      assert(state);
      expect(state.ledger.length).toBe(3);
      // Should keep the last 3
      expect(state.ledger[0].toolName).toBe('tool-2');
      expect(state.ledger[1].toolName).toBe('tool-3');
      expect(state.ledger[2].toolName).toBe('tool-4');
    });
  });

  describe('hooks', () => {
    it('init creates empty state', async () => {
      const layer = createSteeringLayer({
        rules: [],
      });
      const store = createLayerStateStore();
      const ctx = makeCtx();
      await initLayers({
        layers: [
          layer,
        ],
        ctx,
        storage: makeStorage(),
        store,
      });

      const state = store.get<SteeringState>(ctx.executionId, 'steering');
      expect(state).toBeDefined();
      assert(state);
      expect(state.ledger).toEqual([]);
      expect(state.pendingAsync).toEqual([]);
    });

    it('recall returns null when no pending async results', async () => {
      const layer = createSteeringLayer({
        rules: [],
      });
      const result = await layer.hooks.recall?.({
        log: {
          items: [],
          append() {},
        },
        query: '',
        ctx: makeCtx(),
        state: {
          ledger: [],
          pendingAsync: [],
        },
        budget: 500,
      });

      expect(result).toBeNull();
    });

    it('recall injects pending async results as steering_feedback', async () => {
      const layer = createSteeringLayer({
        rules: [],
      });
      const state = {
        ledger: [],
        pendingAsync: [
          {
            ruleId: 'rule-1',
            guidance: 'Do not use PII',
          },
        ],
      };

      const result = await layer.hooks.recall?.({
        log: {
          items: [],
          append() {},
        },
        query: '',
        ctx: makeCtx(),
        state,
        budget: 500,
      });

      assert(result);
      assert(typeof result !== 'string');
      expect(result.items.length).toBe(1);
      assert(result.items[0].type === 'message');
      const text = result.items[0].content
        .filter(
          (c: {
            type: string;
          }): c is {
            type: 'input_text';
            text: string;
          } => c.type === 'input_text' && 'text' in c,
        )
        .map((c: { text: string }) => c.text)
        .join('');
      expect(text).toContain('steering_feedback');
      expect(text).toContain('rule-1');
      expect(text).toContain('Do not use PII');

      // pendingAsync should be cleared
      expect(state.pendingAsync).toEqual([]);
    });

    it('onSpawn clones ledger without pendingAsync', async () => {
      const layer = steering({
        rules: [],
      });
      const parentState = {
        ledger: [
          {
            kind: 'tool_call' as const,
            timestamp: Date.now(),
            toolName: 'test',
          },
        ],
        pendingAsync: [
          {
            ruleId: 'r1',
            guidance: 'something',
          },
        ],
      };

      const result = await layer.hooks.onSpawn?.({
        parentState,
        childCtx: makeCtx({
          executionId: 'child-1',
        }),
      });

      assert(result);
      assert(result.childState);
      expect(result.childState.ledger.length).toBe(1);
      expect(result.childState.pendingAsync).toEqual([]);
      // Verify deep clone
      result.childState.ledger.push({
        kind: 'custom' as const,
        timestamp: Date.now(),
      });
      expect(parentState.ledger.length).toBe(1);
    });
  });
});

describe('layer-lifecycle steering functions', () => {
  it('beforeToolCallLayers short-circuits on deny', async () => {
    const order: string[] = [];
    const layers: MemoryLayer[] = [
      createSteeringLayer({
        rules: [
          {
            id: 'deny-first',
            appliesTo: [
              'beforeToolCall',
            ],
            predicate: () => {
              order.push('deny');
              return {
                action: SteeringAction.Deny,
                guidance: 'blocked',
              };
            },
          },
        ],
      }),
      {
        id: 'second-layer',
        slot: 200,
        scope: 'execution',
        hooks: {
          async init() {
            return {
              state: {},
            };
          },
          async beforeToolCall() {
            order.push('second');
            return {
              decision: {
                action: SteeringAction.Allow,
              },
              state: {},
            };
          },
        },
      },
    ];

    const store = createLayerStateStore();
    const ctx = makeCtx();
    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });

    const decision = await beforeToolCallLayers({
      layers,
      toolName: 'test',
      toolArgs: {},
      ctx,
      store,
    });

    expect(decision.action).toBe(SteeringAction.Deny);
    expect(order).toEqual([
      'deny',
    ]);
  });

  it('afterModelCallLayers collects guidance from multiple layers', async () => {
    const layers: MemoryLayer[] = [
      createSteeringLayer({
        rules: [
          guideModelRule('Hint A'),
        ],
      }),
      {
        id: 'guide-layer-2',
        slot: 200,
        scope: 'execution',
        hooks: {
          async init() {
            return {
              state: {},
            };
          },
          async afterModelCall() {
            return {
              decision: {
                action: SteeringAction.Guide,
                guidance: 'Hint B',
              },
              state: {},
            };
          },
        },
      },
    ];
    const store = createLayerStateStore();
    const ctx = makeCtx();
    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });

    const decision = await afterModelCallLayers({
      layers,
      response: makeLLMResponse('test'),
      ctx,
      store,
    });

    expect(decision.action).toBe(SteeringAction.Guide);
    // Both guidances combined
    expect(decision.guidance).toContain('Hint');
  });

  it('layers without steering hooks are skipped', async () => {
    const layer: MemoryLayer = {
      id: 'plain-layer',
      slot: 100,
      scope: 'execution',
      hooks: {
        async init() {
          return {
            state: {},
          };
        },
        async recall() {
          return null;
        },
      },
    };

    const store = createLayerStateStore();
    const ctx = makeCtx();
    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage: makeStorage(),
      store,
    });

    const decision = await beforeToolCallLayers({
      layers: [
        layer,
      ],
      toolName: 'test',
      toolArgs: {},
      ctx,
      store,
    });

    expect(decision.action).toBe(SteeringAction.Allow);
  });
});

describe('LLM-evaluated rules without callModel', () => {
  it('throws NoeticConfigError when sync LLM rule has no callModel', async () => {
    const rule: SteeringRule = {
      id: 'llm-sync',
      name: 'LLM sync rule',
      appliesTo: [
        'beforeToolCall',
      ],
      llmEval: {
        mode: 'sync',
        prompt: 'Is this safe?',
      },
    };
    const { layer, store } = await setupSteering({
      rules: [
        rule,
      ],
    });
    const ctx = makeCtx(); // no callModel

    try {
      await beforeToolCallLayers({
        layers: [
          layer,
        ],
        toolName: 'test-tool',
        toolArgs: {},
        ctx,
        store,
      });
      throw new Error('Expected NoeticConfigError');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('MISSING_CALL_MODEL');
    }
  });

  it('throws NoeticConfigError for afterModelCall LLM rule without callModel', async () => {
    const rule: SteeringRule = {
      id: 'llm-after',
      name: 'LLM after rule',
      appliesTo: [
        'afterModelCall',
      ],
      llmEval: {
        mode: 'sync',
        prompt: 'Was this appropriate?',
      },
    };
    const { layer, store } = await setupSteering({
      rules: [
        rule,
      ],
    });
    const ctx = makeCtx();

    try {
      await afterModelCallLayers({
        layers: [
          layer,
        ],
        response: makeLLMResponse('test'),
        ctx,
        store,
      });
      throw new Error('Expected NoeticConfigError');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('MISSING_CALL_MODEL');
    }
  });

  it('programmatic rules still work without callModel', async () => {
    const { layer, store } = await setupSteering({
      rules: [
        denyToolRule('blocked'),
      ],
    });
    const ctx = makeCtx(); // no callModel — but rule is programmatic

    const decision = await beforeToolCallLayers({
      layers: [
        layer,
      ],
      toolName: 'blocked',
      toolArgs: {},
      ctx,
      store,
    });

    expect(decision.action).toBe(SteeringAction.Deny);
  });
});
