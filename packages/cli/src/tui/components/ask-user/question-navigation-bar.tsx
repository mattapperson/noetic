/**
 * "Question X of Y" header with a tab chip per question, displaying each
 * question's `header` label and its completion state.
 *
 * Ported from ~/Desktop/claude-code-main/src/components/permissions/AskUserQuestionPermissionRequest/QuestionNavigationBar.tsx.
 */

import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';

//#region Props

export interface QuestionTab {
  readonly header: string;
  readonly answered: boolean;
}

export interface QuestionNavigationBarProps {
  readonly tabs: ReadonlyArray<QuestionTab>;
  readonly currentIndex: number;
}

//#endregion

//#region Component

export function QuestionNavigationBar({ tabs, currentIndex }: QuestionNavigationBarProps) {
  const theme = useTheme();
  const total = tabs.length;
  const current = Math.min(currentIndex + 1, total);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.muted}>
          Question {current} of {total}
        </Text>
      </Box>
      <Box>
        {tabs.map((tab, index) => {
          const isActive = index === currentIndex;
          const color = isActive ? theme.primary : tab.answered ? theme.success : theme.muted;
          const prefix = isActive ? '▸' : tab.answered ? '✓' : '·';
          const separator = index > 0 ? '  ' : '';
          return (
            <Text key={`tab-${tab.header}`} color={color}>
              {separator}
              {prefix} {tab.header}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}

//#endregion
