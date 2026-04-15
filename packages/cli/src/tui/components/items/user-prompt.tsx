/**
 * User prompt message - renders user input with ❯ prefix and background.
 * Matches Claude Code's UserPromptMessage style.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme.js';

const POINTER = '\u276F'; // ❯

export interface UserPromptProps {
  /** The user's message text */
  text: string;
  /** Add a blank line above; typically true except for the very first turn. */
  addMargin?: boolean;
}

export function UserPrompt({ text, addMargin = false }: UserPromptProps): ReactNode {
  const theme = useTheme();

  if (!text) {
    return null;
  }

  return (
    <Box
      flexDirection="row"
      backgroundColor={theme.userMessageBg}
      paddingRight={1}
      marginTop={addMargin ? 1 : 0}
    >
      <Text color={theme.muted}>{POINTER} </Text>
      <Text color={theme.foreground} wrap="wrap">
        {text}
      </Text>
    </Box>
  );
}
