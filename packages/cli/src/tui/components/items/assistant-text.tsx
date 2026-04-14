/**
 * Assistant text message - renders model output with ⏺ prefix.
 * Matches Claude Code's AssistantTextMessage style.
 *
 * AssistantText renders a complete message (single unit). For streaming,
 * prefer AssistantTextLine which renders one line at a time so completed
 * lines can be committed to <Static> and only the trailing partial line
 * stays in the live region.
 *
 * Layout is a two-column row: a fixed 2-column gutter for the ⏺/indent
 * prefix and a width-constrained content column that owns the wrap.
 * Explicit widths on both columns (not flexGrow) are required because
 * items rendered through <Static> have no parent layout to flex within
 * — when the content column isn't sized, Text "wrap" falls through and
 * the terminal hard-wraps mid-word.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

const BLACK_CIRCLE = process.platform === 'darwin' ? '\u23FA' : '\u25CF'; // ⏺ or ●
const STREAM_CURSOR = '\u258E';
const GUTTER = 2;

function contentWidth(width: number | undefined): number | undefined {
  if (width === undefined) {
    return undefined;
  }
  return Math.max(1, width - GUTTER);
}

export interface AssistantTextProps {
  text: string;
  isStreaming?: boolean;
  streamingCursor?: string;
  /** Available terminal columns; enables proper word-wrap in Static. */
  width?: number;
}

export function AssistantText({
  text,
  isStreaming = false,
  streamingCursor = STREAM_CURSOR,
  width,
}: AssistantTextProps): ReactNode {
  if (!text) {
    return null;
  }
  return (
    <Box flexDirection="row" width={width}>
      <Box width={GUTTER}>
        <Text dimColor>{BLACK_CIRCLE} </Text>
      </Box>
      <Box width={contentWidth(width)}>
        <Text wrap="wrap">
          {text}
          {isStreaming && <Text dimColor>{streamingCursor}</Text>}
        </Text>
      </Box>
    </Box>
  );
}

export interface AssistantTextLineProps {
  text: string;
  /** First line of a message gets the ⏺ prefix; others get a 2-space indent. */
  isFirst: boolean;
  isStreaming?: boolean;
  streamingCursor?: string;
  /** Available terminal columns. */
  width?: number;
}

export function AssistantTextLine({
  text,
  isFirst,
  isStreaming = false,
  streamingCursor = STREAM_CURSOR,
  width,
}: AssistantTextLineProps): ReactNode {
  return (
    <Box flexDirection="row" width={width}>
      <Box width={GUTTER}>
        <Text dimColor>{isFirst ? `${BLACK_CIRCLE} ` : '  '}</Text>
      </Box>
      <Box width={contentWidth(width)}>
        <Text wrap="wrap">
          {text}
          {isStreaming && <Text dimColor>{streamingCursor}</Text>}
        </Text>
      </Box>
    </Box>
  );
}
