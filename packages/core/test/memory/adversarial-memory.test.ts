/**
 * Adversarial tests for the Noetic memory layer system.
 *
 * Each test targets a specific suspected bug or edge case discovered
 * during code review. Tests that document confirmed bugs are marked
 * with "[BUG]" in the description.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  DurableTaskState,
  ExecutionContext,
  MemoryLayer,
  ObservationalState,
  WorkingMemoryState,
} from '@noetic-tools/memory';
import {
  allocateBudgets,
  createLayerStateStore,
  disposeLayers,
  durableTaskState,
  findFunctionCall,
  initLayers,
  observationalMemory,
  recallLayers,
  steering,
  storeLayers,
  workingMemory,
} from '@noetic-tools/memory';
import type { Item, LLMResponse, SteeringState } from '@noetic-tools/types';
import { frameworkCast, SteeringAction } from '@noetic-tools/types';
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

  it('parses "DENY:reason" — strips the colon and preserves guidance casing', async () => {
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
    // "DENY:unsafe operation" → strip "DENY" + colon → "unsafe operation" (casing preserved)
    expect(result.decision.guidance).toBe('unsafe operation');
  });

  it('"DENYALL" is NOT parsed as DENY (word boundary) → treated as no verdict', async () => {
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

    // "DENYALL" has no word boundary after "DENY", so it is not a valid verdict.
    // Unparseable output is retried then treated as a pass (Allow).
    expect(result.decision.action).toBe(SteeringAction.Allow);
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
    // Space-separated: strip "DENY" + space → "unsafe operation" (casing preserved)
    expect(result.decision.guidance).toBe('unsafe operation');
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
    // "GUIDE:be careful" → strip "GUIDE" + colon → "be careful" (casing preserved)
    expect(result.decision.guidance).toBe('be careful');
  });
});

//#endregion

//#region Steering Async Race Condition

describe('Steering: async pendingAsync race condition', () => {
  it('recall drains pendingAsync in place — late async verdicts surface on the next recall', async () => {
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

    // Recall drains pendingAsync IN PLACE (splice) — the reference held by the
    // in-flight async rule stays live.
    const recallResult = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx,
      state,
      budget: 500,
    });

    // Recall should have returned the seeded feedback
    expect(recallResult).not.toBeNull();
    // state.pendingAsync is the SAME array, drained.
    expect(state.pendingAsync).toBe(oldArray);
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

    // The late verdict landed in the LIVE array (same reference recall drained).
    expect(state.pendingAsync.length).toBe(1);
    expect(state.pendingAsync[0].guidance).toContain('unsafe');

    // Second recall delivers the late DENY feedback.
    const recallAfter = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx,
      state,
      budget: 500,
    });
    expect(recallAfter).not.toBeNull();
    assert(recallAfter !== null && typeof recallAfter !== 'string');
    const msg = recallAfter.items[0];
    assert(msg.type === 'message');
    const part = msg.content[0];
    assert('text' in part && typeof part.text === 'string');
    expect(part.text).toContain('[async-rule]');
    expect(part.text).toContain('unsafe');

    // Drained exactly once: a third recall sees nothing.
    const recallThird = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx,
      state,
      budget: 500,
    });
    expect(recallThird).toBeNull();
  });

  it('two async rules across two recalls — each verdict delivered exactly once', async () => {
    const layer = steering({
      rules: [
        {
          id: 'rule-a',
          appliesTo: [
            'beforeToolCall',
          ],
          llmEval: {
            mode: 'async',
            prompt: 'Check A.',
          },
        },
      ],
    });

    const { ctx, resolveAsync } = makeCtxWithSlowCallModel();
    const store = createLayerStateStore();
    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage: makeStorage(),
      store,
    });
    const state = store.get<SteeringState>(ctx.executionId, layer.id)!;

    const denyResponse = (text: string): LLMResponse => ({
      items: [
        {
          id: `resp-${text}`,
          status: 'completed',
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text,
            },
          ],
        },
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
      },
    });

    // Fire async rule #1, resolve AFTER a recall has drained.
    await layer.hooks.beforeToolCall!({
      toolName: 't1',
      toolArgs: {},
      ctx,
      state,
    });
    assert(resolveAsync.current !== null);
    resolveAsync.current(denyResponse('DENY first'));
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    const first = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx,
      state,
      budget: 500,
    });
    assert(first !== null && typeof first !== 'string');

    // Fire async rule #2 and resolve it.
    await layer.hooks.beforeToolCall!({
      toolName: 't2',
      toolArgs: {},
      ctx,
      state,
    });
    assert(resolveAsync.current !== null);
    resolveAsync.current(denyResponse('DENY second'));
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    const second = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx,
      state,
      budget: 500,
    });
    assert(second !== null && typeof second !== 'string');
    const msg = second.items[0];
    assert(msg.type === 'message');
    const part = msg.content[0];
    assert('text' in part && typeof part.text === 'string');
    expect(part.text).toContain('second');
    expect(part.text).not.toContain('first'); // first was already delivered

    const third = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx,
      state,
      budget: 500,
    });
    expect(third).toBeNull();
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
    const state = store.get(ctx.executionId, layer.id);
    expect(state).toBe('');

    const result = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx,
      state: frameworkCast<WorkingMemoryState>(state),
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
    store.set(ctx.executionId, layer.id, 0);

    const result = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx,
      state: frameworkCast<WorkingMemoryState>(0),
      budget: 1e3,
    });

    // BUG: !0 is true, so recall returns null even though 0 is valid state data
    expect(result).toBeNull();
  });

  it('[BUG] boolean false state treated as empty due to !state check', async () => {
    const layer = workingMemory();
    const store = createLayerStateStore();
    const ctx = makeCtx();

    store.set(ctx.executionId, layer.id, false);

    const result = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx,
      state: frameworkCast<WorkingMemoryState>(false),
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
      state: frameworkCast<WorkingMemoryState>(store.get(ctx.executionId, layer.id)),
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
      state: frameworkCast<WorkingMemoryState>(store.get(ctx.executionId, layer.id)),
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
      state: frameworkCast<WorkingMemoryState>(store.get(ctx.executionId, layer.id)),
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
      state: frameworkCast<ObservationalState>(store.get(ctx.executionId, layer.id)),
    });

    // The observer should have been called since totalBufferTokens >= 100
    expect(observerCalledWith).not.toBeNull();
    const observedItems = observerCalledWith ?? [];
    expect(observedItems.length).toBeGreaterThan(0);
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

    const response: LLMResponse = {
      items,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
      },
    };

    const result = await layer.hooks.store!({
      newItems: items,
      log: makeItemLog(),
      response,
      ctx,
      state: frameworkCast<ObservationalState>(store.get(ctx.executionId, layer.id)),
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

    const state = store.get(ctx.executionId, layer.id);
    const result = await layer.hooks.onComplete!({
      log: makeItemLog(),
      ctx,
      state: frameworkCast<DurableTaskState>(state),
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
      state: frameworkCast<DurableTaskState>(store.get(ctx.executionId, layer.id)),
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
      onInitError: 'disable',
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

  it('layer that intentionally sets state to undefined is NOT treated as disabled', async () => {
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

    // Explicit disabled tracking: an undefined state set on purpose is NOT a
    // disabled layer — recall still runs (with undefined state).
    expect(results.length).toBe(1);
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
      storage: makeStorage(),
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
