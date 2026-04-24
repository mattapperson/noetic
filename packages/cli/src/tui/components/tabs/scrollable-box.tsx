/**
 * ScrollableBox — fixed-height viewport over a list of rendered rows.
 *
 * Ink can't clip arbitrary children, so we work at the row level:
 * callers pre-render each row as a ReactNode and we slice the list to the
 * visible window. When focused, Up/Down/PageUp/PageDown/Home/End scroll.
 */

import { Box, Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useState } from 'react';

//#region Types

export interface ScrollableRow {
  key: string;
  node: ReactNode;
}

export interface ScrollableBoxProps {
  rows: ReadonlyArray<ScrollableRow>;
  height: number;
  isFocused: boolean;
  /** Optional label shown above the content while it overflows. */
  overflowHint?: string;
}

//#endregion

//#region Helpers

export function computeMaxScroll(rowCount: number, height: number): number {
  return Math.max(0, rowCount - height);
}

export function clampScrollTop(scrollTop: number, maxScroll: number): number {
  return Math.min(Math.max(0, scrollTop), maxScroll);
}

//#endregion

//#region Component

export function ScrollableBox({
  rows,
  height,
  isFocused,
  overflowHint,
}: ScrollableBoxProps): ReactNode {
  const [scrollTop, setScrollTop] = useState(0);
  const maxScroll = computeMaxScroll(rows.length, height);
  const clampedTop = clampScrollTop(scrollTop, maxScroll);

  useInput(
    (input, key) => {
      if (key.upArrow) {
        setScrollTop((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setScrollTop((s) => Math.min(maxScroll, s + 1));
        return;
      }
      if (key.pageUp) {
        setScrollTop((s) => Math.max(0, s - height));
        return;
      }
      if (key.pageDown) {
        setScrollTop((s) => Math.min(maxScroll, s + height));
        return;
      }
      if (input === 'g') {
        setScrollTop(0);
        return;
      }
      if (input === 'G') {
        setScrollTop(maxScroll);
      }
    },
    {
      isActive: isFocused && maxScroll > 0,
    },
  );

  const visibleRows = rows.slice(clampedTop, clampedTop + height);
  const hasOverflow = maxScroll > 0;
  const showHint = hasOverflow && overflowHint !== undefined;

  return (
    <Box flexDirection="column" height={height}>
      {showHint && (
        <Box>
          <Text dimColor>{overflowHint}</Text>
        </Box>
      )}
      {visibleRows.map((row) => (
        <Box key={row.key}>{row.node}</Box>
      ))}
      {hasOverflow && (
        <Box>
          <Text dimColor>
            {clampedTop + height >= rows.length
              ? '── end ──'
              : `↓ ${rows.length - clampedTop - height} more`}
          </Text>
        </Box>
      )}
    </Box>
  );
}

//#endregion
