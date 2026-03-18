import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  OpenResponsesNonStreamingResponse,
  ResponsesOutputItem,
} from '@openrouter/sdk/models';
import { z } from 'zod';
import type { OpenRouterClientLike } from '../../src/adapters/openrouter';
import { createOpenRouterCallModel } from '../../src/adapters/openrouter';
import {
  makeFunctionCall,
  makeFunctionCallOutput,
  makeMessage,
  makeMockContext,
} from '../_helpers';

//#region Schemas

const CallParamsSchema = z.record(z.string(), z.unknown());
const InputArraySchema = z.array(z.record(z.string(), z.unknown()));

//#endregion

//#region Mock Factory

// Base response shape shared by all mock responses
const BASE_RESPONSE = {
  id: 'resp-1',
  object: 'response',
  createdAt: 0,
  model: 'test-model',
  status: 'completed',
  completedAt: 0,
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
} satisfies Omit<OpenResponsesNonStreamingResponse, 'output' | 'outputText' | 'usage'>;

// Minimal mock of OpenRouter client
function makeMockClient(response: {
  output: ResponsesOutputItem[];
  outputText?: string;
  usage?: OpenResponsesNonStreamingResponse['usage'];
}): {
  client: OpenRouterClientLike;
  calls: unknown[];
} {
  const calls: unknown[] = [];

  const client: OpenRouterClientLike = {
    callModel(params) {
      calls.push(params);
      return {
        async getResponse(): Promise<OpenResponsesNonStreamingResponse> {
          return {
            ...BASE_RESPONSE,
            createdAt: Date.now(),
            completedAt: Date.now(),
            ...response,
          };
        },
      };
    },
  };

  return {
    client,
    calls,
  };
}

//#endregion

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
              annotations: [],
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
        outputTokensDetails: {
          reasoningTokens: 0,
        },
        totalTokens: 15,
      },
    });

    const callModel = createOpenRouterCallModel(client);
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
              annotations: [],
            },
          ],
        },
      ],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        inputTokensDetails: {
          cachedTokens: 0,
        },
        outputTokensDetails: {
          reasoningTokens: 0,
        },
        totalTokens: 0,
      },
    });

    const callModel = createOpenRouterCallModel(client);
    const ctx = makeMockContext();

    await callModel({
      model: 'test-model',
      items: [
        makeMessage('system', 'You are helpful'),
        makeMessage('user', 'Hello'),
      ],
      ctx,
    });

    const callParams = CallParamsSchema.parse(calls[0]);
    expect(callParams.instructions).toBe('You are helpful');

    const input = InputArraySchema.parse(callParams.input);
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
              annotations: [],
            },
          ],
        },
      ],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        inputTokensDetails: {
          cachedTokens: 0,
        },
        outputTokensDetails: {
          reasoningTokens: 0,
        },
        totalTokens: 0,
      },
    });

    const callModel = createOpenRouterCallModel(client);
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

    const callParams = CallParamsSchema.parse(calls[0]);
    const input = InputArraySchema.parse(callParams.input);

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
              annotations: [],
            },
          ],
        },
      ],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        inputTokensDetails: {
          cachedTokens: 0,
        },
        outputTokensDetails: {
          reasoningTokens: 0,
        },
        totalTokens: 0,
      },
    });

    const callModel = createOpenRouterCallModel(client);
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
        inputTokensDetails: {
          cachedTokens: 0,
        },
        outputTokensDetails: {
          reasoningTokens: 0,
        },
        totalTokens: 0,
      },
    });

    const callModel = createOpenRouterCallModel(client);
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
              annotations: [],
            },
          ],
        },
      ],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        inputTokensDetails: {
          cachedTokens: 0,
        },
        outputTokensDetails: {
          reasoningTokens: 0,
        },
        totalTokens: 0,
      },
    });

    const callModel = createOpenRouterCallModel(client);
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

    const callParams = CallParamsSchema.parse(calls[0]);
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
              annotations: [],
            },
          ],
        },
      ],
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        inputTokensDetails: {
          cachedTokens: 0,
        },
        outputTokensDetails: {
          reasoningTokens: 0,
        },
        totalTokens: 150,
        cost: 0.003,
      },
    });

    const callModel = createOpenRouterCallModel(client);
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
              annotations: [],
            },
          ],
        },
      ],
    });

    const callModel = createOpenRouterCallModel(client);
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
              annotations: [],
            },
          ],
        },
      ],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        inputTokensDetails: {
          cachedTokens: 0,
        },
        outputTokensDetails: {
          reasoningTokens: 0,
        },
        totalTokens: 0,
      },
    });

    const callModel = createOpenRouterCallModel(client);
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

    const callParams = CallParamsSchema.parse(calls[0]);
    const input = InputArraySchema.parse(callParams.input);
    // Reasoning item should be skipped
    expect(input).toHaveLength(1);
    expect(input[0].role).toBe('user');
  });
});
