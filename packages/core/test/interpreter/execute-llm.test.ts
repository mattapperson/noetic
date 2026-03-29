import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { z } from 'zod';
import { isNoeticError } from '../../src/errors/noetic-error';
import { executeLLM } from '../../src/interpreter/execute-llm';
import type { ContextMemory } from '../../src/types/memory';
import type { StepLLM } from '../../src/types/step';
import { makeLLMResponse, makeMockContextWithClient } from '../_helpers';

describe('executeLLM', () => {
  it('calls the client and returns text output', async () => {
    const step: StepLLM<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'test',
      model: 'gpt-4',
    };
    const ctx = makeMockContextWithClient([
      makeLLMResponse('Hello world'),
    ]);

    const result = await executeLLM(step, 'hi', ctx);
    expect(result).toBe('Hello world');
  });

  it('appends input as user message to ItemLog', async () => {
    const step: StepLLM<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'test',
      model: 'gpt-4',
    };
    const ctx = makeMockContextWithClient([
      makeLLMResponse('Hello'),
    ]);

    await executeLLM(step, 'hi', ctx);
    const userItems = ctx.itemLog.items.filter((i) => i.type === 'message' && i.role === 'user');
    expect(userItems).toHaveLength(1);
  });

  it('appends response items to ItemLog', async () => {
    const step: StepLLM<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'test',
      model: 'gpt-4',
    };
    const ctx = makeMockContextWithClient([
      makeLLMResponse('Hello'),
    ]);

    await executeLLM(step, 'hi', ctx);
    const assistantItems = ctx.itemLog.items.filter(
      (i) => i.type === 'message' && i.role === 'assistant',
    );
    expect(assistantItems).toHaveLength(1);
  });

  it('does not append user message for empty string input', async () => {
    const step: StepLLM<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'test',
      model: 'gpt-4',
    };
    const ctx = makeMockContextWithClient([
      makeLLMResponse('ok'),
    ]);

    await executeLLM(step, '', ctx);
    const userItems = ctx.itemLog.items.filter((i) => i.type === 'message' && i.role === 'user');
    expect(userItems).toHaveLength(0);
  });

  it('sets ctx.lastStepMeta with usage', async () => {
    const step: StepLLM<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'test',
      model: 'gpt-4',
    };
    const ctx = makeMockContextWithClient([
      makeLLMResponse('ok', {
        usage: {
          inputTokens: 100,
          outputTokens: 50,
        },
        cost: 0.01,
      }),
    ]);

    await executeLLM(step, 'hi', ctx);
    expect(ctx.lastStepMeta).not.toBeNull();
    expect(ctx.lastStepMeta!.usage?.inputTokens).toBe(100);
    expect(ctx.lastStepMeta!.cost).toBe(0.01);
  });

  it('accumulates token usage on context', async () => {
    const step: StepLLM<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'test',
      model: 'gpt-4',
    };
    const ctx = makeMockContextWithClient([
      makeLLMResponse('ok', {
        usage: {
          inputTokens: 100,
          outputTokens: 50,
        },
      }),
    ]);

    await executeLLM(step, 'hi', ctx);
    expect(ctx.tokens.input).toBe(100);
    expect(ctx.tokens.output).toBe(50);
    expect(ctx.tokens.total).toBe(150);
  });

  it('parses output with Zod schema', async () => {
    const schema = z.object({
      answer: z.string(),
      confidence: z.number(),
    });
    const step: StepLLM<ContextMemory, string, z.infer<typeof schema>> = {
      kind: 'llm',
      id: 'test',
      model: 'gpt-4',
      output: schema,
    };
    const ctx = makeMockContextWithClient([
      makeLLMResponse('{"answer":"42","confidence":0.95}'),
    ]);

    const result = await executeLLM(step, 'hi', ctx);
    expect(result).toEqual({
      answer: '42',
      confidence: 0.95,
    });
  });

  it('throws llm_parse_error on invalid JSON', async () => {
    const schema = z.object({
      answer: z.string(),
    });
    const step: StepLLM<ContextMemory, string, z.infer<typeof schema>> = {
      kind: 'llm',
      id: 'parse-fail',
      model: 'gpt-4',
      output: schema,
    };
    const ctx = makeMockContextWithClient([
      makeLLMResponse('not json at all'),
    ]);

    try {
      await executeLLM(step, 'hi', ctx);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('llm_parse_error');
    }
  });

  it('throws llm_parse_error on schema validation failure', async () => {
    const schema = z.object({
      answer: z.string(),
    });
    const step: StepLLM<ContextMemory, string, z.infer<typeof schema>> = {
      kind: 'llm',
      id: 'parse-fail',
      model: 'gpt-4',
      output: schema,
    };
    const ctx = makeMockContextWithClient([
      makeLLMResponse('{"wrong":"field"}'),
    ]);

    try {
      await executeLLM(step, 'hi', ctx);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('llm_parse_error');
    }
  });

  it('identifies tool calls in response', async () => {
    const step: StepLLM<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'test',
      model: 'gpt-4',
    };
    const ctx = makeMockContextWithClient([
      {
        items: [
          {
            id: 'fc1',
            status: 'completed' as const,
            type: 'function_call' as const,
            callId: 'call_1',
            name: 'search',
            arguments: '{"q":"test"}',
          },
          {
            id: 'fco1',
            status: 'completed' as const,
            type: 'function_call_output' as const,
            callId: 'call_1',
            output: '{"results":[]}',
          },
          {
            id: 'r1',
            status: 'completed' as const,
            type: 'message' as const,
            role: 'assistant' as const,
            content: [
              {
                type: 'output_text' as const,
                text: 'done',
              },
            ],
          },
        ],
        usage: {
          inputTokens: 10,
          outputTokens: 20,
        },
      },
    ]);

    await executeLLM(step, 'hi', ctx);
    expect(ctx.lastStepMeta!.toolCalls).toHaveLength(1);
    expect(ctx.lastStepMeta!.toolCalls![0].name).toBe('search');
  });

  it('stores responseItems in lastStepMeta', async () => {
    const step: StepLLM<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'test',
      model: 'gpt-4',
    };
    const ctx = makeMockContextWithClient([
      makeLLMResponse('ok'),
    ]);

    await executeLLM(step, 'hi', ctx);
    expect(ctx.lastStepMeta!.responseItems).toHaveLength(1);
  });

  it('accumulates cost on context', async () => {
    const step: StepLLM<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'test',
      model: 'gpt-4',
    };
    const ctx = makeMockContextWithClient([
      makeLLMResponse('ok', {
        usage: {
          inputTokens: 10,
          outputTokens: 5,
        },
        cost: 0.05,
      }),
    ]);

    await executeLLM(step, 'hi', ctx);
    expect(ctx.cost).toBe(0.05);
  });

  it('does not create user message for non-string input', async () => {
    const step: StepLLM<
      ContextMemory,
      {
        data: number;
      },
      string
    > = {
      kind: 'llm',
      id: 'test',
      model: 'gpt-4',
    };
    const ctx = makeMockContextWithClient([
      makeLLMResponse('ok'),
    ]);
    const input: {
      data: number;
    } = {
      data: 42,
    };
    await executeLLM(step, input, ctx);
    const userItems = ctx.itemLog.items.filter((i) => i.type === 'message' && i.role === 'user');
    expect(userItems).toHaveLength(0);
  });

  it('handles empty tools array', async () => {
    const step: StepLLM<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'test',
      model: 'gpt-4',
      tools: [],
    };
    const ctx = makeMockContextWithClient([
      makeLLMResponse('ok'),
    ]);
    await executeLLM(step, 'hi', ctx);
    // No error means empty tools were handled gracefully
    expect(ctx.lastStepMeta).not.toBeNull();
  });
});
