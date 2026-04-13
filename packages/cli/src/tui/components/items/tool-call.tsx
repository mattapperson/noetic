/**
 * Tool call item - renders tool invocations with status icons.
 * Matches Claude Code's AssistantToolUseMessage style.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme.js';

const MAX_RESULT_PREVIEW_CHARS = 120;
const RESPONSE_PREFIX = '\u23BF'; // ⎿ - used for tool outputs

export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'error';

const STATUS_ICONS: Record<ToolCallStatus, string> = {
  pending: '\u25CB', // ○
  running: '\u25CF', // ●
  completed: '\u2713', // ✓
  error: '\u2715', // ✕
};

export interface ToolCallProps {
  /** Tool name */
  name: string;
  /** Tool execution status */
  status?: ToolCallStatus;
  /** Tool result (shown when completed) */
  result?: unknown;
}

export function ToolCall({ name, status = 'pending', result }: ToolCallProps): ReactNode {
  const theme = useTheme();
  const icon = STATUS_ICONS[status];
  const isActive = status === 'pending' || status === 'running';

  function getStatusColor(): string {
    switch (status) {
      case 'pending':
        return theme.muted;
      case 'running':
        return theme.warning;
      case 'completed':
        return theme.success;
      case 'error':
        return theme.error;
    }
  }

  const stateColor = getStatusColor();

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text dimColor>
          {'  '}
          {RESPONSE_PREFIX}{' '}
        </Text>
        <Box flexDirection="column" flexGrow={1}>
          <Text>
            <Text color={stateColor}>{icon}</Text>
            <Text> </Text>
            <Text color={stateColor} bold={isActive}>
              {name}
            </Text>
            {isActive && <Text dimColor>{'...'}</Text>}
          </Text>
          {status === 'completed' && result !== undefined && (
            <Text dimColor>
              {'    '}
              {'\u2514\u2500'}
              {String(result).slice(0, MAX_RESULT_PREVIEW_CHARS)}
            </Text>
          )}
          {status === 'error' && result !== undefined && (
            <Text color={theme.error} dimColor>
              {'    '}
              {'\u2514\u2500'}
              {String(result).slice(0, MAX_RESULT_PREVIEW_CHARS)}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}
