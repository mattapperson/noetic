/**
 * Assistant text message - renders model output with ⏺ prefix.
 * Matches Claude Code's AssistantTextMessage style.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

// Claude Code uses ⏺ on macOS, ● on other platforms for assistant text
const BLACK_CIRCLE = process.platform === 'darwin' ? '\u23FA' : '\u25CF'; // ⏺ or ●

export interface AssistantTextProps {
  /** The assistant's response text */
  text: string;
  /** Whether this message is currently streaming */
  isStreaming?: boolean;
  /** Streaming cursor character */
  streamingCursor?: string;
}

export function AssistantText({
  text,
  isStreaming = false,
  streamingCursor = '\u258E',
}: AssistantTextProps): ReactNode {
  if (!text) {
    return null;
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text dimColor>{BLACK_CIRCLE} </Text>
        <Box flexShrink={1} flexGrow={1}>
          <Text wrap="wrap">
            {text}
            {isStreaming && <Text dimColor>{streamingCursor}</Text>}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
