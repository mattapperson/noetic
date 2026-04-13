/**
 * System message item - renders system/info messages.
 * Matches Claude Code's SystemTextMessage style.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme.js';

const RESPONSE_PREFIX = '\u23BF'; // ⎿

export type SystemMessageType = 'info' | 'error';

export interface SystemMessageProps {
  /** Message content */
  text: string;
  /** Message type */
  type?: SystemMessageType;
}

export function SystemMessage({ text, type = 'info' }: SystemMessageProps): ReactNode {
  const theme = useTheme();

  if (!text) {
    return null;
  }

  const color = type === 'error' ? theme.error : theme.muted;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text dimColor>
          {'  '}
          {RESPONSE_PREFIX}{' '}
        </Text>
        <Text color={color} dimColor={type === 'info'} wrap="wrap">
          {text}
        </Text>
      </Box>
    </Box>
  );
}
