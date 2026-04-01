import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { z } from 'zod';
import { isNoeticError } from '../../src/errors/noetic-error';
import { executeLLM } from '../../src/interpreter/execute-llm';
import type { Item } from '../../src/types/items';
import type { ContextMemory, MemoryLayer } from '../../src/types/memory';
import { Slot } from '../../src/types/memory';
import type { CallModelRequest } from '../../src/types/runtime';
import type { StepLLM } from '../../src/types/step';
import {
  createScriptedCallModel,
  makeItemLog,
  makeLLMResponse,
  makeMessage,
  makeMockContext,
  makeMockContextWithClient,
  makeMockHarness,
} from '../_helpers';

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

  it('passes step.instructions through in the callModel request', async () => {
    const step: StepLLM<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'test',
      model: 'gpt-4',
      instructions: 'You are Skippy',
    };
    let capturedRequest: CallModelRequest | undefined;
    const harness = makeMockHarness();
    harness.callModel = async (request) => {
      capturedRequest = request;
      return makeLLMResponse('ok');
    };
    const ctx = makeMockContext({
      harness,
    });

    await executeLLM(step, 'hi', ctx);
    assert(capturedRequest !== undefined);
    expect(capturedRequest.instructions).toBe('You are Skippy');
    expect(ctx.lastStepMeta).not.toBeNull();
  });

  it('passes undefined instructions when step has no instructions', async () => {
    const step: StepLLM<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'test',
      model: 'gpt-4',
    };
    let capturedRequest: CallModelRequest | undefined;
    const harness = makeMockHarness();
    harness.callModel = async (request) => {
      capturedRequest = request;
      return makeLLMResponse('ok');
    };
    const ctx = makeMockContext({
      harness,
    });

    await executeLLM(step, 'hi', ctx);
    assert(capturedRequest !== undefined);
    expect(capturedRequest.instructions).toBeUndefined();
    expect(ctx.lastStepMeta).not.toBeNull();
  });

  describe('memory layer integration', () => {
    it('calls recallLayersAtomic and assembles view when layers present', async () => {
      const recallCalls: string[] = [];
      const layers: MemoryLayer[] = [
        {
          id: 'wm',
          slot: Slot.WORKING_MEMORY,
          scope: 'thread',
          hooks: {},
        },
      ];

      const harness = makeMockHarness();
      harness.callModel = createScriptedCallModel([
        makeLLMResponse('done'),
      ]);
      harness.recallLayersAtomic = async () => {
        recallCalls.push('atomic');
        return [
          {
            layerId: 'wm',
            items: [
              makeMessage('developer', '<working_memory>test</working_memory>', 'wm-1'),
            ],
            tokenCount: 10,
          },
        ];
      };
      harness.recallLayersEventual = async () => [];
      const ctx = makeMockContext({
        harness,
        layers,
      });

      const step: StepLLM<ContextMemory, string, string> = {
        kind: 'llm',
        id: 'test',
        model: 'gpt-4',
      };

      await executeLLM(step, 'hello', ctx, layers);
      expect(recallCalls).toEqual([
        'atomic',
      ]);
    });

    it('calls storeLayers after model response', async () => {
      let storeLayersCalled = false;
      const layers: MemoryLayer[] = [
        {
          id: 'wm',
          slot: Slot.WORKING_MEMORY,
          scope: 'thread',
          hooks: {},
        },
      ];

      const harness = makeMockHarness();
      harness.callModel = createScriptedCallModel([
        makeLLMResponse('done'),
      ]);
      harness.recallLayersAtomic = async () => [];
      harness.recallLayersEventual = async () => [];
      harness.storeLayers = async () => {
        storeLayersCalled = true;
      };
      const ctx = makeMockContext({
        harness,
        layers,
      });

      const step: StepLLM<ContextMemory, string, string> = {
        kind: 'llm',
        id: 'test',
        model: 'gpt-4',
      };

      await executeLLM(step, 'hello', ctx, layers);
      expect(storeLayersCalled).toBe(true);
    });

    it('skips memory pipeline when no layers provided', async () => {
      const step: StepLLM<ContextMemory, string, string> = {
        kind: 'llm',
        id: 'test',
        model: 'gpt-4',
      };
      const ctx = makeMockContextWithClient([
        makeLLMResponse('hello'),
      ]);

      const result = await executeLLM(step, 'hi', ctx);
      expect(result).toBe('hello');
      // No layers = itemLog.items passed directly (existing behavior)
      expect(ctx.itemLog.items.length).toBeGreaterThan(0);
    });

    it('passes assembled view (system + layers + history) to callModel', async () => {
      const layers: MemoryLayer[] = [
        {
          id: 'wm',
          slot: Slot.WORKING_MEMORY,
          scope: 'thread',
          hooks: {},
        },
      ];

      const harness = makeMockHarness();

      // Capture the request passed to callModel
      let capturedItems: ReadonlyArray<Item> | undefined;
      harness.callModel = async (request) => {
        capturedItems = request.items;
        return makeLLMResponse('done');
      };

      harness.recallLayersAtomic = async () => [
        {
          layerId: 'wm',
          items: [
            makeMessage('developer', '<working_memory>context</working_memory>', 'layer-recall-1'),
          ],
          tokenCount: 10,
        },
      ];
      harness.recallLayersEventual = async () => [];

      const systemItem: Item = {
        id: 'sys-1',
        status: 'completed',
        type: 'message',
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: 'You are a helpful assistant.',
          },
        ],
      };

      const ctx = makeMockContext({
        harness,
        layers,
        itemLog: makeItemLog([
          systemItem,
        ]),
      });

      const step: StepLLM<ContextMemory, string, string> = {
        kind: 'llm',
        id: 'test',
        model: 'gpt-4',
      };

      await executeLLM(step, 'hello', ctx, layers);

      assert(capturedItems !== undefined, 'callModel should have been called');

      // Verify system items come first
      const firstItem = capturedItems[0];
      assert(firstItem.type === 'message' && firstItem.role === 'system');
      expect(firstItem.id).toBe('sys-1');

      // Verify the layer output item is present
      const layerItem = capturedItems.find(
        (i) => i.type === 'message' && i.role === 'developer' && i.id === 'layer-recall-1',
      );
      assert(layerItem !== undefined, 'layer recall item should be in request');
      assert(layerItem.type === 'message');
      expect(layerItem.content[0]).toEqual({
        type: 'input_text',
        text: '<working_memory>context</working_memory>',
      });

      // Verify history (user message from input) comes after layers
      const userItem = capturedItems.find((i) => i.type === 'message' && i.role === 'user');
      assert(userItem !== undefined, 'user message should be in request');

      // Order check: system index < layer index < user index
      const systemIdx = capturedItems.indexOf(firstItem);
      const layerIdx = capturedItems.indexOf(layerItem);
      const userIdx = capturedItems.indexOf(userItem);
      expect(systemIdx).toBeLessThan(layerIdx);
      expect(layerIdx).toBeLessThan(userIdx);
    });

    it('calls recallLayersEventual for eventual layers', async () => {
      const eventualCalls: string[] = [];
      const layers: MemoryLayer[] = [
        {
          id: 'obs',
          slot: Slot.OBSERVATIONS,
          scope: 'resource',
          recallMode: 'eventual',
          hooks: {},
        },
      ];

      const harness = makeMockHarness();
      harness.callModel = createScriptedCallModel([
        makeLLMResponse('done'),
      ]);
      harness.recallLayersAtomic = async () => [];
      harness.recallLayersEventual = async () => {
        eventualCalls.push('eventual');
        return [];
      };
      const ctx = makeMockContext({
        harness,
        layers,
      });

      const step: StepLLM<ContextMemory, string, string> = {
        kind: 'llm',
        id: 'test',
        model: 'gpt-4',
      };

      await executeLLM(step, 'hello', ctx, layers);
      expect(eventualCalls).toEqual([
        'eventual',
      ]);
    });
  });
});
