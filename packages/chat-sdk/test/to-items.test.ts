import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import type { InputMessageItem, Item, MessageItem } from '@noetic-tools/types';
import { toItems } from '../src/to-items';
import { chatMessage, itemIds } from './_helpers';

function asUserItem(item: Item): InputMessageItem {
  assert(item.type === 'message');
  assert(item.role === 'user');
  return item;
}

function asAssistantItem(item: Item): MessageItem {
  assert(item.type === 'message');
  assert(item.role === 'assistant');
  return item;
}

describe('toItems', () => {
  test('maps a user message to an InputMessageItem with the author prefixed', () => {
    const items = toItems([
      chatMessage({
        id: 'm1',
        text: 'hello',
        userName: 'alice',
      }),
    ]);
    expect(items).toHaveLength(1);
    const item = asUserItem(items[0]);
    expect(item.id).toBe('m1');
    expect(item.status).toBe('completed');
    expect(item.content).toEqual([
      {
        type: 'input_text',
        text: 'alice: hello',
      },
    ]);
  });

  test("maps the bot's own message to an assistant MessageItem without prefix", () => {
    const items = toItems([
      chatMessage({
        id: 'm2',
        text: 'hi there',
        isMe: true,
      }),
    ]);
    expect(items).toHaveLength(1);
    const item = asAssistantItem(items[0]);
    expect(item.id).toBe('m2');
    expect(item.content).toEqual([
      {
        type: 'output_text',
        text: 'hi there',
      },
    ]);
  });

  test('maps attachments to input_image and input_file parts', () => {
    const items = toItems([
      chatMessage({
        id: 'm3',
        text: 'see these',
        userName: 'bob',
        attachments: [
          {
            type: 'image',
            url: 'https://x/img.png',
          },
          {
            type: 'file',
            url: 'https://x/doc.pdf',
            name: 'doc.pdf',
          },
          {
            type: 'file',
            name: 'no-url.txt',
          },
        ],
      }),
    ]);
    const item = asUserItem(items[0]);
    expect(item.content).toEqual([
      {
        type: 'input_text',
        text: 'bob: see these',
      },
      {
        type: 'input_image',
        imageUrl: 'https://x/img.png',
      },
      {
        type: 'input_file',
        fileUrl: 'https://x/doc.pdf',
        filename: 'doc.pdf',
      },
    ]);
  });

  test('sorts messages by dateSent ascending', () => {
    const items = toItems([
      chatMessage({
        id: 'later',
        text: 'second',
        dateSent: new Date(2000),
      }),
      chatMessage({
        id: 'earlier',
        text: 'first',
        dateSent: new Date(1000),
      }),
    ]);
    expect(itemIds(items)).toEqual([
      'earlier',
      'later',
    ]);
  });

  test('formatMessage returning null drops the message', () => {
    const items = toItems(
      [
        chatMessage({
          id: 'm4',
          text: 'secret',
        }),
      ],
      {
        formatMessage: () => null,
      },
    );
    expect(items).toEqual([]);
  });

  test('formatMessage transform replaces the default rendering', () => {
    const items = toItems(
      [
        chatMessage({
          id: 'm5',
          text: 'yo',
          userName: 'carol',
        }),
      ],
      {
        formatMessage: (m) => m.text.toUpperCase(),
      },
    );
    const item = asUserItem(items[0]);
    expect(item.content).toEqual([
      {
        type: 'input_text',
        text: 'YO',
      },
    ]);
  });

  test('custom isAssistant overrides isMe detection', () => {
    const items = toItems(
      [
        chatMessage({
          id: 'm6',
          text: 'bot said',
          userName: 'otherbot',
        }),
      ],
      {
        isAssistant: (m) => m.author.userName === 'otherbot',
      },
    );
    expect(asAssistantItem(items[0]).role).toBe('assistant');
  });

  test('keeps assistant attachments as markdown links', () => {
    const items = toItems([
      chatMessage({
        id: 'm9',
        text: 'here you go',
        isMe: true,
        attachments: [
          {
            type: 'image',
            url: 'https://x/chart.png',
            name: 'chart.png',
          },
          {
            type: 'file',
            name: 'no-url.txt',
          },
        ],
      }),
    ]);
    const item = asAssistantItem(items[0]);
    expect(item.content).toEqual([
      {
        type: 'output_text',
        text: 'here you go\n[chart.png](https://x/chart.png)',
      },
    ]);
  });

  test('an image-only assistant message survives as its link', () => {
    const items = toItems([
      chatMessage({
        id: 'm10',
        isMe: true,
        attachments: [
          {
            type: 'image',
            url: 'https://x/only.png',
          },
        ],
      }),
    ]);
    const item = asAssistantItem(items[0]);
    expect(item.content).toEqual([
      {
        type: 'output_text',
        text: '[image](https://x/only.png)',
      },
    ]);
  });

  test('drops empty-text messages with no usable attachments', () => {
    expect(
      toItems([
        chatMessage({
          id: 'm7',
        }),
      ]),
    ).toEqual([]);
    expect(
      toItems([
        chatMessage({
          id: 'm8',
          isMe: true,
        }),
      ]),
    ).toEqual([]);
  });

  test('returns empty for empty input', () => {
    expect(toItems([])).toEqual([]);
  });
});
