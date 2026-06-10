import type { StreamEvent } from '@noetic-tools/core';
import type { LocalBashResult } from '../bash-command.js';
import { formatLocalStdoutBlock, LOCAL_COMMAND_CAVEAT } from '../bash-command.js';
import type { ConversationEntry, ErrorEntry, UserEntry } from '../item-utils.js';
import { isUserEntry } from '../item-utils.js';
import type { ViewMode } from './commands.js';

export function buildErrorEntry(error: unknown): ErrorEntry {
  return {
    role: 'system',
    type: 'error',
    content: `Error: ${error instanceof Error ? error.message : String(error)}`,
  };
}

export function isFrameworkEvent(event: StreamEvent): event is Extract<
  StreamEvent,
  {
    source: 'framework';
  }
> {
  return event.source === 'framework';
}

export function extractEventSuffix(type: string): string {
  const idx = type.indexOf(':');
  if (idx < 0) {
    return type;
  }
  return type.slice(idx + 1);
}

export function normalizeEntriesForResume(
  raw: ReadonlyArray<ConversationEntry>,
): ConversationEntry[] {
  const out: ConversationEntry[] = [];
  for (const entry of raw) {
    if (isUserEntry(entry) && entry.deliveryStatus === 'queued') {
      const next: UserEntry = {
        ...entry,
        deliveryStatus: 'sent',
      };
      out.push(next);
      continue;
    }
    out.push(entry);
  }
  return out;
}

export function deriveFirstPrompt(entries: ReadonlyArray<ConversationEntry>): string {
  for (const entry of entries) {
    if (isUserEntry(entry)) {
      return entry.content.length > 200 ? `${entry.content.slice(0, 200)}…` : entry.content;
    }
  }
  return '';
}

export function countUserMessages(entries: ReadonlyArray<ConversationEntry>): number {
  let n = 0;
  for (const entry of entries) {
    if (isUserEntry(entry)) {
      n += 1;
    }
  }
  return n;
}

export function markUserEntrySent(entries: ConversationEntry[], id: string): ConversationEntry[] {
  const idx = entries.findIndex((e) => isUserEntry(e) && e.id === id);
  if (idx < 0) {
    return entries;
  }
  const entry = entries[idx];
  if (!entry || !isUserEntry(entry)) {
    return entries;
  }
  const updated: UserEntry = {
    ...entry,
    deliveryStatus: 'sent',
  };
  const next = [
    ...entries,
  ];
  next[idx] = updated;
  return next;
}

export interface OpenChatTransitionInput {
  /** View mode at the moment the chat-target resolution settled. */
  current: ViewMode;
  taskId: string;
  /** True when the user was shown a spawning view (harness creation and/or
   *  planner spawn + socket poll) before resolution settled. */
  waited: boolean;
  found: {
    socketPath: string;
    roleLabel: string;
  } | null;
}

/**
 * Decide the final view after an "open task chat" resolution settles.
 *
 * Invariant: after ANY wait, only replace OUR OWN spawning view. If the user
 * navigated elsewhere mid-wait (Esc back to chat, a different task's
 * spawning view, ...), the late resolution must never yank them out of the
 * view they chose. The no-wait fast path transitions unconditionally — the
 * user just asked for the chat and nothing happened in between.
 */
export function resolveOpenChatTransition(input: OpenChatTransitionInput): ViewMode {
  const inOwnSpawningView =
    input.current.kind === 'taskChatSpawning' && input.current.taskId === input.taskId;
  if (input.waited && !inOwnSpawningView) {
    return input.current;
  }
  if (input.found === null) {
    return {
      kind: 'taskBoard',
    };
  }
  return {
    kind: 'taskChat',
    socketPath: input.found.socketPath,
    taskId: input.taskId,
    roleLabel: input.found.roleLabel,
  };
}

export function augmentTextWithPendingBash(
  text: string,
  pending: ReadonlyArray<LocalBashResult>,
): string {
  if (pending.length === 0) {
    return text;
  }
  const blocks = pending.map(formatLocalStdoutBlock).join('\n');
  return `${LOCAL_COMMAND_CAVEAT}\n${blocks}\n\n${text}`;
}
