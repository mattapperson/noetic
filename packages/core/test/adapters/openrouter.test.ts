import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { createOpenRouterCallModel } from '../../src/adapters/openrouter';
import {
  makeFunctionCall,
  makeFunctionCallOutput,
  makeMessage,
  makeMockContext,
} from '../_helpers';

// Minimal mock of OpenRouter client
function makeMockClient(response: {
  output: unknown[];
  outputText?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    inputTokensDetails?: {
      cachedTokens: number;
    };
    totalTokens: number;
    cost?: number;
  };
}): {
  client: {
    callModel: (params: unknown) => {
      getResponse: () => Promise<unknown>;
    };
  };
  calls: unknown[];
} {
  const calls: unknown[] = [];

  return {
    client: {
      callModel(params: unknown) {
        calls.push(params);
        return {
          async getResponse() {
            return {
              id: 'resp-1',
              object: 'response',
              createdAt: Date.now(),
              model: 'test-model',
              status: 'completed',
              completedAt: Date.now(),
              error: null,
              incompleteDetails: null,
              metadata: null,
              tools: [],
              toolChoice: 'auto',
              parallelToolCalls: false,
              temperature: null,
              topP: null,
              presencePenalty: null,
              frequencyPenalty: null,
              ...response,
            };
          },
        };
      },
    },
    calls,
  };
}

describe('createOpenRouterCallModel', () => {
  it('converts a simple text response to Noetic items', async () => {
    const { client } = makeMockClient({
      output: [
        {
          type: 'message',
          id: 'msg-1',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'Hello world',
            },
          ],
        },
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        inputTokensDetails: {
          cachedTokens: 2,
        },
        totalTokens: 15,
      },
    });

    const callModel = createOpenRouterCallModel(client as never);
    const ctx = makeMockContext();

    const result = await callModel({
      model: 'anthropic/claude-sonnet-4-20250514',
      items: [
        makeMessage('user', 'Hi'),
      ],
      ctx,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].type).toBe('message');
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.usage.cachedTokens).toBe(2);
  });

  it('extracts system messages as instructions', async () => {
    const { client, calls } = makeMockClient({
      output: [
        {
          type: 'message',
          id: 'msg-1',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'response',
            },
          ],
        },
      ],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    });

    const callModel = createOpenRouterCallModel(client as never);
    const ctx = makeMockContext();

    await callModel({
      model: 'test-model',
      items: [
        makeMessage('system', 'You are helpful'),
        makeMessage('user', 'Hello'),
      ],
      ctx,
    });

    const callParams = calls[0] as Record<string, unknown>;
    expect(callParams.instructions).toBe('You are helpful');

    const input = callParams.input as Array<Record<string, unknown>>;
    // System message should be extracted, only user message remains
    expect(input).toHaveLength(1);
    expect(input[0].role).toBe('user');
  });

  it('converts function_call items to OpenRouter format with callId', async () => {
    const { client, calls } = makeMockClient({
      output: [
        {
          type: 'message',
          id: 'msg-1',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'done',
            },
          ],
        },
      ],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    });

    const callModel = createOpenRouterCallModel(client as never);
    const ctx = makeMockContext();

    const fc = makeFunctionCall('search', '{"q":"test"}');
    const fco = makeFunctionCallOutput(fc.call_id, '{"results":[]}');

    await callModel({
      model: 'test-model',
      items: [
        makeMessage('user', 'search'),
        fc,
        fco,
      ],
      ctx,
    });

    const callParams = calls[0] as Record<string, unknown>;
    const input = callParams.input as Array<Record<string, unknown>>;

    // User message + function_call + function_call_output
    expect(input).toHaveLength(3);

    // function_call should use callId (SDK format) not call_id (Noetic format)
    expect(input[1].type).toBe('function_call');
    expect(input[1].callId).toBe(fc.call_id);
    expect(input[1].name).toBe('search');

    // function_call_output should use callId
    expect(input[2].type).toBe('function_call_output');
    expect(input[2].callId).toBe(fc.call_id);
  });

  it('converts function_call response items back to Noetic format', async () => {
    const { client } = makeMockClient({
      output: [
        {
          type: 'function_call',
          id: 'fc-resp-1',
          callId: 'call_123',
          name: 'search',
          arguments: '{"q":"test"}',
          status: 'completed',
        },
        {
          type: 'message',
          id: 'msg-1',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'Found results',
            },
          ],
        },
      ],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    });

    const callModel = createOpenRouterCallModel(client as never);
    const ctx = makeMockContext();

    const result = await callModel({
      model: 'test-model',
      items: [
        makeMessage('user', 'search'),
      ],
      ctx,
    });

    expect(result.items).toHaveLength(2);

    const fcItem = result.items[0];
    assert(fcItem.type === 'function_call');
    expect(fcItem.call_id).toBe('call_123');
    expect(fcItem.name).toBe('search');
    expect(fcItem.arguments).toBe('{"q":"test"}');

    const msgItem = result.items[1];
    expect(msgItem.type).toBe('message');
  });

  it('falls back to outputText when no message items in output', async () => {
    const { client } = makeMockClient({
      output: [],
      outputText: 'fallback text',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    });

    const callModel = createOpenRouterCallModel(client as never);
    const ctx = makeMockContext();

    const result = await callModel({
      model: 'test-model',
      items: [
        makeMessage('user', 'Hi'),
      ],
      ctx,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].type).toBe('message');
  });

  it('passes model params to the SDK', async () => {
    const { client, calls } = makeMockClient({
      output: [
        {
          type: 'message',
          id: 'msg-1',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'ok',
            },
          ],
        },
      ],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    });

    const callModel = createOpenRouterCallModel(client as never);
    const ctx = makeMockContext();

    await callModel({
      model: 'test-model',
      items: [
        makeMessage('user', 'Hi'),
      ],
      params: {
        temperature: 0.7,
        maxTokens: 1e3,
        topP: 0.9,
      },
      ctx,
    });

    const callParams = calls[0] as Record<string, unknown>;
    expect(callParams.temperature).toBe(0.7);
    expect(callParams.maxOutputTokens).toBe(1e3);
    expect(callParams.topP).toBe(0.9);
  });

  it('extracts cost from usage', async () => {
    const { client } = makeMockClient({
      output: [
        {
          type: 'message',
          id: 'msg-1',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'ok',
            },
          ],
        },
      ],
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cost: 0.003,
      },
    });

    const callModel = createOpenRouterCallModel(client as never);
    const ctx = makeMockContext();

    const result = await callModel({
      model: 'test-model',
      items: [
        makeMessage('user', 'Hi'),
      ],
      ctx,
    });

    expect(result.cost).toBe(0.003);
  });

  it('handles missing usage gracefully', async () => {
    const { client } = makeMockClient({
      output: [
        {
          type: 'message',
          id: 'msg-1',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'ok',
            },
          ],
        },
      ],
    });

    const callModel = createOpenRouterCallModel(client as never);
    const ctx = makeMockContext();

    const result = await callModel({
      model: 'test-model',
      items: [
        makeMessage('user', 'Hi'),
      ],
      ctx,
    });

    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.outputTokens).toBe(0);
  });

  it('skips reasoning items in input conversion', async () => {
    const { client, calls } = makeMockClient({
      output: [
        {
          type: 'message',
          id: 'msg-1',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'ok',
            },
          ],
        },
      ],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    });

    const callModel = createOpenRouterCallModel(client as never);
    const ctx = makeMockContext();

    await callModel({
      model: 'test-model',
      items: [
        makeMessage('user', 'Hi'),
        {
          id: 'reasoning-1',
          type: 'reasoning',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'thinking...',
            },
          ],
        },
      ],
      ctx,
    });

    const callParams = calls[0] as Record<string, unknown>;
    const input = callParams.input as Array<Record<string, unknown>>;
    // Reasoning item should be skipped
    expect(input).toHaveLength(1);
    expect(input[0].role).toBe('user');
  });
});
