/**
 * Shared utilities for processing StreamableOutputItem from @openrouter/agent.
 *
 * The persisted entry types/schemas/guards live in `sessions/types.ts`; this
 * module re-exports them so existing importers keep working, and adds UI-only
 * helpers (item-id stability, text extraction, dedup, skill activation).
 */

import type { AssistantEntry, ConversationEntry } from '../types/session.js';
import { isErrorEntry, isSystemEntry, isUserEntry } from '../types/session.js';

export type {
  AssistantEntry,
  ConversationEntry,
  ErrorEntry,
  SystemEntry,
  UserEntry,
} from '../types/session.js';
export {
  ConversationEntrySchema,
  isErrorEntry,
  isSystemEntry,
  isUserEntry,
} from '../types/session.js';

type MessageContentPart = Extract<
  AssistantEntry,
  {
    type: 'message';
  }
>['content'][number];

//#region Item ID

let anonCounter = 0;

export function getItemId(item: AssistantEntry): string {
  if (item.type === 'function_call') {
    return `call-${item.callId}`;
  }
  if (item.type === 'function_call_output') {
    return item.id ?? `call-output-${item.callId}`;
  }
  return 'id' in item && item.id ? item.id : `anon-${++anonCounter}`;
}

//#endregion

//#region Text Extraction

function isTextPart(part: MessageContentPart): part is Extract<
  MessageContentPart,
  {
    type: 'output_text' | 'input_text';
  }
> {
  return part.type === 'output_text' || part.type === 'input_text';
}

export function extractTextContent(item: AssistantEntry): string {
  if (item.type !== 'message') {
    return '';
  }
  if (!Array.isArray(item.content)) {
    return '';
  }
  return item.content
    .filter(isTextPart)
    .map((part) => part.text)
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
    if (isUserEntry(existing) || isErrorEntry(existing) || isSystemEntry(existing)) {
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
