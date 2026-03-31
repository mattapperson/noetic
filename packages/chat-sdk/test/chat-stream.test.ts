import { describe, expect, test } from 'bun:test';

import type { HarnessResult, StreamEvent } from '@noetic/core';

import { chatStream } from '../src/chat-stream';

//#region Helpers

function emptyAsyncIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        async next(): Promise<IteratorResult<T>> {
          return {
            done: true,
            value: undefined,
          };
        },
      };
    },
  };
}

function createMockResult(events: StreamEvent[]): HarnessResult {
  const fullStream: AsyncIterable<StreamEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
      let index = 0;
      return {
        async next(): Promise<IteratorResult<StreamEvent>> {
          if (index >= events.length) {
            return {
              done: true,
              value: undefined,
            };
          }
          const value = events[index];
          index++;
          return {
            done: false,
            value,
          };
        },
      };
    },
  };

  return {
    getText: () => Promise.resolve(''),
    getResponse: () =>
      Promise.resolve({
        items: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
        cost: 0,
        text: '',
      }),
    getTextStream: () => emptyAsyncIterable<string>(),
    getReasoningStream: () => emptyAsyncIterable<string>(),
    getItemStream: () => emptyAsyncIterable(),
    getFullStream: () => fullStream,
  };
}

function textDelta(delta: string): StreamEvent {
  return {
    source: 'sdk',
    type: 'response.output_text.delta',
    data: {
      delta,
    },
  };
}

function toolRoundCompleted(agentName: string): StreamEvent {
  return {
    source: 'framework',
    type: `${agentName}:tool_round_completed`,
    data: {
      round: 1,
      toolCount: 1,
    },
  };
}

function reasoningDelta(delta: string): StreamEvent {
  return {
    source: 'sdk',
    type: 'response.reasoning.delta',
    data: {
      delta,
    },
  };
}

async function collectStream(stream: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

//#endregion

describe('chatStream', () => {
  test('yields text deltas', async () => {
    const result = createMockResult([
      textDelta('Hello'),
      textDelta(' world'),
    ]);

    const chunks = await collectStream(chatStream(result));

    expect(chunks).toEqual([
      'Hello',
      ' world',
    ]);
  });

  test('injects paragraph break on tool_round_completed', async () => {
    const result = createMockResult([
      textDelta('Step 1'),
      toolRoundCompleted('myagent'),
      textDelta('Step 2'),
    ]);

    const chunks = await collectStream(chatStream(result));

    expect(chunks).toEqual([
      'Step 1',
      '\n\n',
      'Step 2',
    ]);
  });

  test('no leading separator when first event is tool_round_completed', async () => {
    const result = createMockResult([
      toolRoundCompleted('myagent'),
      textDelta('Hello'),
    ]);

    const chunks = await collectStream(chatStream(result));

    expect(chunks).toEqual([
      'Hello',
    ]);
  });

  test('no duplicate separators for consecutive tool rounds without text', async () => {
    const result = createMockResult([
      textDelta('Start'),
      toolRoundCompleted('myagent'),
      toolRoundCompleted('myagent'),
      textDelta('End'),
    ]);

    const chunks = await collectStream(chatStream(result));

    expect(chunks).toEqual([
      'Start',
      '\n\n',
      'End',
    ]);
  });

  test('ignores non-text SDK events', async () => {
    const result = createMockResult([
      reasoningDelta('thinking...'),
      textDelta('Hello'),
    ]);

    const chunks = await collectStream(chatStream(result));

    expect(chunks).toEqual([
      'Hello',
    ]);
  });

  test('ignores framework events other than tool_round_completed', async () => {
    const stepStarted: StreamEvent = {
      source: 'framework',
      type: 'myagent:step_started',
      data: {},
    };
    const result = createMockResult([
      textDelta('Hello'),
      stepStarted,
      textDelta(' world'),
    ]);

    const chunks = await collectStream(chatStream(result));

    expect(chunks).toEqual([
      'Hello',
      ' world',
    ]);
  });

  test('handles empty stream', async () => {
    const result = createMockResult([]);

    const chunks = await collectStream(chatStream(result));

    expect(chunks).toEqual([]);
  });

  test('ignores non-string delta values', async () => {
    const badDelta: StreamEvent = {
      source: 'sdk',
      type: 'response.output_text.delta',
      data: {
        delta: 42,
      },
    };
    const result = createMockResult([
      badDelta,
      textDelta('ok'),
    ]);

    const chunks = await collectStream(chatStream(result));

    expect(chunks).toEqual([
      'ok',
    ]);
  });

  test('works with any agent name prefix', async () => {
    const result = createMockResult([
      textDelta('A'),
      toolRoundCompleted('custom-agent-v2'),
      textDelta('B'),
    ]);

    const chunks = await collectStream(chatStream(result));

    expect(chunks).toEqual([
      'A',
      '\n\n',
      'B',
    ]);
  });
});
