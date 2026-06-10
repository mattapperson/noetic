import { describe, expect, it } from 'bun:test';
import type { InputMessageItem, Item, MessageItem } from '../src/types/items';
import { frameworkCast } from '../src/util/framework-cast';
import { collectOutputText, isAssistantMessage, isUserMessage } from '../src/util/message-helpers';

function userMessage(text: string): InputMessageItem {
  return {
    id: 'user-1',
    type: 'message',
    role: 'user',
    status: 'completed',
    content: [
      {
        type: 'input_text',
        text,
      },
    ],
  };
}

function developerMessage(text: string): InputMessageItem {
  return {
    id: 'dev-1',
    type: 'message',
    role: 'developer',
    status: 'completed',
    content: [
      {
        type: 'input_text',
        text,
      },
    ],
  };
}

function assistantMessage(text: string): MessageItem {
  return frameworkCast<MessageItem>({
    id: 'asst-1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text,
      },
    ],
  });
}

function functionCallOutput(): Item {
  return {
    id: 'fco-1',
    type: 'function_call_output',
    status: 'completed',
    callId: 'call-1',
    output: 'tool output',
  };
}

describe('isUserMessage', () => {
  it('runtime truth table', () => {
    expect(isUserMessage(userMessage('hi'))).toBe(true);
    expect(isUserMessage(assistantMessage('hello'))).toBe(false);
    expect(isUserMessage(developerMessage('rule'))).toBe(false);
    expect(isUserMessage(functionCallOutput())).toBe(false);
    expect(isUserMessage(null)).toBe(false);
    expect(isUserMessage(undefined)).toBe(false);
    expect(isUserMessage('message')).toBe(false);
    expect(
      isUserMessage({
        type: 'message',
      }),
    ).toBe(false);
  });

  it('narrows to UserMessageItem (compile-time lock: role is the user literal)', () => {
    const item: Item = userMessage('typed');
    expect(isUserMessage(item)).toBe(true);
    if (isUserMessage(item)) {
      // Compile-time lock: if the predicate ever regresses to a type whose
      // role is not 'user' (e.g. the assistant-roled MessageItem), this
      // assignment stops compiling.
      const role: 'user' = item.role;
      expect(role).toBe('user');
      // InputMessageItem content: input parts, not output parts.
      const firstPart = item.content[0];
      expect(firstPart.type).toBe('input_text');
    }
  });
});

describe('isAssistantMessage', () => {
  it('runtime truth table', () => {
    expect(isAssistantMessage(assistantMessage('hello'))).toBe(true);
    expect(isAssistantMessage(userMessage('hi'))).toBe(false);
    expect(isAssistantMessage(developerMessage('rule'))).toBe(false);
    expect(isAssistantMessage(functionCallOutput())).toBe(false);
    expect(isAssistantMessage(null)).toBe(false);
  });
});

describe('collectOutputText', () => {
  it('collects assistant output text only from mixed items', () => {
    const items: Item[] = [
      userMessage('user input'),
      assistantMessage('first answer'),
      developerMessage('developer rule'),
      functionCallOutput(),
      assistantMessage('second answer'),
    ];

    expect(collectOutputText(items)).toEqual([
      'first answer',
      'second answer',
    ]);
  });

  it('returns empty for input-only items', () => {
    expect(
      collectOutputText([
        userMessage('only input'),
        functionCallOutput(),
      ]),
    ).toEqual([]);
  });
});
