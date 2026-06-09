import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { DurableTaskState } from '@noetic-tools/memory';
import {
  beforeToolCallLayers,
  createLayerStateStore,
  durableTaskState,
  initLayers,
  mostRestrictive,
  steering,
  storeLayers,
} from '@noetic-tools/memory';
import type { MemoryLayer, SteeringConfig, SteeringRule } from '@noetic-tools/types';
import { frameworkCast, SteeringAction } from '@noetic-tools/types';
import { makeCtx, makeItemLog, makeLLMResponse, makeStorage } from '../../_helpers';

function asLayer(layer: unknown): MemoryLayer {
  return frameworkCast<MemoryLayer>(layer);
}

function steeringLayer(config: SteeringConfig): MemoryLayer {
  return asLayer(steering(config));
}

// ── Steering helpers ──────────────────────────────────────────────────

/** A Guide rule that DOES carry guidance text. */
function guideWithText(toolName: string, guidance: string): SteeringRule {
  return {
    id: `guide-text-${toolName}`,
    appliesTo: [
      'beforeToolCall',
    ],
    predicate: (params) =>
      'toolName' in params && params.toolName === toolName
        ? {
            action: SteeringAction.Guide,
            guidance,
          }
        : {
            action: SteeringAction.Allow,
          },
  };
}

/** A Guide rule that carries NO guidance text (guidance is optional in the type). */
function guideNoText(toolName: string): SteeringRule {
  return {
    id: `guide-empty-${toolName}`,
    appliesTo: [
      'beforeToolCall',
    ],
    predicate: (params) =>
      'toolName' in params && params.toolName === toolName
        ? {
            action: SteeringAction.Guide,
          }
        : {
            action: SteeringAction.Allow,
          },
  };
}

describe('AUDIT: steering — mostRestrictive guidance aggregation', () => {
  it('preserves a single guidance string when a later guidance-less Guide follows', () => {
    // Contract: multiple Guides concatenate; a Guide carrying text must never be
    // silently dropped just because another Guide has no text.
    const decision = mostRestrictive([
      {
        action: SteeringAction.Guide,
        guidance: 'Use parameter X',
      },
      {
        action: SteeringAction.Guide,
      },
    ]);
    expect(decision.action).toBe(SteeringAction.Guide);
    expect(decision.guidance).toBe('Use parameter X');
  });

  it('surfaces guidance through the steering layer when two Guide rules apply (one empty)', async () => {
    const layer = steeringLayer({
      rules: [
        guideWithText('writer', 'Prefer the safe API'),
        guideNoText('writer'),
      ],
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

    const decision = await beforeToolCallLayers({
      layers: [
        layer,
      ],
      toolName: 'writer',
      toolArgs: {},
      ctx,
      store,
    });

    expect(decision.action).toBe(SteeringAction.Guide);
    expect(decision.guidance).toBe('Prefer the safe API');
  });
});

describe('AUDIT: steering — LLM-evaluated rule guidance fidelity', () => {
  it('does not mangle the casing of LLM-produced GUIDE guidance', async () => {
    const rule: SteeringRule = {
      id: 'llm-guide',
      appliesTo: [
        'beforeToolCall',
      ],
      llmEval: {
        mode: 'sync',
        prompt: 'Evaluate the call',
      },
    };
    const layer = steeringLayer({
      rules: [
        rule,
      ],
    });
    const store = createLayerStateStore();
    const ctx = makeCtx({
      callModel: async () => makeLLMResponse('GUIDE: please Use the Safe path'),
    });
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
      toolName: 'anything',
      toolArgs: {},
      ctx,
      store,
    });

    expect(decision.action).toBe(SteeringAction.Guide);
    // The guidance text should be preserved verbatim, not upper-cased.
    expect(decision.guidance).toBe('please Use the Safe path');
  });
});

describe('AUDIT: steering — maxRetries config', () => {
  it('retries an LLM rule on unparseable output up to maxRetries', async () => {
    let calls = 0;
    const rule: SteeringRule = {
      id: 'llm-retry',
      appliesTo: [
        'beforeToolCall',
      ],
      llmEval: {
        mode: 'sync',
        prompt: 'Evaluate',
      },
    };
    const layer = steeringLayer({
      rules: [
        rule,
      ],
      maxRetries: 2,
    });
    const store = createLayerStateStore();
    const ctx = makeCtx({
      callModel: async () => {
        calls += 1;
        return makeLLMResponse('this is not a valid verdict');
      },
    });
    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage: makeStorage(),
      store,
    });

    await beforeToolCallLayers({
      layers: [
        layer,
      ],
      toolName: 'anything',
      toolArgs: {},
      ctx,
      store,
    });

    // maxRetries: 2 → at least one retry beyond the first attempt.
    expect(calls).toBeGreaterThan(1);
  });
});

describe('AUDIT: durableTaskState — durability across executions', () => {
  it('rehydrates persisted task state in a fresh execution', async () => {
    const storage = makeStorage();
    const layers = [
      asLayer(durableTaskState()),
    ];

    // ── Execution A: init, store a checkpoint ──
    const storeA = createLayerStateStore();
    const ctxA = makeCtx({
      executionId: 'exec-A',
    });
    await initLayers({
      layers,
      ctx: ctxA,
      storage,
      store: storeA,
    });
    await storeLayers({
      layers,
      response: makeLLMResponse('did work'),
      ctx: ctxA,
      log: makeItemLog(),
      store: storeA,
      storage,
    });

    const stateA = storeA.get<DurableTaskState>(ctxA.executionId, 'durable-task-state');
    assert(stateA);
    expect(stateA.checkpoints.length).toBeGreaterThan(0);

    // ── Execution B: fresh execution, same durable storage ──
    const storeB = createLayerStateStore();
    const ctxB = makeCtx({
      executionId: 'exec-B',
    });
    await initLayers({
      layers,
      ctx: ctxB,
      storage,
      store: storeB,
    });

    const stateB = storeB.get<DurableTaskState>(ctxB.executionId, 'durable-task-state');
    assert(stateB);
    // The whole point of a "durable" task-state layer: prior checkpoints survive.
    expect(stateB.checkpoints.length).toBeGreaterThan(0);
  });
});
