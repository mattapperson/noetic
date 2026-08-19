import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData } from '@noetic-tools/context';
import { beforeToolCallLayers, createLayerStateStore } from '@noetic-tools/context';
import type {
  AgentHarnessContract,
  Context,
  ContextLayer,
  SteeringDecision,
  StepInvokeTool,
} from '@noetic-tools/types';
import { frameworkCast, isNoeticError, SteeringAction } from '@noetic-tools/types';
import { z } from 'zod';
import { executeToolCall } from '../../src/adapters/openrouter';
import { executeInvokeTool } from '../../src/interpreter/execute-action';
import { makeCtx, makeMockContext, makeMockHarness } from '../_helpers';

//#region Helpers

interface EmittedEvent {
  source: string;
  type: string;
  data: Record<string, unknown>;
}

/** Attach a recording fake broadcaster to a mock context (property-checked by getBroadcaster). */
function withBroadcaster(ctx: Context, events: EmittedEvent[]): Context {
  return Object.assign(ctx, {
    _broadcaster: {
      emit: (event: EmittedEvent) => {
        events.push(event);
      },
    },
  });
}

function passthroughLayer(): ContextLayer {
  return frameworkCast<ContextLayer>({
    id: 'gate-probe',
    slot: 0,
    hooks: {
      beforeToolCall: async () => ({
        decision: {
          action: SteeringAction.Allow,
        },
      }),
    },
  });
}

function capturingLayer(seen: Array<string | undefined>): ContextLayer {
  return frameworkCast<ContextLayer>({
    id: 'gate-capture',
    slot: 0,
    hooks: {
      beforeToolCall: async (params: { callId?: string }) => {
        seen.push(params.callId);
        return {
          decision: {
            action: SteeringAction.Allow,
          },
        };
      },
    },
  });
}

function gatedHarness(
  onGate: (toolName: string, callId: string | undefined) => SteeringDecision,
): AgentHarnessContract {
  const base = makeMockHarness();
  return {
    ...base,
    // The contract signature is positional; a rest tuple keeps the mock to one
    // declared parameter while still capturing toolName and callId.
    beforeToolCall: async (
      ...args: [
        ContextLayer[],
        string,
        unknown,
        Context,
        string?,
      ]
    ): Promise<SteeringDecision> => onGate(args[1], args[4]),
  };
}

const AddInput = z.object({
  a: z.number(),
  b: z.number(),
});

function addStep(): StepInvokeTool<
  ContextData,
  {
    a: number;
    b: number;
  },
  {
    sum: number;
  }
> {
  return {
    kind: 'invokeTool',
    id: 'add-step',
    tool: {
      name: 'add',
      description: 'Add two numbers',
      input: AddInput,
      output: z.object({
        sum: z.number(),
      }),
      execute: async (args: { a: number; b: number }) => ({
        sum: args.a + args.b,
      }),
    },
  };
}

//#endregion

describe('gate contract — callId correlation', () => {
  it('beforeToolCallLayers forwards callId into layer hook params', async () => {
    const seen: Array<string | undefined> = [];
    const store = createLayerStateStore();
    const decision = await beforeToolCallLayers({
      layers: [
        capturingLayer(seen),
      ],
      toolName: 'add',
      toolArgs: {},
      callId: 'call-123',
      ctx: makeCtx(),
      store,
    });

    expect(decision.action).toBe(SteeringAction.Allow);
    expect(seen).toEqual([
      'call-123',
    ]);
  });

  it('beforeToolCallLayers passes undefined when the caller has no call identity', async () => {
    const seen: Array<string | undefined> = [];
    const store = createLayerStateStore();
    await beforeToolCallLayers({
      layers: [
        capturingLayer(seen),
      ],
      toolName: 'add',
      toolArgs: {},
      ctx: makeCtx(),
      store,
    });

    expect(seen).toEqual([
      undefined,
    ]);
  });

  it('executeToolCall passes the model callId to the gate', async () => {
    const gateCalls: Array<{
      toolName: string;
      callId: string | undefined;
    }> = [];
    const harness = gatedHarness((toolName, callId) => {
      gateCalls.push({
        toolName,
        callId,
      });
      return {
        action: SteeringAction.Allow,
      };
    });
    const result = await executeToolCall({
      toolName: 'add',
      args: {
        a: 1,
        b: 2,
      },
      tools: [
        addStep().tool,
      ],
      context: makeMockContext({
        harness,
      }),
      harness,
      layers: [
        passthroughLayer(),
      ],
      callId: 'fc-42',
    });

    expect(gateCalls).toEqual([
      {
        toolName: 'add',
        callId: 'fc-42',
      },
    ]);
    expect(result.error).toBeFalsy();
  });

  it('executeInvokeTool passes the step id as callId', async () => {
    const gateCalls: Array<string | undefined> = [];
    const harness = gatedHarness((_toolName, callId) => {
      gateCalls.push(callId);
      return {
        action: SteeringAction.Allow,
      };
    });
    const result = await executeInvokeTool(
      addStep(),
      {
        a: 3,
        b: 4,
      },
      makeMockContext({
        harness,
      }),
      harness,
      [
        passthroughLayer(),
      ],
    );

    expect(result).toEqual({
      sum: 7,
    });
    expect(gateCalls).toEqual([
      'add-step',
    ]);
  });
});

describe('gate contract — event-before-gate ordering', () => {
  it('emits tool_call_started before awaiting the gate, and completed after the result', async () => {
    const events: EmittedEvent[] = [];
    const order: string[] = [];
    const harness = gatedHarness(() => {
      order.push('gate');
      return {
        action: SteeringAction.Allow,
      };
    });
    const originalEmit = withBroadcaster(
      makeMockContext({
        harness,
      }),
      events,
    );
    // Record ordering through the same array the broadcaster writes to.
    const ctx = Object.assign(originalEmit, {
      _broadcaster: {
        emit: (event: EmittedEvent) => {
          events.push(event);
          order.push(event.type);
        },
      },
    });

    await executeInvokeTool(
      addStep(),
      {
        a: 1,
        b: 1,
      },
      ctx,
      harness,
      [
        passthroughLayer(),
      ],
    );

    const startedIndex = order.indexOf('test-harness:tool_call_started');
    const gateIndex = order.indexOf('gate');
    const completedIndex = order.indexOf('test-harness:tool_call_completed');
    expect(startedIndex).toBeGreaterThanOrEqual(0);
    expect(gateIndex).toBeGreaterThan(startedIndex);
    expect(completedIndex).toBeGreaterThan(gateIndex);

    const started = events.find((e) => e.type === 'test-harness:tool_call_started');
    assert(started);
    expect(started.source).toBe('framework');
    expect(started.data.callId).toBe('add-step');
    expect(started.data.name).toBe('add');
    const completed = events.find((e) => e.type === 'test-harness:tool_call_completed');
    assert(completed);
    expect(completed.data.error).toBe(false);
  });

  it('a denied gate closes the bracket with error: true and throws steering_denied', async () => {
    const events: EmittedEvent[] = [];
    const harness = gatedHarness(() => ({
      action: SteeringAction.Deny,
      guidance: 'not on my watch',
    }));
    const ctx = withBroadcaster(
      makeMockContext({
        harness,
      }),
      events,
    );

    try {
      await executeInvokeTool(
        addStep(),
        {
          a: 1,
          b: 1,
        },
        ctx,
        harness,
        [
          passthroughLayer(),
        ],
      );
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('steering_denied');
    }

    const completed = events.find((e) => e.type === 'test-harness:tool_call_completed');
    assert(completed);
    expect(completed.data.error).toBe(true);
  });

  it('a throwing tool closes the bracket with error: true', async () => {
    const events: EmittedEvent[] = [];
    const harness = makeMockHarness();
    const ctx = withBroadcaster(
      makeMockContext({
        harness,
      }),
      events,
    );
    const step: StepInvokeTool<ContextData, Record<string, never>, never> = {
      kind: 'invokeTool',
      id: 'boom-step',
      tool: {
        name: 'boom',
        description: 'Always throws',
        input: z.object({}),
        output: z.never(),
        execute: async () => {
          throw new Error('boom');
        },
      },
    };

    try {
      await executeInvokeTool(step, {}, ctx, harness);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('step_failed');
    }

    const completed = events.find((e) => e.type === 'test-harness:tool_call_completed');
    assert(completed);
    expect(completed.data.error).toBe(true);
    expect(completed.data.callId).toBe('boom-step');
  });
});

describe('gate contract — failure direction (onBeforeToolCallError)', () => {
  function throwingLayer(mode: 'abstain' | 'deny' | undefined): ContextLayer {
    return frameworkCast<ContextLayer>({
      id: 'flaky-gate',
      slot: 0,
      scope: 'execution',
      onBeforeToolCallError: mode,
      hooks: {
        beforeToolCall: async () => {
          throw new Error('gate blew up');
        },
      },
    });
  }

  it('a throwing hook abstains by default (observational layers must not block tools)', async () => {
    const store = createLayerStateStore();
    const decision = await beforeToolCallLayers({
      layers: [
        throwingLayer(undefined),
      ],
      toolName: 'add',
      toolArgs: {},
      callId: 'call-1',
      ctx: makeCtx(),
      store,
    });
    expect(decision.action).toBe(SteeringAction.Allow);
  });

  it("a throwing hook on an onBeforeToolCallError: 'deny' layer fails closed", async () => {
    const store = createLayerStateStore();
    const decision = await beforeToolCallLayers({
      layers: [
        throwingLayer('deny'),
      ],
      toolName: 'add',
      toolArgs: {},
      callId: 'call-1',
      ctx: makeCtx(),
      store,
    });
    expect(decision.action).toBe(SteeringAction.Deny);
    assert(decision.guidance);
    expect(decision.guidance).toContain('gate blew up');
  });

  it('a timed-out deny-mode hook fails closed at the layer timeout boundary', async () => {
    const store = createLayerStateStore();
    const hangingLayer = frameworkCast<ContextLayer>({
      id: 'hanging-gate',
      slot: 0,
      scope: 'execution',
      onBeforeToolCallError: 'deny',
      timeouts: {
        beforeToolCall: 20,
      },
      hooks: {
        beforeToolCall: () => new Promise(() => {}),
      },
    });
    const decision = await beforeToolCallLayers({
      layers: [
        hangingLayer,
      ],
      toolName: 'add',
      toolArgs: {},
      callId: 'call-1',
      ctx: makeCtx(),
      store,
    });
    expect(decision.action).toBe(SteeringAction.Deny);
  });
});

describe('gate contract — the gate PARKS the pending call', () => {
  it('executeToolCall waits on an unresolved async gate; the tool runs only after release', async () => {
    let releaseGate: ((decision: SteeringDecision) => void) | undefined;
    let toolRan = false;
    const harness = {
      ...makeMockHarness(),
      beforeToolCall: (
        ...args: [
          ContextLayer[],
          string,
          unknown,
          Context,
          string?,
        ]
      ): Promise<SteeringDecision> => {
        void args;
        return new Promise<SteeringDecision>((resolve) => {
          releaseGate = resolve;
        });
      },
    };
    const runningTool = {
      name: 'slow-gated',
      description: 'Runs only after approval',
      input: z.object({}),
      output: z.object({
        ok: z.boolean(),
      }),
      execute: async () => {
        toolRan = true;
        return {
          ok: true,
        };
      },
    };

    const call = executeToolCall({
      toolName: 'slow-gated',
      args: {},
      tools: [
        runningTool,
      ],
      context: makeMockContext({
        harness,
      }),
      harness,
      layers: [
        passthroughLayer(),
      ],
      callId: 'parked-1',
    });

    // Give the executor every chance to (incorrectly) run the tool early.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(toolRan).toBe(false);
    assert(releaseGate);
    releaseGate({
      action: SteeringAction.Allow,
    });
    const result = await call;
    expect(toolRan).toBe(true);
    expect(result.error).toBeFalsy();
  });
});
