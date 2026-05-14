import type { InputMessageItem, MessageItem } from '@noetic-tools/core';
import type { Message } from 'chat';

//#region Helper

function isAssistant(message: Message): boolean {
  return message.author.isMe || message.author.isBot === true;
}

function toAssistantItem(msg: Message): MessageItem {
  return {
    id: msg.id,
    status: 'completed',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text: msg.text,
        annotations: [],
      },
    ],
  };
}

function toUserItem(msg: Message): InputMessageItem {
  return {
    id: msg.id,
    status: 'completed',
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: msg.text,
      },
    ],
  };
}

//#endregion

//#region Public API

/**
 * Convert chat-sdk Messages to Noetic Items for use as conversation context.
 *
 * @public
 */
export function toNoeticItems(
  messages: ReadonlyArray<Message>,
): Array<InputMessageItem | MessageItem> {
  const items: Array<InputMessageItem | MessageItem> = [];

  for (const msg of messages) {
    if (!msg.text || msg.text.trim() === '') {
      continue;
    }

    items.push(isAssistant(msg) ? toAssistantItem(msg) : toUserItem(msg));
  }

  return items;
}

//#endregion
