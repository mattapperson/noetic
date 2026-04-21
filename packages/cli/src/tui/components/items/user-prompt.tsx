/**
 * User prompt message - renders user input with ❯ prefix and background.
 * Matches Claude Code's UserPromptMessage style.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme.js';

const POINTER = '❯'; // ❯

export interface UserPromptProps {
  /** The user's message text */
  text: string;
  /** Add a blank line above; typically true except for the very first turn. */
  addMargin?: boolean;
  /** `queued` when the message is enqueued during generation and not yet delivered. */
  deliveryStatus?: 'queued' | 'sent';
}

export function UserPrompt({
  text,
  addMargin = false,
  deliveryStatus,
}: UserPromptProps): ReactNode {
  const theme = useTheme();

  if (!text) {
    return null;
  }

  const isQueued = deliveryStatus === 'queued';
  const pointer = isQueued ? '⋯' : POINTER; // ⋯ for queued, ❯ for sent

  return (
    <Box
      flexDirection="row"
      backgroundColor={isQueued ? undefined : theme.userMessageBg}
      paddingRight={1}
      marginTop={addMargin ? 1 : 0}
    >
      <Text color={theme.muted}>{pointer} </Text>
      <Text color={isQueued ? theme.muted : theme.foreground} wrap="wrap">
        {text}
      </Text>
      {isQueued ? <Text color={theme.muted}> (queued)</Text> : null}
    </Box>
  );
}
