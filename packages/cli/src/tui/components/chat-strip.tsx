/**
 * Narrow-mode chat strip.
 *
 * Rendered as the unfocused half of the narrow stacked layout when the user
 * has chosen to focus on the context pane. Replaces the full chat surface
 * with a compact summary so the panel can expand, while preserving the
 * always-visible-chat invariant — the user can still see *something* about
 * the chat side at all times.
 *
 * Two states:
 *   - **Idle** (`status === 'ready'` or no streaming): one-line summary
 *     `chat · N msgs · waiting…`.
 *   - **Streaming**: a peek at the tail of the most-recent assistant
 *     message. Up to `MAX_PREVIEW_LINES` lines from the end of the
 *     latest text content, each truncated to fit `width`.
 *
 * See specs/28-context-split-view.md.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { ChatStatus } from '../chat-status.js';
import type { ConversationEntry } from '../item-utils.js';
import { extractTextContent, isErrorEntry, isSystemEntry, isUserEntry } from '../item-utils.js';

//#region Types

export interface ChatStripProps {
  entries: ReadonlyArray<ConversationEntry>;
  status: ChatStatus;
  /** Available column count for the strip; the preview is truncated to fit. */
  width: number;
}

//#endregion

//#region Helpers

const MAX_PREVIEW_LINES = 3;
const PREFIX = 'chat · ';

function isStreamingStatus(status: ChatStatus): boolean {
  return status === 'streaming' || status === 'submitted';
}

function countUserMessages(entries: ReadonlyArray<ConversationEntry>): number {
  let n = 0;
  for (const entry of entries) {
    if (isUserEntry(entry)) {
      n += 1;
    }
  }
  return n;
}

/**
 * Return the most-recent assistant text content if any. Walks from the end of
 * the array because the streaming entry is always the tail; bails on the first
 * non-empty text we find. Type guards (rather than `'role' in entry`) are used
 * because the assistant `InputMessageItem` *also* has a `role` field, so a
 * structural check would accidentally drop assistant messages.
 */
function findLatestAssistantText(entries: ReadonlyArray<ConversationEntry>): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }
    if (isUserEntry(entry) || isErrorEntry(entry) || isSystemEntry(entry)) {
      continue;
    }
    const text = extractTextContent(entry);
    if (text.length > 0) {
      return text;
    }
  }
  return null;
}

function truncateLine(line: string, width: number): string {
  if (line.length <= width) {
    return line;
  }
  if (width <= 1) {
    return line.slice(0, Math.max(0, width));
  }
  return `${line.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * Take up to `MAX_PREVIEW_LINES` lines from the end of `text`, truncating
 * each to `lineWidth` columns. Each preview line is prefixed inside
 * `ChatStrip` so we return raw line content here.
 */
export function buildPreviewLines(text: string, lineWidth: number): ReadonlyArray<string> {
  const lines = text.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) {
    return [];
  }
  const tail = lines.slice(-MAX_PREVIEW_LINES);
  return tail.map((line) => truncateLine(line, Math.max(0, lineWidth)));
}

//#endregion

//#region Component

export function ChatStrip({ entries, status, width }: ChatStripProps): ReactNode {
  const streaming = isStreamingStatus(status);
  const lineWidth = Math.max(0, width - PREFIX.length);

  if (!streaming) {
    const count = countUserMessages(entries);
    const summary = truncateLine(`${PREFIX}${count} msgs · waiting…`, width);
    return (
      <Box>
        <Text dimColor>{summary}</Text>
      </Box>
    );
  }

  const text = findLatestAssistantText(entries);
  if (!text) {
    // Streaming has started but no assistant text yet (e.g. still in a
    // tool call). Show the idle summary so the strip isn't blank.
    const count = countUserMessages(entries);
    const summary = truncateLine(`${PREFIX}${count} msgs · streaming…`, width);
    return (
      <Box>
        <Text dimColor>{summary}</Text>
      </Box>
    );
  }

  const previewLines = buildPreviewLines(text, lineWidth);
  if (previewLines.length === 0) {
    return null;
  }

  // ink Text accepts embedded newlines; collapsing the lines into a single
  // string avoids React key concerns on the per-line list (which is
  // re-derived on every render from the streaming tail).
  const body = previewLines.map((line) => `${PREFIX}${line}`).join('\n');
  return (
    <Box flexDirection="column">
      <Text dimColor>{body}</Text>
    </Box>
  );
}

//#endregion
