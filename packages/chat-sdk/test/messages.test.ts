import { describe, expect, test } from 'bun:test';

import type { InputMessageItem, Item, MessageItem } from '@noetic-tools/core';
import { Message, parseMarkdown } from 'chat';

import { toNoeticItems } from '../src/messages';

//#region Helpers

function createMessage(overrides: {
  id?: string;
  text?: string;
  isBot?: boolean | 'unknown';
  isMe?: boolean;
}): Message {
  return new Message({
    id: overrides.id ?? crypto.randomUUID(),
    threadId: 'thread-1',
    text: overrides.text ?? 'Hello',
    formatted: parseMarkdown(overrides.text ?? 'Hello'),
    raw: {},
    author: {
      userId: 'u1',
      userName: 'testuser',
      fullName: 'Test User',
      isBot: overrides.isBot ?? false,
      isMe: overrides.isMe ?? false,
    },
    metadata: {
      dateSent: new Date(),
      edited: false,
    },
    attachments: [],
  });
}

function isAssistantItem(item: Item): item is MessageItem {
  return item.type === 'message' && 'role' in item && item.role === 'assistant';
}

function isUserItem(item: Item): item is InputMessageItem {
  return item.type === 'message' && 'role' in item && item.role === 'user';
}

function getAssistantItem(items: Item[], index: number): MessageItem {
  const item = items[index];
  if (!isAssistantItem(item)) {
    throw new Error(`Expected assistant MessageItem at index ${index}`);
  }
  return item;
}

function getUserItem(items: Item[], index: number): InputMessageItem {
  const item = items[index];
  if (!isUserItem(item)) {
    throw new Error(`Expected user InputMessageItem at index ${index}`);
  }
  return item;
}

//#endregion

describe('toNoeticItems', () => {
  test('converts user message to user role with input_text', () => {
    const msg = createMessage({
      id: 'msg-1',
      text: 'Hi there',
    });

    const items = toNoeticItems([
      msg,
    ]);

    expect(items).toHaveLength(1);
    const item = getUserItem(items, 0);
    expect(item.type).toBe('message');
    expect(item.role).toBe('user');
    expect(item.id).toBe('msg-1');
    expect(item.status).toBe('completed');
    expect(item.content).toEqual([
      {
        type: 'input_text',
        text: 'Hi there',
      },
    ]);
  });

  test('converts bot message to assistant role with output_text', () => {
    const msg = createMessage({
      text: 'Bot response',
      isBot: true,
    });

    const items = toNoeticItems([
      msg,
    ]);

    expect(items).toHaveLength(1);
    const item = getAssistantItem(items, 0);
    expect(item.role).toBe('assistant');
    expect(item.content).toEqual([
      {
        type: 'output_text',
        text: 'Bot response',
        annotations: [],
      },
    ]);
  });

  test('converts isMe message to assistant role', () => {
    const msg = createMessage({
      text: 'My message',
      isMe: true,
    });

    const items = toNoeticItems([
      msg,
    ]);

    const item = getAssistantItem(items, 0);
    expect(item.role).toBe('assistant');
  });

  test('filters out empty messages', () => {
    const messages = [
      createMessage({
        text: '',
      }),
      createMessage({
        text: '  ',
      }),
      createMessage({
        text: 'Valid',
      }),
    ];

    const items = toNoeticItems(messages);

    expect(items).toHaveLength(1);
    const item = getUserItem(items, 0);
    const part = item.content[0];
    if (part.type !== 'input_text') {
      throw new Error('Expected input_text content part');
    }
    expect(part.text).toBe('Valid');
  });

  test('preserves message order', () => {
    const messages = [
      createMessage({
        text: 'First',
        id: 'a',
      }),
      createMessage({
        text: 'Second',
        id: 'b',
      }),
      createMessage({
        text: 'Third',
        id: 'c',
      }),
    ];

    const items = toNoeticItems(messages);

    expect(items).toHaveLength(3);
    expect(items[0].id).toBe('a');
    expect(items[1].id).toBe('b');
    expect(items[2].id).toBe('c');
  });

  test('handles empty array', () => {
    const items = toNoeticItems([]);
    expect(items).toEqual([]);
  });

  test('treats isBot "unknown" as user', () => {
    const msg = createMessage({
      text: 'Unknown bot',
      isBot: 'unknown',
    });

    const items = toNoeticItems([
      msg,
    ]);

    const item = getUserItem(items, 0);
    expect(item.role).toBe('user');
  });

  test('isMe takes precedence over isBot false', () => {
    const msg = createMessage({
      text: 'Self',
      isMe: true,
      isBot: false,
    });

    const items = toNoeticItems([
      msg,
    ]);

    const item = getAssistantItem(items, 0);
    expect(item.role).toBe('assistant');
  });
});
