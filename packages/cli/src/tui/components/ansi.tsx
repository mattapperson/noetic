/**
 * Ink's built-in `wrap-ansi` runs with `{ trim: false }`, which preserves the
 * space at a wrap boundary and stacks it onto any fixed prefix column — a
 * "staircase" indent. This component pre-wraps with `trim: true` and renders
 * one `<Text>` per line so Ink's own wrap never re-runs.
 *
 * Ported from Claude Code: https://github.com/anthropics/claude-code/blob/main/src/ink/Ansi.tsx
 * Must be rendered inside a parent with `flexDirection="column"`.
 */

import { Box, Text, useStdout } from 'ink';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import wrapAnsi from 'wrap-ansi';

export interface AnsiProps {
  /** Pre-formatted text (may contain ANSI escape codes). */
  children: string;
  /** Dim every rendered line. */
  dimColor?: boolean;
  /** Columns occupied by a sibling prefix to subtract from the wrap width. */
  columnOffset?: number;
  /** Inline node appended to the last line (e.g. a streaming cursor). */
  trailing?: ReactNode;
}

export type WrappedLine = {
  key: string;
  content: string;
};

/**
 * Pre-wrap `text` to `maxWidth` and build stable React keys for each line.
 * Exported so the wrap invariant can be unit-tested without mounting React.
 */
export function buildWrappedLines(text: string, maxWidth: number): WrappedLine[] {
  const rawLines = wrapAnsi(text, maxWidth, {
    trim: true,
    hard: true,
  }).split('\n');
  let offset = 0;
  return rawLines.map((line) => {
    const key = String(offset);
    // +1 accounts for the consumed '\n' so offsets stay strictly increasing.
    offset += line.length + 1;
    // Ink collapses zero-height <Text> nodes; a space preserves blank rows.
    return {
      key,
      content: line.length > 0 ? line : ' ',
    };
  });
}

export function Ansi({
  children,
  dimColor = false,
  columnOffset = 0,
  trailing,
}: AnsiProps): ReactNode {
  const { stdout } = useStdout();
  const maxWidth = Math.max(1, (stdout?.columns ?? 80) - columnOffset);

  const lines = useMemo(
    () => buildWrappedLines(children, maxWidth),
    [
      children,
      maxWidth,
    ],
  );

  const lastIndex = lines.length - 1;
  // `flexDirection="column"` is structural here, not cosmetic: Ink measures
  // the dynamic-region row count from Box children. Using a Fragment emits
  // N sibling rows whose height the parent may miscount, leaving ghost rows
  // behind each interval tick from animated siblings (e.g. the spinner).
  return (
    <Box flexDirection="column">
      {lines.map(({ key, content }, i) => (
        <Text key={key} dimColor={dimColor}>
          {content}
          {i === lastIndex && trailing}
        </Text>
      ))}
    </Box>
  );
}
