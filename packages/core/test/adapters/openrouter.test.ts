import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { OpenResponsesResult } from '@openrouter/agent';

type OpenResponsesNonStreamingResponse = OpenResponsesResult;

type ResponsesOutputItem = OpenResponsesNonStreamingResponse['output'][number];

import {
  extractOutputItems,
  extractSystemInstruction,
  extractUsage,
  itemsToInput,
} from '../../src/adapters/openrouter';
import type { Item, ReasoningItem } from '../../src/types/items';
import { frameworkCast } from '../../src/util/framework-cast';
import { makeFunctionCall, makeFunctionCallOutput, makeMessage } from '../_helpers';

describe('extractSystemInstruction', () => {
  it('extracts system messages as instructions', () => {
    const items = [
      makeMessage('system', 'You are helpful'),
      makeMessage('user', 'Hello'),
    ];
    const { instructions, remaining } = extractSystemInstruction(items);
    expect(instructions).toBe('You are helpful');
    expect(remaining).toHaveLength(1);
    assert(remaining[0].type === 'message');
  });

  it('returns undefined instructions when no system messages', () => {
    const items = [
      makeMessage('user', 'Hello'),
    ];
    const { instructions, remaining } = extractSystemInstruction(items);
    expect(instructions).toBeUndefined();
    expect(remaining).toHaveLength(1);
  });
});

describe('itemsToInput', () => {
  it('converts user messages to SDK input format', () => {
    const items = [
      makeMessage('user', 'Hello'),
    ];
    const input = itemsToInput(items);
    expect(input).toHaveLength(1);
    expect(
      frameworkCast<{
        role: string;
      }>(input[0]).role,
    ).toBe('user');
  });

  it('preserves structured user message parts for provider input', () => {
    const item: Item = {
      id: 'msg-with-attachments',
      type: 'message',
      role: 'user',
      status: 'completed',
      content: [
        {
          type: 'input_text',
          text: 'inspect this',
        },
        {
          type: 'input_image',
          imageUrl: 'data:image/png;base64,aGVsbG8=',
          detail: 'auto',
        },
        {
          type: 'input_file',
          filename: 'notes.txt',
          fileData: 'data:text/plain;base64,aGVsbG8=',
        },
      ],
    };

    const input = itemsToInput([
      item,
    ]);

    expect(input).toHaveLength(1);
    const message = frameworkCast<{
      content: ReadonlyArray<{
        type: string;
      }>;
    }>(input[0]);
    expect(message.content.map((part) => part.type)).toEqual([
      'input_text',
      'input_image',
      'input_file',
    ]);
  });

  it('converts function_call items to OpenRouter format with callId', () => {
    const fc = makeFunctionCall('search', '{"q":"test"}');
    const fco = makeFunctionCallOutput(fc.callId, '{"results":[]}');

    const input = itemsToInput([
      makeMessage('user', 'search'),
      fc,
      fco,
    ]);

    // User message + function_call + function_call_output
    expect(input).toHaveLength(3);

    // function_call should use callId (SDK format)
    expect(input[1].type).toBe('function_call');
    expect(
      frameworkCast<{
        callId: string;
      }>(input[1]).callId,
    ).toBe(fc.callId);

    // function_call_output should use callId
    expect(input[2].type).toBe('function_call_output');
    expect(
      frameworkCast<{
        callId: string;
      }>(input[2]).callId,
    ).toBe(fc.callId);
  });

  it('passes reasoning items through for round-tripping', () => {
    const reasoning = frameworkCast<ReasoningItem>({
      id: 'reasoning-1',
      type: 'reasoning',
      status: 'completed',
      summary: [
        {
          type: 'summary_text',
          text: 'thinking...',
        },
      ],
    });
    const input = itemsToInput([
      makeMessage('user', 'Hi'),
      reasoning,
    ]);
    // Both items should be included
    expect(input).toHaveLength(2);
  });

  it('passes extension items through for round-tripping', () => {
    const webSearch = frameworkCast<Item>({
      type: 'openrouter:web_search',
      id: 'ws-1',
      status: 'completed',
    });
    const input = itemsToInput([
      makeMessage('user', 'Hi'),
      webSearch,
    ]);
    expect(input).toHaveLength(2);
  });
});

describe('extractOutputItems', () => {
  it('passes SDK output items through directly', () => {
    const sdkResponse = frameworkCast<OpenResponsesNonStreamingResponse>({
      id: 'resp-1',
      object: 'response',
      createdAt: Date.now(),
      status: 'completed',
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
        } satisfies ResponsesOutputItem,
      ],
      outputText: 'Hello world',
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

    const items = extractOutputItems(sdkResponse);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('message');
  });

  it('preserves reasoning items from SDK output', () => {
    const sdkResponse = frameworkCast<OpenResponsesNonStreamingResponse>({
      id: 'resp-1',
      object: 'response',
      createdAt: Date.now(),
      status: 'completed',
      output: [
        {
          type: 'reasoning',
          id: 'r-1',
          status: 'completed',
          summary: [
            {
              type: 'summary_text',
              text: 'Considering the question...',
            },
          ],
        } satisfies ResponsesOutputItem,
        {
          type: 'message',
          id: 'msg-1',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'The answer is 42',
              annotations: [],
            },
          ],
        } satisfies ResponsesOutputItem,
      ],
      outputText: 'The answer is 42',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        inputTokensDetails: {
          cachedTokens: 0,
        },
        outputTokensDetails: {
          reasoningTokens: 20,
        },
        totalTokens: 35,
      },
    });

    const items = extractOutputItems(sdkResponse);
    expect(items).toHaveLength(2);
    expect(items[0].type).toBe('reasoning');
    expect(items[1].type).toBe('message');
  });

  it('preserves web_search_call items from SDK output', () => {
    const sdkResponse = frameworkCast<OpenResponsesNonStreamingResponse>({
      id: 'resp-1',
      object: 'response',
      createdAt: Date.now(),
      status: 'completed',
      output: [
        {
          type: 'web_search_call',
          id: 'ws-1',
          status: 'completed',
          action: {
            type: 'search',
            query: 'test query',
          },
        } satisfies ResponsesOutputItem,
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
        } satisfies ResponsesOutputItem,
      ],
      outputText: 'Found results',
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

    const items = extractOutputItems(sdkResponse);
    expect(items).toHaveLength(2);
    expect(items[0].type).toBe('web_search_call');
    expect(items[1].type).toBe('message');
  });

  it('preserves function_call items from SDK output', () => {
    const sdkResponse = frameworkCast<OpenResponsesNonStreamingResponse>({
      id: 'resp-1',
      object: 'response',
      createdAt: Date.now(),
      status: 'completed',
      output: [
        {
          type: 'function_call',
          id: 'fc-resp-1',
          callId: 'call_123',
          name: 'search',
          arguments: '{"q":"test"}',
          status: 'completed',
        } satisfies ResponsesOutputItem,
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
        } satisfies ResponsesOutputItem,
      ],
      outputText: 'Found results',
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

    const items = extractOutputItems(sdkResponse);
    expect(items).toHaveLength(2);

    const fcItem = items[0];
    assert(fcItem.type === 'function_call');

    const msgItem = items[1];
    expect(msgItem.type).toBe('message');
  });

  it('falls back to outputText when no message items in output', () => {
    const sdkResponse = frameworkCast<OpenResponsesNonStreamingResponse>({
      id: 'resp-1',
      object: 'response',
      createdAt: Date.now(),
      status: 'completed',
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

    const items = extractOutputItems(sdkResponse);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('message');
  });
});

describe('extractUsage', () => {
  it('extracts usage from SDK response', () => {
    const usage = extractUsage({
      inputTokens: 100,
      outputTokens: 50,
      inputTokensDetails: {
        cachedTokens: 2,
      },
      outputTokensDetails: {
        reasoningTokens: 0,
      },
      totalTokens: 150,
      cost: 0.003,
    });

    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
    expect(usage.cachedTokens).toBe(2);
  });

  it('handles missing usage gracefully', () => {
    const usage = extractUsage(undefined);
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
  });
});
