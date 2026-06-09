/**
 * Assistant text message - renders model output with ⏺ prefix.
 * Matches Claude Code's AssistantTextMessage style.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { BLACK_CIRCLE } from '../../glyphs.js';
import { Ansi } from '../ansi.js';

// Glyph (1 col) + trailing space; must match what the dot Box reserves.
const DOT_COLUMN_WIDTH = 2;

export interface AssistantTextProps {
  /** The assistant's response text */
  text: string;
  /** Whether this message is currently streaming */
  isStreaming?: boolean;
  /** Streaming cursor character */
  streamingCursor?: string;
  /** Add a blank line above when this is the first item in a new turn. */
  addMargin?: boolean;
}

export function AssistantText({
  text,
  isStreaming = false,
  streamingCursor = '▎',
  addMargin = false,
}: AssistantTextProps): ReactNode {
  if (!text) {
    return null;
  }

  // `minWidth={DOT_COLUMN_WIDTH}` pins the dot column so ⏺'s ambiguous
  // East-Asian width can't shift the content box; `<Ansi>` handles the wrap.
  return (
    <Box flexDirection="row" alignItems="flex-start" width="100%" marginTop={addMargin ? 1 : 0}>
      <Box minWidth={DOT_COLUMN_WIDTH}>
        <Text dimColor>{BLACK_CIRCLE}</Text>
      </Box>
      <Box flexDirection="column" flexShrink={1} flexGrow={1}>
        <Ansi
          columnOffset={DOT_COLUMN_WIDTH}
          trailing={isStreaming ? <Text dimColor>{streamingCursor}</Text> : undefined}
        >
          {text}
        </Ansi>
      </Box>
    </Box>
  );
}
