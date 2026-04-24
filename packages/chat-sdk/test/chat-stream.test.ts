import { describe, expect, test } from 'bun:test';

import type { StreamEvent } from '@noetic/core';

import { chatStream } from '../src/chat-stream';

//#region Helpers

function createMockSource(events: StreamEvent[]): {
  getFullStream(): AsyncIterable<StreamEvent>;
} {
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
    const result = createMockSource([
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
    const result = createMockSource([
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
    const result = createMockSource([
      toolRoundCompleted('myagent'),
      textDelta('Hello'),
    ]);

    const chunks = await collectStream(chatStream(result));

    expect(chunks).toEqual([
      'Hello',
    ]);
  });

  test('no duplicate separators for consecutive tool rounds without text', async () => {
    const result = createMockSource([
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
    const result = createMockSource([
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
    const result = createMockSource([
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
    const result = createMockSource([]);

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
    const result = createMockSource([
      badDelta,
      textDelta('ok'),
    ]);

    const chunks = await collectStream(chatStream(result));

    expect(chunks).toEqual([
      'ok',
    ]);
  });

  test('works with any agent name prefix', async () => {
    const result = createMockSource([
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
