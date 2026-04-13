/**
 * Reasoning item - renders thinking/reasoning blocks.
 * Matches Claude Code's AssistantThinkingMessage style.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme.js';

const RESPONSE_PREFIX = '\u23BF'; // ⎿
const THINKING_ICON = '\u2728'; // ✨

export interface ReasoningProps {
  /** Reasoning text content */
  text?: string;
  /** Whether reasoning is collapsed */
  collapsed?: boolean;
  /** Duration label */
  duration?: string;
}

export function Reasoning({ text, collapsed = true, duration }: ReasoningProps): ReactNode {
  const theme = useTheme();
  const isOpen = !collapsed;

  const headerText = duration ? `Thinking... (${duration})` : 'Thinking...';

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text dimColor>
          {'  '}
          {RESPONSE_PREFIX}{' '}
        </Text>
        <Box flexDirection="column" flexGrow={1}>
          <Text color={theme.muted} dimColor>
            {THINKING_ICON} {headerText}
          </Text>
          {isOpen && text && (
            <Box paddingLeft={2}>
              <Text dimColor wrap="wrap">
                {text}
              </Text>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}
