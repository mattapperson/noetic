/**
 * MessageResponse - wraps content that is a sub-response of a parent message,
 * prefixing it with the ⎿ continuation marker.
 *
 * Mirrors Claude Code's MessageResponse wrapper — used for tool results and for
 * error lines that follow an assistant turn.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { CORNER } from '../../glyphs.js';

export interface MessageResponseProps {
  children: ReactNode;
}

export function MessageResponse({ children }: MessageResponseProps): ReactNode {
  return (
    <Box flexDirection="row">
      <Text dimColor>
        {'  '}
        {CORNER}
        {'  '}
      </Text>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}
