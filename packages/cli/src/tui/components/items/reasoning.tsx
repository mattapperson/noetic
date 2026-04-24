/**
 * Reasoning - top-level thinking/reasoning block.
 *
 * Mirrors Claude Code's AssistantThinkingMessage: a dim+italic `∴ Thinking`
 * header when collapsed (no ellipsis), `∴ Thinking…` expanded with the body
 * indented two spaces underneath. No ⎿ prefix — reasoning is its own
 * top-level entry, not a sub-response.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

const THINKING_MARKER = '\u2234'; // ∴

export interface ReasoningProps {
  text?: string;
  /** When true, render only the collapsed header. */
  collapsed?: boolean;
  /** Add a blank line above when this is the first item in a new turn. */
  addMargin?: boolean;
}

export function Reasoning({
  text,
  collapsed = true,
  addMargin = false,
}: ReasoningProps): ReactNode {
  if (collapsed || !text) {
    return (
      <Box marginTop={addMargin ? 1 : 0}>
        <Text dimColor italic>
          {THINKING_MARKER} Thinking
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1} marginTop={addMargin ? 1 : 0} width="100%">
      <Text dimColor italic>
        {THINKING_MARKER} Thinking…
      </Text>
      <Box paddingLeft={2}>
        <Text dimColor wrap="wrap">
          {text}
        </Text>
      </Box>
    </Box>
  );
}
