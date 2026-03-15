import { describe, it, expect } from 'bun:test';
import { execute } from '../../src/interpreter/execute';
import { ContextImpl } from '../../src/runtime/context-impl';
import { InMemoryRuntime } from '../../src/runtime/in-memory-runtime';
import type { Step } from '../../src/types/step';
import type { Context } from '../../src/types/context';
import { z } from 'zod';

describe('execute() switch', () => {
  it('dispatches run step', async () => {
    const step: Step<string, number> = {
      kind: 'run',
      id: 'test',
      execute: async (input: string) => input.length,
    };
    const ctx = new ContextImpl();
    const result = await execute(step, 'hello', ctx);
    expect(result).toBe(5);
  });

  it('dispatches tool step', async () => {
    const tool = {
      name: 'echo',
      description: 'Echo input',
      input: z.object({ msg: z.string() }),
      output: z.string(),
      execute: async (args: { msg: string }) => args.msg,
    };
    const step: Step<{ msg: string }, string> = {
      kind: 'tool',
      id: 'echo-tool',
      tool,
    };
    const ctx = new ContextImpl();
    const result = await execute(step, { msg: 'hi' }, ctx);
    expect(result).toBe('hi');
  });

  it('dispatches llm step with callModel', async () => {
    const step: Step<string, string> = {
      kind: 'llm',
      id: 'llm-test',
      model: 'test-model',
    };
    const ctx = new ContextImpl();
    const mockCallModel = async () => ({
      items: [{
        id: 'r1', status: 'completed' as const, type: 'message' as const,
        role: 'assistant' as const, content: [{ type: 'output_text' as const, text: 'response' }],
      }],
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const result = await execute(step, 'prompt', ctx, mockCallModel);
    expect(result).toBe('response');
  });

  it('throws when llm step has no callModel', async () => {
    const step: Step<string, string> = { kind: 'llm', id: 'test', model: 'x' };
    const ctx = new ContextImpl();
    expect(execute(step, 'hi', ctx)).rejects.toThrow('callModel is required');
  });

  it('increments stepCount', async () => {
    const step: Step<string, string> = {
      kind: 'run',
      id: 'test',
      execute: async (input: string) => input,
    };
    const ctx = new ContextImpl();
    expect(ctx.stepCount).toBe(0);
    await execute(step, 'a', ctx);
    expect(ctx.stepCount).toBe(1);
    await execute(step, 'b', ctx);
    expect(ctx.stepCount).toBe(2);
  });

  it('throws for unimplemented step kinds', async () => {
    const ctx = new ContextImpl();
    const branchStep: Step<string, string> = {
      kind: 'branch', id: 'b', route: () => null,
    };
    expect(execute(branchStep, '', ctx)).rejects.toThrow('not yet implemented');
  });
});

describe('InMemoryRuntime', () => {
  it('creates context', () => {
    const runtime = new InMemoryRuntime();
    const ctx = runtime.createContext();
    expect(ctx.id).toBeDefined();
    expect(ctx.stepCount).toBe(0);
  });

  it('creates context with options', () => {
    const runtime = new InMemoryRuntime();
    const ctx = runtime.createContext({
      state: { count: 0 },
      threadId: 'thread-1',
      resourceId: 'user-1',
    });
    expect(ctx.state).toEqual({ count: 0 });
    expect(ctx.threadId).toBe('thread-1');
    expect(ctx.resourceId).toBe('user-1');
  });

  it('executes steps via runtime', async () => {
    const runtime = new InMemoryRuntime();
    const ctx = runtime.createContext();
    const step: Step<string, number> = {
      kind: 'run',
      id: 'len',
      execute: async (s: string) => s.length,
    };
    const result = await runtime.execute(step, 'hello', ctx);
    expect(result).toBe(5);
  });

  it('executes LLM steps when callModel provided', async () => {
    const mockCallModel = async () => ({
      items: [{
        id: 'r1', status: 'completed' as const, type: 'message' as const,
        role: 'assistant' as const, content: [{ type: 'output_text' as const, text: 'hi' }],
      }],
      usage: { inputTokens: 5, outputTokens: 3 },
    });
    const runtime = new InMemoryRuntime({ callModel: mockCallModel });
    const ctx = runtime.createContext();
    const step: Step<string, string> = { kind: 'llm', id: 'test', model: 'gpt-4' };
    const result = await runtime.execute(step, 'hello', ctx);
    expect(result).toBe('hi');
  });

  it('createSpan returns a valid span', () => {
    const runtime = new InMemoryRuntime();
    const span = runtime.createSpan('test', null);
    expect(span.traceId).toBeDefined();
    expect(span.spanId).toBeDefined();
    expect(span.parentSpanId).toBeNull();
  });
});
