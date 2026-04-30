/**
 * Types for collapsed tool-call groups. A group replaces one or more
 * consecutive Read/Ls/Find/Grep function_call + function_call_output pairs
 * in the display stream with a single summary entry.
 */

import type { ConversationEntry } from '../item-utils.js';
import { getItemId, isErrorEntry, isSystemEntry, isUserEntry } from '../item-utils.js';

//#region Types

export const CollapsibleToolName = {
  Read: 'Read',
  Ls: 'Ls',
  Find: 'Find',
  Grep: 'Grep',
} as const;

export type CollapsibleToolName = (typeof CollapsibleToolName)[keyof typeof CollapsibleToolName];

export interface CollapsedReadGroup {
  kind: 'collapsed-read-group';
  /** Stable id derived from the first member's call id — used as the key for
   *  `<Static>` caching so the group doesn't re-render when later entries
   *  arrive. */
  id: string;
  /** Distinct file paths read. */
  readPaths: ReadonlyArray<string>;
  /** Distinct directory paths listed. */
  listPaths: ReadonlyArray<string>;
  /** Distinct Find/Grep patterns searched. */
  searchPatterns: ReadonlyArray<string>;
  /** Most-recent path/pattern for the optional hint row. */
  latestHint: string;
}

export type DisplayEntry = ConversationEntry | CollapsedReadGroup;

//#endregion

//#region Type Guards

export function isCollapsedReadGroup(entry: DisplayEntry): entry is CollapsedReadGroup {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'kind' in entry &&
    entry.kind === 'collapsed-read-group'
  );
}

export function totalOpCount(group: CollapsedReadGroup): number {
  return group.readPaths.length + group.listPaths.length + group.searchPatterns.length;
}

//#endregion

//#region Static keys

export interface StaticEntryItem {
  readonly key: string;
  readonly entry: DisplayEntry;
  readonly index: number;
}

export function staticKeyFor(entry: DisplayEntry, index: number): string {
  if (isCollapsedReadGroup(entry)) {
    return entry.id;
  }
  if (isUserEntry(entry)) {
    return `user-${index}`;
  }
  if (isErrorEntry(entry)) {
    return `error-${index}`;
  }
  if (isSystemEntry(entry)) {
    return `system-${index}`;
  }
  return getItemId(entry);
}

export function toStaticEntryItems(entries: ReadonlyArray<DisplayEntry>): StaticEntryItem[] {
  return entries.map((entry, index) => ({
    key: staticKeyFor(entry, index),
    entry,
    index,
  }));
}

//#endregion
