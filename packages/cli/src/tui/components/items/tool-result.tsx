/**
 * Tool result - renders a tool's output as a sub-response under its tool call.
 *
 * Wraps the result preview in MessageResponse (⎿ prefix), mirroring Claude Code.
 */

import { Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme.js';
import { MessageResponse } from './message-response.js';

const MAX_RESULT_PREVIEW_CHARS = 200;

export interface ToolResultProps {
  /** Raw tool output; will be coerced to a displayable string. */
  output: unknown;
  /** Whether the parent call errored. */
  isError?: boolean;
}

function toPreview(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function ToolResult({ output, isError = false }: ToolResultProps): ReactNode {
  const theme = useTheme();
  const preview = toPreview(output).trim();

  if (preview.length === 0) {
    return null;
  }

  const truncated =
    preview.length > MAX_RESULT_PREVIEW_CHARS
      ? `${preview.slice(0, MAX_RESULT_PREVIEW_CHARS)}…`
      : preview;

  return (
    <MessageResponse>
      <Text color={isError ? theme.error : undefined} dimColor={!isError} wrap="wrap">
        {truncated}
      </Text>
    </MessageResponse>
  );
}
