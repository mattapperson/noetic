import type { InputContentPart, InputMessageItem, Item, MessageItem } from '@noetic-tools/types';
import type { ChatAttachmentLike, ChatMessageLike } from './chat-types';

export interface ToItemsOptions {
  /** Marks a message as the assistant's own. Default: `author.isMe`. */
  isAssistant?: (message: ChatMessageLike) => boolean;
  /**
   * Renders a non-assistant message to text. Return `null` to drop the
   * message. Default prefixes the author's handle (`alice: hi`) so the model
   * can tell speakers apart in group threads.
   */
  formatMessage?: (message: ChatMessageLike) => string | null;
}

/**
 * Convert Chat SDK messages to Noetic items, oldest first. The bot's own
 * messages become assistant `MessageItem`s; everything else becomes a
 * user-role `InputMessageItem` with attachment parts. Messages that render to
 * no text and carry no usable attachment are dropped.
 */
export function toItems(
  messages: ReadonlyArray<ChatMessageLike>,
  options: ToItemsOptions = {},
): Item[] {
  const isAssistant = options.isAssistant ?? ((m: ChatMessageLike) => m.author.isMe);
  const formatMessage = options.formatMessage ?? defaultFormat;

  const ordered = [
    ...messages,
  ].sort((a, b) => a.metadata.dateSent.getTime() - b.metadata.dateSent.getTime());

  const items: Item[] = [];
  for (const message of ordered) {
    const item = isAssistant(message)
      ? toAssistantItem(message)
      : toUserItem(message, formatMessage);
    if (item) {
      items.push(item);
    }
  }
  return items;
}

function defaultFormat(message: ChatMessageLike): string | null {
  if (!message.text) {
    return null;
  }
  return message.author.userName ? `${message.author.userName}: ${message.text}` : message.text;
}

function toAssistantItem(message: ChatMessageLike): MessageItem | null {
  // Assistant content can only carry text, so attachments survive as
  // markdown links instead of vanishing from the seeded history.
  const attachmentLinks = message.attachments
    .filter((a) => a.url)
    .map((a) => `[${a.name ?? a.type}](${a.url})`);
  const text = [
    message.text,
    ...attachmentLinks,
  ]
    .filter(Boolean)
    .join('\n');
  if (!text) {
    return null;
  }
  return {
    id: message.id,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text,
      },
    ],
  };
}

function toUserItem(
  message: ChatMessageLike,
  formatMessage: (message: ChatMessageLike) => string | null,
): InputMessageItem | null {
  const content: InputContentPart[] = [];
  const text = formatMessage(message);
  if (text) {
    content.push({
      type: 'input_text',
      text,
    });
  }
  for (const attachment of message.attachments) {
    const part = toAttachmentPart(attachment);
    if (part) {
      content.push(part);
    }
  }
  if (content.length === 0) {
    return null;
  }
  return {
    id: message.id,
    type: 'message',
    role: 'user',
    status: 'completed',
    content,
  };
}

function toAttachmentPart(attachment: ChatAttachmentLike): InputContentPart | null {
  if (!attachment.url) {
    return null;
  }
  if (attachment.type === 'image') {
    return {
      type: 'input_image',
      imageUrl: attachment.url,
    };
  }
  return {
    type: 'input_file',
    fileUrl: attachment.url,
    filename: attachment.name,
  };
}
