import type { Item, MessageItem } from '@noetic/core';
import type { Message } from 'chat';

//#region Helper

function mapRole(message: Message): 'user' | 'assistant' {
  // isBot is typed boolean | 'unknown'; strict equality excludes the 'unknown' string value
  if (message.author.isMe || message.author.isBot === true) {
    return 'assistant';
  }
  return 'user';
}

function mapContentType(role: 'user' | 'assistant'): 'input_text' | 'output_text' {
  return role === 'user' ? 'input_text' : 'output_text';
}

//#endregion

//#region Public API

/**
 * Convert chat-sdk Messages to Noetic Items for use as conversation context.
 * Parallel to chat-sdk's `toAiMessages()` but produces Noetic Items.
 *
 * - Bot/self messages become assistant role with output_text
 * - User messages become user role with input_text
 * - Empty messages are filtered out
 *
 * @param messages - Array of chat-sdk Message objects
 * @returns Array of Noetic MessageItem objects
 *
 * @public
 */
export function toNoeticItems(messages: ReadonlyArray<Message>): Item[] {
  const items: MessageItem[] = [];

  for (const msg of messages) {
    if (!msg.text || msg.text.trim() === '') {
      continue;
    }

    const role = mapRole(msg);
    const contentType = mapContentType(role);

    items.push({
      id: msg.id,
      status: 'completed',
      type: 'message',
      role,
      content: [
        {
          type: contentType,
          text: msg.text,
        },
      ],
    });
  }

  return items;
}

//#endregion
