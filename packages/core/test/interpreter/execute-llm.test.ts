import { describe, it, expect } from 'bun:test';
import { executeLLM } from '../../src/interpreter/execute-llm';
import { isOrchidError, OrchidErrorImpl } from '../../src/errors/orchid-error';
import type { Context, ItemLog } from '../../src/types/context';
import type { Item, MessageItem } from '../../src/types/items';
import type { StepLLM } from '../../src/types/step';
import { z } from 'zod';

// Simple test helpers
function createItemLog(): ItemLog {
  const items: Item[] = [];
  return {
    get items() { return items as ReadonlyArray<Item>; },
    append(item: Item) { items.push(item); },
  };
}

function createMockCtx(overrides?: Partial<Context>): Context {
  return {
    id: 'test-ctx',
    stepCount: 0,
    tokens: { input: 0, output: 0, total: 0 },
    elapsed: 0,
    cost: 0,
    state: {},
    parent: null,
    depth: 0,
    span: { traceId: 't', spanId: 's', parentSpanId: null, setAttribute() {}, addEvent() {}, end() {} },
    threadId: 'thread-1',
    itemLog: createItemLog(),
    lastStepMeta: null,
    recv: async () => { throw new Error('not impl'); },
    send: () => { throw new Error('not impl'); },
    tryRecv: () => { throw new Error('not impl'); },
    checkpoint: async () => {},
    complete: () => {},
    abort: () => {},
    ...overrides,
  } as Context;
}

describe('executeLLM', () => {
  it('calls callModel and returns text output', async () => {
    const step: StepLLM<string, string> = { kind: 'llm', id: 'test', model: 'gpt-4' };
    const ctx = createMockCtx();

    const callModel = async () => ({
      items: [{
        id: 'resp-1',
        status: 'completed' as const,
        type: 'message' as const,
        role: 'assistant' as const,
        content: [{ type: 'output_text' as const, text: 'Hello world' }],
      }],
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const result = await executeLLM(step, 'hi', ctx, callModel);
    expect(result).toBe('Hello world');
  });

  it('appends input as user message to ItemLog', async () => {
    const step: StepLLM<string, string> = { kind: 'llm', id: 'test', model: 'gpt-4' };
    const ctx = createMockCtx();

    const callModel = async () => ({
      items: [{
        id: 'resp-1',
        status: 'completed' as const,
        type: 'message' as const,
        role: 'assistant' as const,
        content: [{ type: 'output_text' as const, text: 'Hello' }],
      }],
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    await executeLLM(step, 'hi', ctx, callModel);
    const userItems = ctx.itemLog.items.filter(i => (i as MessageItem).role === 'user');
    expect(userItems).toHaveLength(1);
  });

  it('appends response items to ItemLog', async () => {
    const step: StepLLM<string, string> = { kind: 'llm', id: 'test', model: 'gpt-4' };
    const ctx = createMockCtx();

    const responseItem: MessageItem = {
      id: 'resp-1',
      status: 'completed',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello' }],
    };

    const callModel = async () => ({
      items: [responseItem],
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    await executeLLM(step, 'hi', ctx, callModel);
    const assistantItems = ctx.itemLog.items.filter(i => (i as MessageItem).role === 'assistant');
    expect(assistantItems).toHaveLength(1);
  });

  it('does not append user message for empty string input', async () => {
    const step: StepLLM<string, string> = { kind: 'llm', id: 'test', model: 'gpt-4' };
    const ctx = createMockCtx();

    const callModel = async () => ({
      items: [{
        id: 'r1', status: 'completed' as const, type: 'message' as const,
        role: 'assistant' as const, content: [{ type: 'output_text' as const, text: 'ok' }],
      }],
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    await executeLLM(step, '', ctx, callModel);
    const userItems = ctx.itemLog.items.filter(i => (i as MessageItem).role === 'user');
    expect(userItems).toHaveLength(0);
  });

  it('sets ctx.lastStepMeta with usage', async () => {
    const step: StepLLM<string, string> = { kind: 'llm', id: 'test', model: 'gpt-4' };
    const ctx = createMockCtx();

    const callModel = async () => ({
      items: [{
        id: 'r1', status: 'completed' as const, type: 'message' as const,
        role: 'assistant' as const, content: [{ type: 'output_text' as const, text: 'ok' }],
      }],
      usage: { inputTokens: 100, outputTokens: 50 },
      cost: 0.01,
    });

    await executeLLM(step, 'hi', ctx, callModel);
    expect(ctx.lastStepMeta).not.toBeNull();
    expect(ctx.lastStepMeta!.usage?.inputTokens).toBe(100);
    expect(ctx.lastStepMeta!.cost).toBe(0.01);
  });

  it('accumulates token usage on context', async () => {
    const step: StepLLM<string, string> = { kind: 'llm', id: 'test', model: 'gpt-4' };
    const ctx = createMockCtx();

    const callModel = async () => ({
      items: [{
        id: 'r1', status: 'completed' as const, type: 'message' as const,
        role: 'assistant' as const, content: [{ type: 'output_text' as const, text: 'ok' }],
      }],
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    await executeLLM(step, 'hi', ctx, callModel);
    expect(ctx.tokens.input).toBe(100);
    expect(ctx.tokens.output).toBe(50);
    expect(ctx.tokens.total).toBe(150);
  });

  it('parses output with Zod schema', async () => {
    const schema = z.object({ answer: z.string(), confidence: z.number() });
    const step: StepLLM<string, z.infer<typeof schema>> = {
      kind: 'llm', id: 'test', model: 'gpt-4', output: schema,
    };
    const ctx = createMockCtx();

    const callModel = async () => ({
      items: [{
        id: 'r1', status: 'completed' as const, type: 'message' as const,
        role: 'assistant' as const,
        content: [{ type: 'output_text' as const, text: '{"answer":"42","confidence":0.95}' }],
      }],
      usage: { inputTokens: 10, outputTokens: 20 },
    });

    const result = await executeLLM(step, 'hi', ctx, callModel);
    expect(result).toEqual({ answer: '42', confidence: 0.95 });
  });

  it('throws llm_parse_error on invalid JSON', async () => {
    const schema = z.object({ answer: z.string() });
    const step: StepLLM<string, z.infer<typeof schema>> = {
      kind: 'llm', id: 'parse-fail', model: 'gpt-4', output: schema,
    };
    const ctx = createMockCtx();

    const callModel = async () => ({
      items: [{
        id: 'r1', status: 'completed' as const, type: 'message' as const,
        role: 'assistant' as const,
        content: [{ type: 'output_text' as const, text: 'not json at all' }],
      }],
      usage: { inputTokens: 10, outputTokens: 20 },
    });

    try {
      await executeLLM(step, 'hi', ctx, callModel);
      expect(true).toBe(false); // should not reach
    } catch (e) {
      expect(isOrchidError(e)).toBe(true);
      expect((e as OrchidErrorImpl).orchidError.kind).toBe('llm_parse_error');
    }
  });

  it('throws llm_parse_error on schema validation failure', async () => {
    const schema = z.object({ answer: z.string() });
    const step: StepLLM<string, z.infer<typeof schema>> = {
      kind: 'llm', id: 'parse-fail', model: 'gpt-4', output: schema,
    };
    const ctx = createMockCtx();

    const callModel = async () => ({
      items: [{
        id: 'r1', status: 'completed' as const, type: 'message' as const,
        role: 'assistant' as const,
        content: [{ type: 'output_text' as const, text: '{"wrong":"field"}' }],
      }],
      usage: { inputTokens: 10, outputTokens: 20 },
    });

    try {
      await executeLLM(step, 'hi', ctx, callModel);
      expect(true).toBe(false);
    } catch (e) {
      expect(isOrchidError(e)).toBe(true);
      expect((e as OrchidErrorImpl).orchidError.kind).toBe('llm_parse_error');
    }
  });

  it('identifies tool calls in response', async () => {
    const step: StepLLM<string, string> = { kind: 'llm', id: 'test', model: 'gpt-4' };
    const ctx = createMockCtx();

    const callModel = async () => ({
      items: [
        {
          id: 'fc1', status: 'completed' as const, type: 'function_call' as const,
          call_id: 'call_1', name: 'search', arguments: '{"q":"test"}',
        },
        {
          id: 'fco1', status: 'completed' as const, type: 'function_call_output' as const,
          call_id: 'call_1', output: '{"results":[]}',
        },
        {
          id: 'r1', status: 'completed' as const, type: 'message' as const,
          role: 'assistant' as const, content: [{ type: 'output_text' as const, text: 'done' }],
        },
      ],
      usage: { inputTokens: 10, outputTokens: 20 },
    });

    await executeLLM(step, 'hi', ctx, callModel);
    expect(ctx.lastStepMeta!.toolCalls).toHaveLength(1);
    expect(ctx.lastStepMeta!.toolCalls![0].name).toBe('search');
  });

  it('passes model, items, tools, params, and output to callModel', async () => {
    const schema = z.object({ x: z.number() });
    const step: StepLLM<string, z.infer<typeof schema>> = {
      kind: 'llm', id: 'test', model: 'claude-3',
      params: { temperature: 0.5 },
      output: schema,
    };
    const ctx = createMockCtx();

    let capturedArgs: any;
    const callModel = async (model: string, items: any, tools: any, params: any, output: any) => {
      capturedArgs = { model, items, tools, params, output };
      return {
        items: [{
          id: 'r1', status: 'completed' as const, type: 'message' as const,
          role: 'assistant' as const,
          content: [{ type: 'output_text' as const, text: '{"x":1}' }],
        }],
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    };

    await executeLLM(step, 'hi', ctx, callModel);
    expect(capturedArgs.model).toBe('claude-3');
    expect(capturedArgs.params).toEqual({ temperature: 0.5 });
    expect(capturedArgs.output).toBe(schema);
  });

  it('stores responseItems in lastStepMeta', async () => {
    const step: StepLLM<string, string> = { kind: 'llm', id: 'test', model: 'gpt-4' };
    const ctx = createMockCtx();

    const responseItems = [{
      id: 'r1', status: 'completed' as const, type: 'message' as const,
      role: 'assistant' as const, content: [{ type: 'output_text' as const, text: 'ok' }],
    }];

    const callModel = async () => ({
      items: responseItems,
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    await executeLLM(step, 'hi', ctx, callModel);
    expect(ctx.lastStepMeta!.responseItems).toHaveLength(1);
  });

  it('accumulates cost on context', async () => {
    const step: StepLLM<string, string> = { kind: 'llm', id: 'test', model: 'gpt-4' };
    const ctx = createMockCtx();

    const callModel = async () => ({
      items: [{
        id: 'r1', status: 'completed' as const, type: 'message' as const,
        role: 'assistant' as const, content: [{ type: 'output_text' as const, text: 'ok' }],
      }],
      usage: { inputTokens: 10, outputTokens: 5 },
      cost: 0.05,
    });

    await executeLLM(step, 'hi', ctx, callModel);
    expect(ctx.cost).toBe(0.05);
  });
});
