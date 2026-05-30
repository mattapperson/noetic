/**
 * Full-screen overlay used by both ctrl+o (transcript) and ctrl+r (request items).
 *
 * Replaces the main chat tree with every tool result expanded:
 *   - Edit diffs: no 10-line cap
 *   - Bash output: no cap
 *   - Read/Ls/Find/Grep: raw output text (no grouping, no one-liner)
 *
 * The overlay is purely presentational — the parent owns open/close state
 * and key handling.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { staticKeyFor } from '../grouping/types.js';
import type { ConversationEntry } from '../item-utils.js';
import type { CallInfo } from './items/render-entry.js';
import { renderExpandedEntry } from './items/render-entry.js';
import { useTheme } from './theme.js';

//#region Types

export type { CallInfo };

export interface TranscriptViewProps {
  entries: ReadonlyArray<ConversationEntry>;
  callInfoByCallId: ReadonlyMap<string, CallInfo>;
  /** Header title. Defaults to "Transcript". */
  title?: string;
  /** Subtitle hint after the title. Defaults to the ctrl+o close hint. */
  closeHint?: string;
  /** When true, every entry row renders on a green background. */
  highlightItems?: boolean;
}

interface TranscriptItem {
  readonly key: string;
  readonly entry: ConversationEntry;
  readonly index: number;
}

//#endregion

//#region Component

export function TranscriptView({
  entries,
  callInfoByCallId,
  title = 'Transcript',
  closeHint = ' — press ctrl+o or Esc to close',
  highlightItems = false,
}: TranscriptViewProps): ReactNode {
  const theme = useTheme();
  const items = useMemo<TranscriptItem[]>(
    () =>
      entries.map((entry, index) => ({
        key: staticKeyFor(entry, index),
        entry,
        index,
      })),
    [
      entries,
    ],
  );
  const rowBackground = highlightItems ? 'green' : undefined;
  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="row" marginBottom={1}>
        <Text color={theme.accent} bold>
          {title}
        </Text>
        <Text dimColor>{closeHint}</Text>
      </Box>
      {items.map((item) => (
        <Box key={item.key} flexDirection="column" backgroundColor={rowBackground}>
          {renderExpandedEntry(item.entry, item.index, {
            callInfoByCallId,
          })}
        </Box>
      ))}
    </Box>
  );
}

//#endregion
