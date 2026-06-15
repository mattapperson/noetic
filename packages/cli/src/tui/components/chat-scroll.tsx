/**
 * ChatScroll — in-app scrollable viewport for chat entries.
 *
 * Replaces the previous `<Static>` rendering. Alt-screen mode suspends the
 * terminal's native scrollback, so the chat needs its own scroll viewport
 * for users to look back at earlier messages without losing the full-canvas
 * layout.
 *
 * Scroll model
 * ------------
 * State is a single integer `linesFromBottom`, counted in *terminal lines*.
 * `0` means "stuck to bottom" — new content arriving while the view is
 * anchored there keeps the most recent output visible. Any value `> 0`
 * means the view is detached; new content does NOT pull the view down,
 * and an indicator at the bottom announces how many lines are below the
 * fold.
 *
 * Rendering uses a `marginBottom={-linesFromBottom}` translation on the
 * inner content column. With `overflow="hidden"` on the outer viewport and
 * `justifyContent="flex-end"` on the viewport, the negative margin pushes
 * the content stack down so its bottom edge sits `linesFromBottom` rows
 * below the viewport's bottom. Those rows are clipped; earlier rows slide
 * into view at the top. No entry is dropped wholesale — long messages
 * walk by one row at a time instead of disappearing.
 *
 * Per-entry height estimation
 * ---------------------------
 * The caller supplies `heightFor(entry, index, cols)` so we can compute
 * the total content height (= sum of heights) and clamp the offset. The
 * `cols` argument lets the estimator account for wrap (a long no-newline
 * response wraps to dozens of lines at 80 columns — without that input
 * the estimate severely undercounts, the offset clamps to 0, and the
 * scroll keys silently no-op).
 *
 * Keybindings (active only when `isActive` is true)
 * -------------------------------------------------
 *   PgUp / PgDn        — scroll one viewport at a time (~ rows/2 lines)
 *   Shift+Up / Shift+Down — scroll a single line
 *   Home               — jump to the top (oldest)
 *   End / Esc          — jump to the bottom (latest, re-stick)
 *
 * Mouse-wheel scrolling is wired in via `useMouseScroll` (three lines per
 * notch). The arrow keys without Shift are deliberately not bound here;
 * the prompt uses them for cursor movement and history navigation.
 */

import { Box, Text, useInput, useStdout } from 'ink';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ScrollAction } from './chat-scroll-state.js';
import { applyScrollAction, maxOffset, pageSizeFor } from './chat-scroll-state.js';
import { useMouseScroll } from './use-mouse-scroll.js';

//#region Types

export interface ChatScrollProps<TEntry> {
  /** All entries to display, oldest first. */
  entries: ReadonlyArray<TEntry>;
  /** Renders a single entry. The wrapper Box (with key) is provided by ChatScroll. */
  renderEntry: (entry: TEntry, index: number) => ReactNode;
  /** Stable key per entry — used for React reconciliation. */
  keyFor: (entry: TEntry, index: number) => string;
  /**
   * Estimated rendered height of an entry, in terminal lines. Default 1
   * (works but defeats Home / End because the cumulative estimate is too
   * small). Real chat surfaces should compute this from rendered text +
   * wrap at `cols` columns.
   */
  heightFor?: (entry: TEntry, index: number, cols: number) => number;
  /**
   * Optional element appended after the entry stream (e.g. a streaming
   * spinner). Always rendered with the latest content; counted into total
   * height via `trailingHeight`.
   */
  trailing?: ReactNode;
  /** Height of `trailing`, used to keep the total-line estimate accurate. */
  trailingHeight?: number;
  /**
   * When false, scroll keys (and mouse wheel) are not consumed (e.g. when
   * an overlay or modal is open). The viewport still renders.
   */
  isActive?: boolean;
}

//#endregion

//#region Hooks

interface ViewportSize {
  rows: number;
  cols: number;
}

function useViewportSize(): ViewportSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<ViewportSize>({
    rows: stdout?.rows ?? 24,
    cols: stdout?.columns ?? 80,
  });
  useEffect(() => {
    if (!stdout) {
      return;
    }
    const handler = (): void => {
      setSize({
        rows: stdout.rows,
        cols: stdout.columns,
      });
    };
    stdout.on('resize', handler);
    return (): void => {
      stdout.off('resize', handler);
    };
  }, [
    stdout,
  ]);
  return size;
}

//#endregion

//#region Component

const DEFAULT_HEIGHT_FOR = (): number => 1;

export function ChatScroll<TEntry>(props: ChatScrollProps<TEntry>): ReactNode {
  const {
    entries,
    renderEntry,
    keyFor,
    heightFor = DEFAULT_HEIGHT_FOR,
    trailing,
    trailingHeight = 0,
    isActive = true,
  } = props;
  const { rows, cols } = useViewportSize();
  // `linesFromBottom` counts terminal lines hidden below the visible
  // window. 0 = stuck to bottom (latest content visible).
  const [linesFromBottom, setLinesFromBottom] = useState(0);

  // Sum of per-entry heights + trailing height. Width-aware so a long
  // assistant reply with no `\n`s doesn't report as 1 line and clamp the
  // scroll offset back to 0 on every keystroke.
  const totalLines = useMemo(() => {
    let sum = trailingHeight;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e !== undefined) {
        sum += heightFor(e, i, cols);
      }
    }
    return sum;
  }, [
    entries,
    heightFor,
    trailingHeight,
    cols,
  ]);

  const viewportLines = rows;
  const pageSize = pageSizeFor(rows);
  const detachedMax = maxOffset(totalLines, viewportLines);

  // Re-clamp the current offset when the transcript or viewport changes
  // (resize, new content arriving while detached, etc.) so a detached view
  // never sits past the new ceiling or below zero.
  useEffect(() => {
    setLinesFromBottom((prev) =>
      applyScrollAction(
        prev,
        {
          kind: 'clamp',
        },
        {
          totalLines,
          viewportLines,
          pageSize,
        },
      ),
    );
  }, [
    totalLines,
    viewportLines,
    pageSize,
  ]);

  const dispatch = useCallback(
    (action: ScrollAction) => {
      setLinesFromBottom((prev) =>
        applyScrollAction(prev, action, {
          totalLines,
          viewportLines,
          pageSize,
        }),
      );
    },
    [
      totalLines,
      viewportLines,
      pageSize,
    ],
  );

  useInput(
    (_input, key) => {
      if (!isActive) {
        return;
      }
      if (key.pageUp) {
        dispatch({
          kind: 'page-up',
        });
        return;
      }
      if (key.pageDown) {
        dispatch({
          kind: 'page-down',
        });
        return;
      }
      if (key.shift && key.upArrow) {
        dispatch({
          kind: 'line-up',
        });
        return;
      }
      if (key.shift && key.downArrow) {
        dispatch({
          kind: 'line-down',
        });
        return;
      }
      if (key.escape || key.end) {
        dispatch({
          kind: 'end',
        });
        return;
      }
      if (key.home) {
        dispatch({
          kind: 'home',
        });
        return;
      }
    },
    {
      isActive,
    },
  );

  // Mouse-wheel scrolling. Three lines per wheel notch is the conventional
  // "feels right" multiplier — single-line is too sticky on a real mouse
  // wheel and a full page overshoots. Trackpad users get one event per
  // inertial click which matches.
  const handleWheelUp = useCallback(() => {
    if (!isActive) {
      return;
    }
    for (let i = 0; i < 3; i++) {
      dispatch({
        kind: 'line-up',
      });
    }
  }, [
    isActive,
    dispatch,
  ]);
  const handleWheelDown = useCallback(() => {
    if (!isActive) {
      return;
    }
    for (let i = 0; i < 3; i++) {
      dispatch({
        kind: 'line-down',
      });
    }
  }, [
    isActive,
    dispatch,
  ]);
  useMouseScroll({
    onScrollUp: handleWheelUp,
    onScrollDown: handleWheelDown,
    isActive,
  });

  const detached = linesFromBottom > 0;
  const canScrollUp = linesFromBottom < detachedMax;

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden" justifyContent="flex-end">
      <Box flexDirection="column" flexShrink={0} marginBottom={-linesFromBottom}>
        {entries.map((entry, i) => (
          <Box key={keyFor(entry, i)} flexShrink={0}>
            {renderEntry(entry, i)}
          </Box>
        ))}
        {trailing ? <Box flexShrink={0}>{trailing}</Box> : null}
      </Box>
      {detached ? (
        <Box flexShrink={0}>
          <Text dimColor>
            ↓ {linesFromBottom} {linesFromBottom === 1 ? 'line' : 'lines'} below
            {canScrollUp ? '' : ' (top)'} — End / Esc to jump to latest
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

//#endregion
