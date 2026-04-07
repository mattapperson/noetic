/**
 * Adversarial tests for the Noetic memory layer system.
 *
 * Each test targets a specific suspected bug or edge case discovered
 * during code review. Tests that document confirmed bugs are marked
 * with "[BUG]" in the description.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { allocateBudgets } from '../../src/memory/budget';
import { findFunctionCall } from '../../src/memory/function-call-utils';
import {
  createLayerStateStore,
  disposeLayers,
  initLayers,
  recallLayers,
  storeLayers,
} from '../../src/memory/layer-lifecycle';
import type { DurableTaskState } from '../../src/memory/layers/durable-task-state';
import { durableTaskState } from '../../src/memory/layers/durable-task-state';
import type { ObservationalState } from '../../src/memory/layers/observational-memory';
import { observationalMemory } from '../../src/memory/layers/observational-memory';
import { steering } from '../../src/memory/layers/steering';
import type { WorkingMemoryState } from '../../src/memory/layers/working-memory';
import { workingMemory } from '../../src/memory/layers/working-memory';
import type { LLMResponse } from '../../src/types/common';
import type { Item } from '../../src/types/items';
import type { ExecutionContext, MemoryLayer } from '../../src/types/memory';
import type { SteeringState } from '../../src/types/steering';
import { SteeringAction } from '../../src/types/steering';
import {
  assistantMessage,
  isRecord,
  makeCtx,
  makeFunctionCall,
  makeItemLog,
  makeLLMResponse,
  makeStorage,
} from '../_helpers';

//#region Helpers

function isCheckpointState(val: unknown): val is {
  checkpoints: Array<{
    depth: number;
  }>;
} {
  if (!isRecord(val)) {
    return false;
  }
  return Array.isArray(val.checkpoints);
}

function isObservationalState(val: unknown): val is {
  observations: string[];
} {
  if (!isRecord(val)) {
    return false;
  }
  return Array.isArray(val.observations);
}

/** Helper to safely get state from store, asserting it exists */
function getState<T>(
  store: ReturnType<typeof createLayerStateStore>,
  executionId: string,
  layerId: string,
): T {
  const state = store.get<T>(executionId, layerId);
  if (state === undefined) {
    throw new Error(`State not found for layer ${layerId} in execution ${executionId}`);
  }
  return state;
}

/** Helper for tests that intentionally pass invalid state to document bug behavior */
function invalidState<T>(state: unknown): T {
  // Use JSON parse/stringify to create a new reference with different typing
  // This allows tests to intentionally pass wrong types for edge case testing
  return JSON.parse(JSON.stringify(state));
}

/** Creates an ExecutionContext whose callModel always returns a fixed text response. */
function makeCtxWithCallModel(
  text: string,
  overrides?: Partial<ExecutionContext>,
): ExecutionContext {
  return makeCtx({
    callModel: async () => makeLLMResponse(text),
    ...overrides,
  });
}

/** Creates an ExecutionContext whose callModel returns a promise that the caller resolves manually. */
function makeCtxWithSlowCallModel(overrides?: Partial<ExecutionContext>): {
  ctx: ExecutionContext;
  resolveAsync: {
    current: ((v: LLMResponse) => void) | null;
  };
} {
  const resolveAsync: {
    current: ((v: LLMResponse) => void) | null;
  } = {
    current: null,
  };
  const ctx = makeCtx({
    callModel: async () =>
      new Promise<LLMResponse>((resolve) => {
        resolveAsync.current = resolve;
      }),
    ...overrides,
  });
  return {
    ctx,
    resolveAsync,
  };
}

//#endregion

//#region Steering DENY Parsing

describe('Steering: DENY response parsing', () => {
  it('parses exact "DENY" without guidance', async () => {
    const layer = steering({
      rules: [
        {
          id: 'test-deny',
          appliesTo: [
            'beforeToolCall',
          ],
          llmEval: {
            mode: 'sync',
            prompt: 'Always deny.',
          },
        },
      ],
    });

    const store = createLayerStateStore();
    const ctx = makeCtxWithCallModel('DENY');
    const storage = makeStorage();

    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage,
      store,
    });

    const result = await layer.hooks.beforeToolCall!({
      toolName: 'test-tool',
      toolArgs: {},
      ctx,
      state: store.get<SteeringState>(ctx.executionId, layer.id)!,
    });

    expect(result.decision.action).toBe(SteeringAction.Deny);
    // slice(5) on "DENY" (4 chars) yields "" which becomes undefined via || undefined
    expect(result.decision.guidance).toBeUndefined();
  });

  it('parses "DENY:reason" correctly — colon at index 4 skipped by slice(5)', async () => {
    const layer = steering({
      rules: [
        {
          id: 'test-deny-colon',
          appliesTo: [
            'beforeToolCall',
          ],
          llmEval: {
            mode: 'sync',
            prompt: 'Deny with reason.',
          },
        },
      ],
    });

    const store = createLayerStateStore();
    const ctx = makeCtxWithCallModel('DENY:unsafe operation');
    const storage = makeStorage();

    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage,
      store,
    });

    const result = await layer.hooks.beforeToolCall!({
      toolName: 'test-tool',
      toolArgs: {},
      ctx,
      state: store.get<SteeringState>(ctx.executionId, layer.id)!,
    });

    expect(result.decision.action).toBe(SteeringAction.Deny);
    // "DENY:UNSAFE OPERATION" → slice(5) → "UNSAFE OPERATION" (colon at index 4 is skipped)
    expect(result.decision.guidance).toBe('UNSAFE OPERATION');
  });

  it('[BUG] "DENYALL" parsed as DENY with guidance "LL" — no word boundary check', async () => {
    const layer = steering({
      rules: [
        {
          id: 'test-deny-no-boundary',
          appliesTo: [
            'beforeToolCall',
          ],
          llmEval: {
            mode: 'sync',
            prompt: 'Test.',
          },
        },
      ],
    });

    const store = createLayerStateStore();
    const ctx = makeCtxWithCallModel('DENYALL');
    const storage = makeStorage();

    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage,
      store,
    });

    const result = await layer.hooks.beforeToolCall!({
      toolName: 'test-tool',
      toolArgs: {},
      ctx,
      state: store.get<SteeringState>(ctx.executionId, layer.id)!,
    });

    // BUG: "DENYALL" starts with "DENY" so it's parsed as Deny
    // slice(5) → "LL" becomes the guidance — clearly wrong
    expect(result.decision.action).toBe(SteeringAction.Deny);
    expect(result.decision.guidance).toBe('LL');
  });

  it('parses "DENY reason text" with space separator correctly', async () => {
    const layer = steering({
      rules: [
        {
          id: 'test-deny-space',
          appliesTo: [
            'beforeToolCall',
          ],
          llmEval: {
            mode: 'sync',
            prompt: 'Deny with reason.',
          },
        },
      ],
    });

    const store = createLayerStateStore();
    const ctx = makeCtxWithCallModel('DENY unsafe operation');
    const storage = makeStorage();

    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage,
      store,
    });

    const result = await layer.hooks.beforeToolCall!({
      toolName: 'test-tool',
      toolArgs: {},
      ctx,
      state: store.get<SteeringState>(ctx.executionId, layer.id)!,
    });

    expect(result.decision.action).toBe(SteeringAction.Deny);
    // Space-separated works: slice(5) on "DENY UNSAFE OPERATION" → "UNSAFE OPERATION"
    expect(result.decision.guidance).toBe('UNSAFE OPERATION');
  });

  it('parses "GUIDE:" with no space after colon', async () => {
    const layer = steering({
      rules: [
        {
          id: 'test-guide',
          appliesTo: [
            'beforeToolCall',
          ],
          llmEval: {
            mode: 'sync',
            prompt: 'Guide.',
          },
        },
      ],
    });

    const store = createLayerStateStore();
    const ctx = makeCtxWithCallModel('GUIDE:be careful');
    const storage = makeStorage();

    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage,
      store,
    });

    const result = await layer.hooks.beforeToolCall!({
      toolName: 'test-tool',
      toolArgs: {},
      ctx,
      state: store.get<SteeringState>(ctx.executionId, layer.id)!,
    });

    expect(result.decision.action).toBe(SteeringAction.Guide);
    // "GUIDE:BE CAREFUL" → slice(6) → "BE CAREFUL" — correct
    expect(result.decision.guidance).toBe('BE CAREFUL');
  });
});

//#endregion

//#region Steering Async Race Condition

describe('Steering: async pendingAsync race condition', () => {
  it('[BUG] recall replaces pendingAsync ref — late async push goes to orphaned array', async () => {
    const layer = steering({
      rules: [
        {
          id: 'async-rule',
          appliesTo: [
            'beforeToolCall',
          ],
          llmEval: {
            mode: 'async',
            prompt: 'Check safety.',
          },
        },
      ],
    });

    const { ctx, resolveAsync } = makeCtxWithSlowCallModel();
    const store = createLayerStateStore();
    const storage = makeStorage();

    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage,
      store,
    });

    const state = store.get<SteeringState>(ctx.executionId, layer.id)!;

    // Pre-seed pendingAsync so recall will drain it (replacing the array ref)
    state.pendingAsync.push({
      ruleId: 'seed',
      guidance: 'seeded feedback',
    });

    // Trigger beforeToolCall — fires async LLM eval (slow, unresolved)
    await layer.hooks.beforeToolCall!({
      toolName: 'test-tool',
      toolArgs: {},
      ctx,
      state,
    });

    // Capture reference to the array before recall drains it
    const oldArray = state.pendingAsync;

    // Recall drains pendingAsync — sets state.pendingAsync = [] (new ref)
    const recallResult = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx,
      state,
      budget: 500,
    });

    // Recall should have returned the seeded feedback
    expect(recallResult).not.toBeNull();
    // state.pendingAsync is now a NEW empty array
    expect(state.pendingAsync).not.toBe(oldArray);
    expect(state.pendingAsync.length).toBe(0);

    // Now the async rule resolves with DENY — pushes to the OLD array ref
    assert(resolveAsync.current !== null);
    resolveAsync.current({
      items: [
        {
          id: 'resp-1',
          status: 'completed',
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'DENY unsafe',
            },
          ],
        },
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
      },
    });

    // Yield multiple microtask ticks so the full .then() chain from fireLlmRuleAsync settles
    // (evaluateLlmRuleSync is async, so its .then() spawns further microtasks)
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    // BUG: The async push went to oldArray (orphaned ref), not state.pendingAsync
    // The DENY feedback is lost forever
    expect(oldArray.length).toBe(2); // seed + async push went here
    expect(state.pendingAsync.length).toBe(0); // new array is still empty

    // Second recall sees nothing — the DENY was lost
    const recallAfter = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx,
      state,
      budget: 500,
    });
    expect(recallAfter).toBeNull();
  });
});

//#endregion

//#region Working Memory Edge Cases

describe('Working Memory: falsy state edge cases', () => {
  it('treats empty string state as empty (returns null from recall)', async () => {
    const layer = workingMemory();
    const store = createLayerStateStore();
    const ctx = makeCtx();
    const storage = makeStorage();

    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage,
      store,
    });

    // State should default to '' (empty string)
    const state = store.get<WorkingMemoryState>(ctx.executionId, layer.id);
    expect(state).toBe('');

    const result = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx,
      state: getState<WorkingMemoryState>(store, ctx.executionId, layer.id),
      budget: 1e3,
    });

    // !'' is true, so null is returned — correct
    expect(result).toBeNull();
  });

  it('[BUG] numeric 0 state treated as empty due to !state check', async () => {
    const layer = workingMemory();
    const store = createLayerStateStore();
    const ctx = makeCtx();

    // Simulate storage corruption: state is numeric 0
    store.set(ctx.executionId, layer.id, invalidState<WorkingMemoryState>(0));

    const result = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx,
      state: invalidState<WorkingMemoryState>(0),
      budget: 1e3,
    });

    // BUG: !0 is true, so recall returns null even though 0 is valid state data
    expect(result).toBeNull();
  });

  it('[BUG] boolean false state treated as empty due to !state check', async () => {
    const layer = workingMemory();
    const store = createLayerStateStore();
    const ctx = makeCtx();

    store.set(ctx.executionId, layer.id, invalidState<WorkingMemoryState>(false));

    const result = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx,
      state: invalidState<WorkingMemoryState>(false),
      budget: 1e3,
    });

    // BUG: !false is true, so recall returns null
    expect(result).toBeNull();
  });
});

describe('Working Memory: prototype pollution', () => {
  it('strips top-level __proto__ from updateWorkingMemory args', async () => {
    const layer = workingMemory({
      schema: undefined,
    });
    const store = createLayerStateStore();
    const ctx = makeCtx();
    const storage = makeStorage();

    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage,
      store,
    });

    // Override state to be an object
    store.set(ctx.executionId, layer.id, {
      existing: 'value',
    });

    // Use raw JSON string — JSON.stringify loses __proto__ because it sets the prototype
    const args = '{"__proto__":{"polluted":true},"constructor":"evil","safe":"data"}';
    const items: Item[] = [
      makeFunctionCall('updateWorkingMemory', args),
    ];

    const result = await layer.hooks.store!({
      newItems: items,
      log: makeItemLog(),
      response: makeLLMResponse('test'),
      ctx,
      state: getState<WorkingMemoryState>(store, ctx.executionId, layer.id),
    });

    expect(result).toBeDefined();
    assert(result !== undefined);
    assert(isRecord(result.state));
    expect(result.state.safe).toBe('data');
    expect(result.state.existing).toBe('value');
    // Top-level __proto__ and constructor should be stripped by destructuring
    expect(Object.hasOwn(result.state, '__proto__')).toBe(false);
    expect(Object.hasOwn(result.state, 'constructor')).toBe(false);
  });

  it('nested __proto__ in values does not pollute prototype chain', async () => {
    const layer = workingMemory({
      schema: undefined,
    });
    const store = createLayerStateStore();
    const ctx = makeCtx();
    const storage = makeStorage();

    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage,
      store,
    });
    store.set(ctx.executionId, layer.id, {});

    // Use raw JSON to ensure __proto__ is a real key in parsed output
    const args = '{"nested":{"__proto__":{"polluted":true}}}';
    const items: Item[] = [
      makeFunctionCall('updateWorkingMemory', args),
    ];

    const result = await layer.hooks.store!({
      newItems: items,
      log: makeItemLog(),
      response: makeLLMResponse('test'),
      ctx,
      state: getState<WorkingMemoryState>(store, ctx.executionId, layer.id),
    });

    assert(result !== undefined);
    assert(isRecord(result.state));
    assert(isRecord(result.state.nested));
    // JSON.parse ignores __proto__ in modern engines — verify prototype is clean
    const proto = Object.getPrototypeOf(result.state);
    expect(proto).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(proto, 'polluted')).toBeUndefined();
  });
});

describe('Working Memory: store with string state', () => {
  it('[BUG] string state replaced entirely by updateWorkingMemory args object', async () => {
    const layer = workingMemory();
    const store = createLayerStateStore();
    const ctx = makeCtx();
    const storage = makeStorage();

    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage,
      store,
    });

    // Default state is '' (string). Set a non-empty string.
    store.set(ctx.executionId, layer.id, 'existing plan text');

    const args = JSON.stringify({
      step: 'analyze',
      progress: 50,
    });
    const items: Item[] = [
      makeFunctionCall('updateWorkingMemory', args),
    ];

    const result = await layer.hooks.store!({
      newItems: items,
      log: makeItemLog(),
      response: makeLLMResponse('test'),
      ctx,
      state: getState<WorkingMemoryState>(store, ctx.executionId, layer.id),
    });

    // When state is a string, typeof !== 'object', so the else branch runs:
    // return { state: safeArgs } — the entire string is lost and replaced
    expect(result).toBeDefined();
    assert(result !== undefined);
    const newState = result.state;
    expect(typeof newState).toBe('object');
    assert(isRecord(newState));
    expect(newState.step).toBe('analyze');
  });
});

//#endregion

//#region Observational Memory Edge Cases

describe('Observational Memory: empty buffer at threshold', () => {
  it('observer called when pre-existing bufferTokens cross threshold', async () => {
    let observerCalledWith: string[] | null = null;
    const layer = observationalMemory({
      bufferThreshold: 100,
      observer: async (buffer) => {
        observerCalledWith = buffer;
        return [
          'distilled',
        ];
      },
    });

    const store = createLayerStateStore();
    const ctx = makeCtx();
    const storage = makeStorage();

    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage,
      store,
    });

    // Manually set state with buffer tokens just below threshold
    store.set(ctx.executionId, layer.id, {
      observations: [],
      buffer: [
        'previous text',
      ],
      bufferTokens: 99,
      version: 0,
    });

    // Store with a tiny message to cross threshold
    const response = makeLLMResponse('x');

    await layer.hooks.store!({
      newItems: response.items,
      log: makeItemLog(),
      response,
      ctx,
      state: getState<ObservationalState>(store, ctx.executionId, layer.id),
    });

    // The observer should have been called since totalBufferTokens >= 100
    expect(observerCalledWith).not.toBeNull();
    expect(
      observerCalledWith !== null &&
        Array.isArray(observerCalledWith) &&
        observerCalledWith.length > 0,
    ).toBe(true);
  });

  it('default observer produces misleading "Processed 0 items" on empty buffer', async () => {
    const layer = observationalMemory({
      bufferThreshold: 0, // Always trigger compression
    });

    const store = createLayerStateStore();
    const ctx = makeCtx();
    const storage = makeStorage();

    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage,
      store,
    });

    // Store with items that have no output_text content (function call, not message)
    const items: Item[] = [
      {
        id: 'fc-1',
        type: 'function_call',
        status: 'completed',
        callId: 'call_1',
        name: 'test',
        arguments: '{}',
      },
    ];

    const result = await layer.hooks.store!({
      newItems: items,
      log: makeItemLog(),
      response: makeLLMResponse('test'),
      ctx,
      state: getState<ObservationalState>(store, ctx.executionId, layer.id),
    });

    // bufferTokens is 0, threshold is 0, so 0 >= 0 triggers compression
    // But newBuffer is empty (no message items) → default observer: "Processed 0 items"
    expect(result).toBeDefined();
    assert(result !== undefined);
    assert(isObservationalState(result.state));
    expect(result.state.observations).toContain('Processed 0 items');
  });
});

describe('Observational Memory: onSpawn ignores scope', () => {
  it('[BUG] thread-scoped layer still propagates state to child via onSpawn', async () => {
    const layer = observationalMemory({
      scope: 'thread',
    });

    // Verify scope is set to thread
    expect(layer.scope).toBe('thread');

    const parentState = {
      observations: [
        'parent observation',
      ],
      buffer: [
        'buffered text',
      ],
      bufferTokens: 50,
      version: 1,
    };

    const result = await layer.hooks.onSpawn!({
      parentState,
      childCtx: makeCtx({
        executionId: 'child-1',
      }),
    });

    // BUG: onSpawn ALWAYS clones regardless of scope.
    // Thread-scoped memory should NOT propagate to children in different threads.
    expect(result).not.toBeNull();
    assert(result !== null);
    expect(result.childState).toBeDefined();
    assert(isObservationalState(result.childState));
    expect(result.childState.observations).toEqual([
      'parent observation',
    ]);
  });
});

//#endregion

//#region Durable Task State: Depth Tracking

describe('Durable Task State: onComplete checkpoint depth', () => {
  it('[BUG] onComplete always records depth=0 regardless of actual depth', async () => {
    const layer = durableTaskState();
    const store = createLayerStateStore();
    const ctx = makeCtx({
      depth: 5,
    });
    const storage = makeStorage();

    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage,
      store,
    });

    const state = getState<DurableTaskState>(store, ctx.executionId, layer.id);
    const result = await layer.hooks.onComplete!({
      log: makeItemLog(),
      ctx,
      state,
      outcome: 'success',
    });

    expect(result).toBeDefined();
    assert(result !== undefined);
    assert(isCheckpointState(result.state));
    const lastCheckpoint = result.state.checkpoints[result.state.checkpoints.length - 1];

    // BUG: depth is hardcoded to 0 even though ctx.depth is 5
    expect(lastCheckpoint.depth).toBe(0);
    expect(lastCheckpoint.depth).not.toBe(5);
  });

  it('store hook correctly uses ctx.depth from execution context', async () => {
    const layer = durableTaskState();
    const store = createLayerStateStore();
    const ctx = makeCtx({
      depth: 3,
    });
    const storage = makeStorage();

    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage,
      store,
    });

    const result = await layer.hooks.store!({
      newItems: [],
      log: makeItemLog(),
      response: makeLLMResponse('test'),
      ctx,
      state: getState<DurableTaskState>(store, ctx.executionId, layer.id),
    });

    expect(result).toBeDefined();
    assert(result !== undefined);
    assert(isCheckpointState(result.state));
    const lastCheckpoint = result.state.checkpoints[result.state.checkpoints.length - 1];

    // Store hook correctly uses ctx.depth
    expect(lastCheckpoint.depth).toBe(3);
  });
});

//#endregion

//#region Budget Allocation Edge Cases

describe('Budget allocation: edge cases', () => {
  it('all-auto layers split pool equally', () => {
    const layers: MemoryLayer[] = [
      {
        id: 'a',
        slot: 100,
        scope: 'execution',
        budget: 'auto',
        hooks: {},
      },
      {
        id: 'b',
        slot: 200,
        scope: 'execution',
        budget: 'auto',
        hooks: {},
      },
      {
        id: 'c',
        slot: 300,
        scope: 'execution',
        budget: 'auto',
        hooks: {},
      },
    ];

    const result = allocateBudgets({
      layers,
      totalBudget: 1e4,
      systemPromptTokens: 1e3,
      responseReserve: 1e3,
    });

    const allocA = result.allocations.find((a) => a.layerId === 'a');
    const allocB = result.allocations.find((a) => a.layerId === 'b');
    const allocC = result.allocations.find((a) => a.layerId === 'c');

    expect(allocA!.allocated).toBe(1.6e3);
    expect(allocB!.allocated).toBe(1.6e3);
    expect(allocC!.allocated).toBe(1.6e3);
    expect(result.historyBudget).toBe(3.2e3);
  });

  it('single layer with budget gets 60% of available', () => {
    const layers: MemoryLayer[] = [
      {
        id: 'only',
        slot: 100,
        scope: 'execution',
        budget: {
          min: 100,
          max: 5e3,
        },
        hooks: {},
      },
    ];

    const result = allocateBudgets({
      layers,
      totalBudget: 1e4,
      systemPromptTokens: 1e3,
      responseReserve: 1e3,
    });

    expect(result.allocations[0].allocated).toBe(4840);
  });

  it('zero total budget yields zero for all', () => {
    const layers: MemoryLayer[] = [
      {
        id: 'a',
        slot: 100,
        scope: 'execution',
        budget: {
          min: 500,
          max: 2e3,
        },
        hooks: {},
      },
    ];

    const result = allocateBudgets({
      layers,
      totalBudget: 0,
      systemPromptTokens: 0,
      responseReserve: 0,
    });

    expect(result.allocations[0].allocated).toBe(0);
    expect(result.historyBudget).toBe(0);
  });

  it('mixed finite and infinite layers do not over-allocate', () => {
    const layers: MemoryLayer[] = [
      {
        id: 'finite',
        slot: 100,
        scope: 'execution',
        budget: {
          min: 0,
          max: 1e3,
        },
        hooks: {},
      },
      {
        id: 'infinite',
        slot: 200,
        scope: 'execution',
        budget: 'auto',
        hooks: {},
      },
    ];

    const result = allocateBudgets({
      layers,
      totalBudget: 1e4,
      systemPromptTokens: 1e3,
      responseReserve: 1e3,
    });

    const finiteAlloc = result.allocations.find((a) => a.layerId === 'finite');
    const infiniteAlloc = result.allocations.find((a) => a.layerId === 'infinite');

    expect(finiteAlloc!.allocated).toBeLessThanOrEqual(1e3);
    expect(infiniteAlloc!.allocated).toBeGreaterThan(0);

    // Total allocated to layers should not exceed layerPool (4800)
    const totalAllocated = result.allocations.reduce((sum, a) => sum + a.allocated, 0);
    expect(totalAllocated).toBeLessThanOrEqual(4.8e3);
  });
});

//#endregion

//#region Layer Lifecycle: Disabled Detection

describe('Layer lifecycle: disabled layer detection', () => {
  it('layer with init hook but undefined state is skipped in recall', async () => {
    const diagnostics: Array<{
      layerId: string;
      hook: string;
    }> = [];
    const store = createLayerStateStore((id, hook) => {
      diagnostics.push({
        layerId: id,
        hook,
      });
    });
    const ctx = makeCtx();

    // Create a layer whose init throws (simulating failure)
    const failingLayer: MemoryLayer = {
      id: 'failing',
      slot: 100,
      scope: 'execution',
      hooks: {
        init: async () => {
          throw new Error('init failed');
        },
        recall: async () => {
          return 'state: active';
        },
      },
    };

    const storage = makeStorage();
    await initLayers({
      layers: [
        failingLayer,
      ],
      ctx,
      storage,
      store,
    });

    // Init failed, so state is undefined
    expect(store.get(ctx.executionId, failingLayer.id)).toBeUndefined();

    // Recall should skip this layer
    const results = await recallLayers({
      layers: [
        failingLayer,
      ],
      query: '',
      ctx,
      log: makeItemLog(),
      budgets: new Map([
        [
          'failing',
          1e3,
        ],
      ]),
      store,
    });

    expect(results.length).toBe(0);
  });

  it('[BUG] layer that intentionally sets state to undefined is treated as disabled', async () => {
    const store = createLayerStateStore();
    const ctx = makeCtx();

    // Layer whose init intentionally returns undefined state
    const intentionalLayer: MemoryLayer = {
      id: 'intentional',
      slot: 100,
      scope: 'execution',
      hooks: {
        init: async () => {
          return {
            state: undefined,
          };
        },
        recall: async () => {
          return 'I am active with no data';
        },
      },
    };

    const storage = makeStorage();
    await initLayers({
      layers: [
        intentionalLayer,
      ],
      ctx,
      storage,
      store,
    });

    const results = await recallLayers({
      layers: [
        intentionalLayer,
      ],
      query: '',
      ctx,
      log: makeItemLog(),
      budgets: new Map([
        [
          'intentional',
          1e3,
        ],
      ]),
      store,
    });

    // BUG: recall skips this layer because state === undefined && hooks.init
    expect(results.length).toBe(0);
  });

  it('layer WITHOUT init hook and undefined state is NOT skipped', async () => {
    const store = createLayerStateStore();
    const ctx = makeCtx();

    const noInitLayer: MemoryLayer = {
      id: 'no-init',
      slot: 100,
      scope: 'execution',
      hooks: {
        recall: async () => {
          return 'I have no init';
        },
      },
    };

    const results = await recallLayers({
      layers: [
        noInitLayer,
      ],
      query: '',
      ctx,
      log: makeItemLog(),
      budgets: new Map([
        [
          'no-init',
          1e3,
        ],
      ]),
      store,
    });

    // No init hook → state undefined is NOT treated as disabled
    expect(results.length).toBe(1);
  });
});

//#endregion

//#region Cross-Layer Full Lifecycle

describe('Cross-layer full lifecycle', () => {
  it('init->recall->store->recall->dispose with working memory + observational', async () => {
    const wm = workingMemory({
      scope: 'resource',
    });
    const obs = observationalMemory({
      bufferThreshold: 10,
    });
    const layers = [
      wm,
      obs,
    ];

    const store = createLayerStateStore();
    const ctx = makeCtx();
    const storage = makeStorage();
    const log = makeItemLog();

    // 1. Init all layers
    await initLayers({
      layers,
      ctx,
      storage,
      store,
    });

    expect(store.get(ctx.executionId, wm.id)).toBeDefined();
    expect(store.get(ctx.executionId, obs.id)).toBeDefined();

    // 2. Recall (both empty initially)
    const budgets = new Map([
      [
        wm.id,
        1000,
      ],
      [
        obs.id,
        1000,
      ],
    ]);
    const recall1 = await recallLayers({
      layers,
      query: '',
      ctx,
      log,
      budgets,
      store,
    });
    expect(recall1.length).toBe(0);

    // 3. Store: working memory update + observational text
    const updateCall = makeFunctionCall(
      'updateWorkingMemory',
      JSON.stringify({
        plan: 'step 1',
        status: 'in-progress',
      }),
    );
    const response1 = makeLLMResponse('I am analyzing the problem.', {
      items: [
        updateCall,
        assistantMessage('I am analyzing the problem.'),
      ],
    });

    await storeLayers({
      layers,
      response: response1,
      ctx,
      log,
      store,
    });

    // 4. Recall again — working memory should have data
    const recall2 = await recallLayers({
      layers,
      query: '',
      ctx,
      log,
      budgets,
      store,
    });

    const wmResult = recall2.find((r) => r.layerId === wm.id);
    expect(wmResult).toBeDefined();
    assert(wmResult !== undefined);
    expect(wmResult.items.length).toBeGreaterThan(0);

    // 5. Dispose all layers
    await disposeLayers({
      layers,
      ctx,
      store,
    });

    expect(store.get(ctx.executionId, wm.id)).toBeUndefined();
    expect(store.get(ctx.executionId, obs.id)).toBeUndefined();
  });
});

//#endregion

//#region Function Call Utils Edge Cases

describe('findFunctionCall edge cases', () => {
  it('returns null for array arguments', () => {
    const items: Item[] = [
      makeFunctionCall('myFunc', '[1, 2, 3]'),
    ];
    expect(findFunctionCall(items, 'myFunc')).toBeNull();
  });

  it('returns null for string arguments', () => {
    const items: Item[] = [
      makeFunctionCall('myFunc', '"hello"'),
    ];
    expect(findFunctionCall(items, 'myFunc')).toBeNull();
  });

  it('returns null for null arguments', () => {
    const items: Item[] = [
      makeFunctionCall('myFunc', 'null'),
    ];
    expect(findFunctionCall(items, 'myFunc')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    const items: Item[] = [
      makeFunctionCall('myFunc', '{invalid}'),
    ];
    expect(findFunctionCall(items, 'myFunc')).toBeNull();
  });

  it('returns first matching function call', () => {
    const items: Item[] = [
      makeFunctionCall('myFunc', '{"a": 1}', 'fc-1'),
      makeFunctionCall('myFunc', '{"b": 2}', 'fc-2'),
    ];
    expect(findFunctionCall(items, 'myFunc')).toEqual({
      a: 1,
    });
  });
});

//#endregion
