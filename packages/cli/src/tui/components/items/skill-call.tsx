/**
 * Skill call item - renders skill activations with special styling.
 * Matches Claude Code's SkillTool rendering style.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme.js';

const RESPONSE_PREFIX = '\u23BF'; // ⎿ - used for tool outputs

export type SkillCallStatus = 'loading' | 'completed' | 'error';

const STATUS_ICONS: Record<SkillCallStatus, string> = {
  loading: '\u25CF', // ●
  completed: '\u2713', // ✓
  error: '\u2715', // ✕
};

export interface SkillCallProps {
  /** Skill name being activated */
  skillName: string;
  /** Skill loading status */
  status?: SkillCallStatus;
  /** Error message if status is error */
  errorMessage?: string;
}

export function SkillCall({
  skillName,
  status = 'loading',
  errorMessage,
}: SkillCallProps): ReactNode {
  const theme = useTheme();
  const icon = STATUS_ICONS[status];
  const isActive = status === 'loading';

  function getStatusColor(): string {
    switch (status) {
      case 'loading':
        return theme.warning;
      case 'completed':
        return theme.success;
      case 'error':
        return theme.error;
    }
  }

  const stateColor = getStatusColor();

  // Determine the result text
  const resultText =
    status === 'completed'
      ? 'Successfully loaded skill'
      : status === 'error' && errorMessage
        ? errorMessage
        : undefined;

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
            <Text color={theme.accent} bold>
              Skill
            </Text>
            <Text color={theme.muted}>{' ('}</Text>
            <Text color={stateColor} bold={isActive}>
              {skillName}
            </Text>
            <Text color={theme.muted}>{')'}</Text>
            {isActive && <Text dimColor>{'...'}</Text>}
          </Text>
          {resultText && (
            <Text dimColor>
              {'    '}
              {'\u2514\u2500'}
              {resultText}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}
