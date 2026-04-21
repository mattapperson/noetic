/**
 * System message - renders info/error messages.
 *
 * Default: top-level standalone line (no ⎿). When `asResponse` is set, wraps
 * in MessageResponse so the message sits under its parent turn (used for API
 * errors that follow an assistant message).
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme.js';
import { MessageResponse } from './message-response.js';

export type SystemMessageType = 'info' | 'error';

export interface SystemMessageProps {
  text: string;
  type?: SystemMessageType;
  /** When true, wrap in MessageResponse (⎿ prefix) as a sub-response. */
  asResponse?: boolean;
  /** Add a blank line above when this is the first item in a new turn. */
  addMargin?: boolean;
}

export function SystemMessage({
  text,
  type = 'info',
  asResponse = false,
  addMargin = false,
}: SystemMessageProps): ReactNode {
  const theme = useTheme();

  if (!text) {
    return null;
  }

  const color = type === 'error' ? theme.error : undefined;
  const content = (
    <Text color={color} dimColor={type === 'info'} wrap="wrap">
      {text}
    </Text>
  );

  if (asResponse) {
    return <MessageResponse>{content}</MessageResponse>;
  }

  return <Box marginTop={addMargin ? 1 : 0}>{content}</Box>;
}
