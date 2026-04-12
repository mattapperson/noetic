/**
 * Shared utilities for processing StreamableOutputItem from @openrouter/agent.
 */

import type { Item, StreamingItem } from '@noetic/core';

//#region Types

export interface UserEntry {
  role: 'user';
  content: string;
}

export type AssistantEntry = Item | StreamingItem;
export type ConversationEntry = AssistantEntry | UserEntry;
type MessageContentPart = Extract<
  AssistantEntry,
  {
    type: 'message';
  }
>['content'][number];

//#endregion

//#region Type Guards

export function isUserEntry(entry: ConversationEntry): entry is UserEntry {
  return 'role' in entry && entry.role === 'user';
}

//#endregion

//#region Item ID

let anonCounter = 0;

export function getItemId(item: AssistantEntry): string {
  if (item.type === 'function_call') {
    return `call-${item.callId}`;
  }
  if (item.type === 'function_call_output') {
    return item.id ?? `call-output-${item.callId}`;
  }
  return item.id ?? `anon-${++anonCounter}`;
}

//#endregion

//#region Text Extraction

export function extractTextContent(item: AssistantEntry): string {
  if (item.type !== 'message') {
    return '';
  }
  if (!Array.isArray(item.content)) {
    return '';
  }
  return item.content
    .filter(
      (
        part: MessageContentPart,
      ): part is {
        type: 'output_text';
        text: string;
      } => part.type === 'output_text',
    )
    .map((part: { type: 'output_text'; text: string }) => part.text)
    .join('');
}

export function extractReasoning(item: AssistantEntry): string | undefined {
  if (item.type !== 'reasoning') {
    return undefined;
  }
  if (!Array.isArray(item.content)) {
    return undefined;
  }
  const texts: string[] = [];
  for (const part of item.content) {
    if (
      typeof part === 'object' &&
      part !== null &&
      'type' in part &&
      part.type === 'reasoning_text' &&
      'text' in part &&
      typeof part.text === 'string'
    ) {
      texts.push(part.text);
    }
  }
  return texts.join('') || undefined;
}

//#endregion

//#region Entry Deduplication

export function appendOrUpdateEntry(
  prev: ConversationEntry[],
  item: AssistantEntry,
): ConversationEntry[] {
  const id = getItemId(item);
  const idx = prev.findIndex((existing) => {
    if (isUserEntry(existing)) {
      return false;
    }
    return getItemId(existing) === id;
  });
  if (idx >= 0) {
    const next = [
      ...prev,
    ];
    next[idx] = item;
    return next;
  }
  return [
    ...prev,
    item,
  ];
}

//#endregion
