import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { z } from 'zod';
import { isNoeticError } from '../../src/errors/noetic-error';
import { executeLLM } from '../../src/interpreter/execute-llm';
import { frameworkCast } from '../../src/interpreter/framework-cast';
import { projectHistoryLayers } from '../../src/memory/layer-lifecycle';
import { historyWindow } from '../../src/memory/layers/history-window';
import { ContextImpl } from '../../src/runtime/context-impl';
import type { ContextMemory, ExecutionContext, MemoryLayer } from '../../src/types/memory';
import type { CallModelRequest } from '../../src/types/runtime';
import type { StepLLM } from '../../src/types/step';
import {
  makeLLMResponse,
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

  it('populates ctx.lastLayerUsage with per-layer recall token counts', async () => {
    const step: StepLLM<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'test',
      model: 'gpt-4',
      instructions: 'sys',
    };
    const harness = makeMockHarness();
    let capturedRequest: CallModelRequest | undefined;
    harness.callModel = async (request) => {
      capturedRequest = request;
      return makeLLMResponse('done');
    };
    harness.recallLayers = async () => [
      {
        layerId: 'planMemory',
        items: [
          {
            id: 'plan-1',
            type: 'message',
            role: 'developer',
            status: 'completed',
            content: [
              {
                type: 'input_text',
                text: 'plan summary',
              },
            ],
          },
        ],
        tokenCount: 42,
      },
      {
        layerId: 'workingMemory',
        items: [
          {
            id: 'wm-1',
            type: 'message',
            role: 'developer',
            status: 'completed',
            content: [
              {
                type: 'input_text',
                text: 'scratchpad',
              },
            ],
          },
        ],
        tokenCount: 17,
      },
    ];
    const ctx = new ContextImpl({
      harness,
    });
    const layers: MemoryLayer[] = [
      {
        id: 'planMemory',
        slot: 100,
        scope: 'execution',
        hooks: {},
      },
      {
        id: 'workingMemory',
        slot: 110,
        scope: 'execution',
        hooks: {},
      },
    ];

    await executeLLM(step, 'hi', ctx, layers);

    assert(ctx.lastLayerUsage !== undefined);
    expect(ctx.lastLayerUsage.modelId).toBe('gpt-4');
    expect(ctx.lastLayerUsage.executionId).toBe(ctx.id);
    expect(ctx.lastLayerUsage.layers).toHaveLength(2);
    expect(ctx.lastLayerUsage.layers[0]?.layerId).toBe('planMemory');
    expect(ctx.lastLayerUsage.layers[0]?.tokenCount).toBe(42);
    expect(ctx.lastLayerUsage.layers[1]?.layerId).toBe('workingMemory');
    expect(ctx.lastLayerUsage.layers[1]?.tokenCount).toBe(17);

    // Recall items must reach the model via assembleView, prepended before history.
    assert(capturedRequest !== undefined);
    const items = capturedRequest.items;
    expect(items[0]?.type).toBe('message');
    const firstItem = items[0];
    assert(firstItem.type === 'message');
    expect(firstItem.role).toBe('developer');

    // Side-effect invariant: the user input also lands in the item log.
    expect(ctx.itemLog.items.some((i) => i.type === 'message' && i.role === 'user')).toBe(true);
    expect(ctx.lastStepMeta).not.toBeNull();
  });

  it('caps history items via projectHistory before sending to the model', async () => {
    const step: StepLLM<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'test',
      model: 'gpt-4',
    };
    let capturedRequest: CallModelRequest | undefined;
    const harness = makeMockHarness();
    harness.callModel = async (request) => {
      capturedRequest = request;
      return makeLLMResponse('done');
    };
    // Slice the trailing 4 items — emulates a historyWindow with maxItems: 4.
    harness.projectHistory = async (_layers, items) => items.slice(-4);
    const ctx = new ContextImpl({
      harness,
    });
    // Seed 20 prior items.
    for (let i = 0; i < 10; i++) {
      ctx.itemLog.append({
        id: `u-${i}`,
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [
          {
            type: 'input_text',
            text: `q-${i}`,
          },
        ],
      });
      ctx.itemLog.append({
        id: `a-${i}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: `r-${i}`,
          },
        ],
      });
    }
    const layers: MemoryLayer[] = [
      {
        id: 'history-window',
        slot: 275,
        scope: 'execution',
        hooks: {},
      },
    ];

    await executeLLM(step, '', ctx, layers);

    assert(capturedRequest !== undefined);
    // The recorded request must contain at most 4 items (the cap), even though
    // ctx.itemLog has 20+ pre-existing items.
    expect(capturedRequest.items.length).toBe(4);
    // Storage isn't shrunk by the projection — the seeded 20 plus the LLM
    // response item all remain in the log.
    expect(ctx.itemLog.items.length).toBeGreaterThanOrEqual(20);
  });

  it('integrates the real historyWindow layer end-to-end via projectHistoryLayers', async () => {
    const step: StepLLM<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'test',
      model: 'gpt-4',
    };
    let capturedRequest: CallModelRequest | undefined;
    const harness = makeMockHarness();
    harness.callModel = async (request) => {
      capturedRequest = request;
      return makeLLMResponse('done');
    };
    const realLayer = historyWindow({
      maxItems: 4,
    });
    // Wire the real layer's projectHistory hook through projectHistoryLayers
    // so this exercises the full pipeline (slot sort, hook dispatch, slice +
    // expansion + strip-orphans) instead of a stub.
    harness.projectHistory = async (layers, items, ctx) =>
      projectHistoryLayers({
        layers,
        items,
        ctx: frameworkCast<ExecutionContext>({
          executionId: ctx.id,
        }),
        store: {
          get: <T>() => frameworkCast<T>(null),
          set: () => {},
          cleanup: () => {},
          diagnostic: () => {},
        },
      });
    const ctx = new ContextImpl({
      harness,
    });
    for (let i = 0; i < 10; i++) {
      ctx.itemLog.append({
        id: `u-${i}`,
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [
          {
            type: 'input_text',
            text: `q-${i}`,
          },
        ],
      });
      ctx.itemLog.append({
        id: `a-${i}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: `r-${i}`,
          },
        ],
      });
    }

    await executeLLM(step, '', ctx, [
      realLayer,
    ]);

    assert(capturedRequest !== undefined);
    // The real layer applies maxItems: 4 (history is all alternating user/
    // assistant pairs, no tool calls, so no expansion needed).
    expect(capturedRequest.items.length).toBe(4);
    expect(ctx.itemLog.items.length).toBeGreaterThanOrEqual(20);
  });
});
