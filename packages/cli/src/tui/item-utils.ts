/**
 * Shared utilities for processing StreamableOutputItem from @openrouter/agent.
 */

import type { Item, StreamingItem } from '@noetic/core';

//#region Types

export interface UserEntry {
  role: 'user';
  content: string;
}

export interface ErrorEntry {
  role: 'system';
  type: 'error';
  content: string;
}

export interface SystemEntry {
  role: 'system';
  type: 'info';
  content: string;
}

export interface JsxEntry {
  role: 'system';
  type: 'jsx';
  node: import('react').ReactNode;
  key: string;
}

export type AssistantEntry = Item | StreamingItem;
export type ConversationEntry = AssistantEntry | UserEntry | ErrorEntry | SystemEntry | JsxEntry;
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

export function isErrorEntry(entry: ConversationEntry): entry is ErrorEntry {
  return 'role' in entry && entry.role === 'system' && 'type' in entry && entry.type === 'error';
}

export function isSystemEntry(entry: ConversationEntry): entry is SystemEntry {
  return 'role' in entry && entry.role === 'system' && 'type' in entry && entry.type === 'info';
}

export function isJsxEntry(entry: ConversationEntry): entry is JsxEntry {
  return 'role' in entry && entry.role === 'system' && 'type' in entry && entry.type === 'jsx';
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
    if (isUserEntry(existing) || isErrorEntry(existing) || isSystemEntry(existing) || isJsxEntry(existing)) {
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

//#region Skill Activation Tracking

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasStringName(obj: Record<string, unknown>): obj is Record<string, unknown> & {
  name: string;
} {
  return typeof obj.name === 'string';
}

/**
 * Extract activated skill names from conversation entries.
 * Looks for completed function_call items with name 'activateSkill'.
 */
export function extractActivatedSkills(entries: ReadonlyArray<ConversationEntry>): Set<string> {
  const activated = new Set<string>();

  for (const entry of entries) {
    // Skip user/system entries
    if (isUserEntry(entry) || isErrorEntry(entry) || isSystemEntry(entry)) {
      continue;
    }

    // Look for activateSkill function calls
    if (entry.type !== 'function_call') {
      continue;
    }
    if (entry.name !== 'activateSkill') {
      continue;
    }
    if (entry.status !== 'completed') {
      continue;
    }

    // Parse the arguments to get skill name
    try {
      const parsed = JSON.parse(entry.arguments);
      if (isRecord(parsed) && hasStringName(parsed)) {
        activated.add(parsed.name);
      }
    } catch {
      // Invalid JSON, skip
    }
  }

  return activated;
}

//#endregion
