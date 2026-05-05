import type { InputMessageItem, Item, MessageItem } from '../types/items';

export function isAssistantMessage(item: unknown): item is MessageItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    item.type === 'message' &&
    'role' in item &&
    item.role === 'assistant'
  );
}

export function isUserMessage(item: unknown): item is MessageItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    item.type === 'message' &&
    'role' in item &&
    item.role === 'user'
  );
}

export function isOutputText(part: { type: string }): part is {
  type: 'output_text';
  text: string;
} {
  return part.type === 'output_text';
}

export function createMessage(text: string, role: 'user' | 'developer'): InputMessageItem {
  return {
    id: crypto.randomUUID(),
    status: 'completed',
    type: 'message',
    role,
    content: [
      {
        type: 'input_text',
        text,
      },
    ],
  };
}

export function extractAssistantText(items: ReadonlyArray<Item>): string {
  const lastMsg = items.findLast(isAssistantMessage);

  if (!lastMsg) {
    return '';
  }

  return (
    lastMsg.content
      ?.filter(isOutputText)
      ?.map((c: { text: string }) => c.text)
      ?.join('') ?? ''
  );
}

/** Naive token estimate: ~4 chars per token */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
