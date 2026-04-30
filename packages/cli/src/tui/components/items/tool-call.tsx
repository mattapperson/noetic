/**
 * Tool call header - renders `● name(args?)` at top level.
 *
 * Only the dot recolors on status change so the name doesn't flash.
 * The tool *result* is rendered separately via <ToolResult>.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { BLACK_CIRCLE } from '../../glyphs.js';
import type { Theme } from '../theme.js';
import { useTheme } from '../theme.js';

export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'error';

export interface ToolCallProps {
  name: string;
  status?: ToolCallStatus;
  /** Serialized arguments to show in parens, e.g. "path/to/file". */
  args?: string;
  /** Add a blank line above when this is the first item in a new turn. */
  addMargin?: boolean;
}

function dotColorFor(status: ToolCallStatus, theme: Theme): string | undefined {
  if (status === 'completed') {
    return theme.success;
  }
  if (status === 'error') {
    return theme.error;
  }
  return undefined;
}

export function ToolCall({
  name,
  status = 'pending',
  args,
  addMargin = false,
}: ToolCallProps): ReactNode {
  const theme = useTheme();
  const isDim = status === 'pending';
  const hasArgs = args !== undefined && args.length > 0;

  return (
    <Box flexDirection="row" flexWrap="nowrap" marginTop={addMargin ? 1 : 0}>
      <Box minWidth={2}>
        <Text color={dotColorFor(status, theme)} dimColor={isDim}>
          {BLACK_CIRCLE}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text bold wrap="truncate-end">
          {name}
        </Text>
      </Box>
      {hasArgs && (
        <Box flexWrap="nowrap">
          <Text dimColor wrap="truncate-end">
            ({args})
          </Text>
        </Box>
      )}
    </Box>
  );
}
