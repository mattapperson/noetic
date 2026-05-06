import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { z } from 'zod';
import { isNoeticError } from '../../src/errors/noetic-error';
import { execute } from '../../src/interpreter/execute';
import { AgentHarness } from '../../src/harness/agent-harness';
import { ContextImpl } from '../../src/runtime/context-impl';
import type { Context } from '../../src/types/context';
import type { ContextMemory } from '../../src/types/memory';
import type { Step } from '../../src/types/step';
import { createScriptedCallModel, makeLLMResponse, makeMockHarness } from '../_helpers';

describe('execute() switch', () => {
  it('dispatches run step', async () => {
    const step: Step<ContextMemory, string, number> = {
      kind: 'run',
      id: 'test',
      execute: async (input: string) => input.length,
    };
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    const result = await execute(step, 'hello', ctx);
    expect(result).toBe(5);
  });

  it('dispatches tool step', async () => {
    const tool = {
      name: 'echo',
      description: 'Echo input',
      input: z.object({
        msg: z.string(),
      }),
      output: z.string(),
      execute: async (args: { msg: string }) => args.msg,
    };
    const step: Step<
      ContextMemory,
      {
        msg: string;
      },
      string
    > = {
      kind: 'tool',
      id: 'echo-tool',
      tool,
    };
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const ctx = harness.createContext();
    const result = await execute(
      step,
      {
        msg: 'hi',
      },
      ctx,
    );
    expect(result).toBe('hi');
  });

  it('dispatches llm step via mock callModel', async () => {
    const step: Step<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'llm-test',
      model: 'test-model',
    };
    const harness = makeMockHarness();
    harness.callModel = createScriptedCallModel([
      makeLLMResponse('response'),
    ]);
    const ctx = new ContextImpl({
      harness,
    });
    const result = await execute(step, 'prompt', ctx);
    expect(result).toBe('response');
  });

  it('throws when harness has no client configured', async () => {
    const step: Step<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'test',
      model: 'x',
    };
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    expect(execute(step, 'hi', ctx)).rejects.toThrow('not impl');
  });

  it('increments stepCount', async () => {
    const step: Step<ContextMemory, string, string> = {
      kind: 'run',
      id: 'test',
      execute: async (input: string) => input,
    };
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    expect(ctx.stepCount).toBe(0);
    await execute(step, 'a', ctx);
    expect(ctx.stepCount).toBe(1);
    await execute(step, 'b', ctx);
    expect(ctx.stepCount).toBe(2);
  });

  it('throws budget_exceeded when depth exceeds MAX_DEPTH', async () => {
    // Build a context chain 64 levels deep
    let ctx: Context = new ContextImpl({
      harness: makeMockHarness(),
    });
    for (let i = 0; i < 64; i++) {
      ctx = new ContextImpl({
        harness: makeMockHarness(),
        parent: ctx,
      });
    }
    expect(ctx.depth).toBe(64);
    const step: Step<ContextMemory, string, string> = {
      kind: 'run',
      id: 'deep',
      execute: async (input: string) => input,
    };
    try {
      await execute(step, 'test', ctx);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      const oe = e.noeticError;
      assert(oe.kind === 'step_failed');
      expect(oe.cause.message).toContain('Maximum spawn depth');
    }
  });

  it('throws cancelled when context is aborted', async () => {
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    ctx.abort('test abort');
    const step: Step<ContextMemory, string, string> = {
      kind: 'run',
      id: 'test',
      execute: async (input: string) => input,
    };
    try {
      await execute(step, 'test', ctx);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      const oe = e.noeticError;
      expect(oe.kind).toBe('cancelled');
    }
  });

  it('branch step routes correctly', async () => {
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    const branchStep: Step<ContextMemory, string, string> = {
      kind: 'branch',
      id: 'b',
      route: () => null,
    };
    const result = await execute(branchStep, 'hello', ctx);
    expect(result).toBe('hello');
  });
});

describe('AgentHarness', () => {
  it('creates context', () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const ctx = harness.createContext();
    expect(ctx.id).toBeDefined();
    expect(ctx.stepCount).toBe(0);
  });

  it('creates context with options', () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const ctx = harness.createContext({
      state: {
        count: 0,
      },
      threadId: 'thread-1',
      resourceId: 'user-1',
    });
    expect(ctx.state).toEqual({
      count: 0,
    });
    expect(ctx.threadId).toBe('thread-1');
    expect(ctx.resourceId).toBe('user-1');
  });

  it('executes steps via harness', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const ctx = harness.createContext();
    const step: Step<ContextMemory, string, number> = {
      kind: 'run',
      id: 'len',
      execute: async (s: string) => s.length,
    };
    const result = await harness.run(step, 'hello', ctx);
    expect(result).toBe(5);
  });

  it('executes LLM steps when _testCallModel provided', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
      _testCallModel: createScriptedCallModel([
        makeLLMResponse('hi'),
      ]),
    });
    const ctx = harness.createContext();
    const step: Step<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'test',
      model: 'gpt-4',
    };
    const result = await harness.run(step, 'hello', ctx);
    expect(result).toBe('hi');
  });

  it('createSpan returns a valid span', () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const span = harness.createSpan('test', null);
    expect(span.traceId).toBeDefined();
    expect(span.spanId).toBeDefined();
    expect(span.parentSpanId).toBeNull();
  });
});
