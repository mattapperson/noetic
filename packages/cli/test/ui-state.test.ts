import { describe, expect, it } from 'bun:test';
import { appendOrUpdateEntry, extractReasoning, extractTextContent, getItemId } from '../src/tui/item-utils.js';

const assistantMessage = {
  id: 'msg-1',
  type: 'message' as const,
  role: 'assistant' as const,
  status: 'in_progress' as const,
  content: [
    {
      type: 'output_text' as const,
      text: 'hello',
    },
  ],
};

describe('tui item utils', () => {
  it('extracts text content from assistant messages', () => {
    expect(extractTextContent(assistantMessage)).toBe('hello');
  });

  it('returns empty string for non-message entries', () => {
    expect(
      extractTextContent({
        id: 'fc-1',
        type: 'function_call',
        callId: 'call-1',
        name: 'Read',
        arguments: '{}',
        status: 'completed',
      }),
    ).toBe('');
  });

  it('extracts reasoning text', () => {
    expect(
      extractReasoning({
        id: 'r-1',
        type: 'reasoning',
        status: 'completed',
        content: [
          {
            type: 'reasoning_text',
            text: 'thinking',
          },
        ],
        summary: [],
      }),
    ).toBe('thinking');
  });

  it('uses callId-based ids for tool calls', () => {
    expect(
      getItemId({
        id: 'fc-1',
        type: 'function_call',
        callId: 'call-abc',
        name: 'Read',
        arguments: '{}',
        status: 'completed',
      }),
    ).toBe('call-call-abc');
  });

  it('adds assistant entries to the conversation list', () => {
    const assistantEntry = {
      id: 'msg-1',
      type: 'message' as const,
      role: 'assistant' as const,
      status: 'completed' as const,
      content: [
        {
          type: 'output_text' as const,
          text: 'hello back',
        },
      ],
    };

    const updated = appendOrUpdateEntry([], assistantEntry);

    expect(updated).toHaveLength(1);
    expect(updated[0]).toBe(assistantEntry);
    expect(extractTextContent(assistantEntry)).toBe('hello back');
  });
});
