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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { anchoredOffsetAfterDelta, wheelDownClamp, wheelUpClamp } from './chat-scroll-anchor.js';
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
   * Number of rows of fixed chrome rendered BELOW ChatScroll (exit hint,
   * status notice, plugin footer). Subtracted from the viewport-row count
   * so the scroll math matches the area the user actually sees the chat
   * content in. Without this, `maxOffset` would be too small and the
   * indicator would jitter as the user scrolls.
   */
  chromeBelowRows?: number;
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
    chromeBelowRows = 0,
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

  // Effective scroll viewport excludes chrome that lives below ChatScroll
  // (exit hint, status notice, plugin footer). Without this subtraction
  // maxOffset is off by chromeBelowRows and the user sees the indicator
  // jitter / "(top)" tag flip on and off as new lines arrive.
  const viewportLines = Math.max(1, rows - chromeBelowRows);
  const pageSize = pageSizeFor(rows);
  const detachedMax = maxOffset(totalLines, viewportLines);

  // Anchor the viewport to the same content row when content grows while the
  // user is scrolled back. Without this, new entries arriving at the bottom
  // would silently shift the visible rows toward the latest, dragging the
  // user away from what they were reading.
  //
  // Mechanism: `linesFromBottom` is an offset measured from the bottom of
  // content. When content grows by Δ at the bottom, both the bottom edge
  // and the content-row positions slide by Δ — so to keep the same rows
  // visible, the offset must also grow by Δ. (Stuck-to-bottom users keep
  // `linesFromBottom = 0` and continue to tail by design.)
  //
  // Content shrinking (e.g. /clear, history truncation) doesn't fit the
  // anchor model — fall through to the standard clamp so the offset can't
  // sit above the new content top.
  const prevTotalLinesRef = useRef(totalLines);
  useEffect(() => {
    const delta = totalLines - prevTotalLinesRef.current;
    prevTotalLinesRef.current = totalLines;
    setLinesFromBottom((prev) =>
      anchoredOffsetAfterDelta({
        prev,
        delta,
        totalLines,
        viewportLines,
      }),
    );
  }, [
    totalLines,
    viewportLines,
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

  // Map each scroll keystroke to a `ScrollAction` (or `null` if it isn't a
  // scroll key). Kept as a pure helper so the useInput callback collapses
  // to a single dispatch.
  const resolveScrollAction = useCallback(
    (key: {
      pageUp?: boolean;
      pageDown?: boolean;
      shift?: boolean;
      upArrow?: boolean;
      downArrow?: boolean;
      escape?: boolean;
      end?: boolean;
      home?: boolean;
    }): ScrollAction | null => {
      if (key.pageUp) {
        return {
          kind: 'page-up',
        };
      }
      if (key.pageDown) {
        return {
          kind: 'page-down',
        };
      }
      if (key.shift && key.upArrow) {
        return {
          kind: 'line-up',
        };
      }
      if (key.shift && key.downArrow) {
        return {
          kind: 'line-down',
        };
      }
      if (key.escape || key.end) {
        return {
          kind: 'end',
        };
      }
      if (key.home) {
        return {
          kind: 'home',
        };
      }
      return null;
    },
    [],
  );

  useInput(
    (_input, key) => {
      if (!isActive) {
        return;
      }
      const action = resolveScrollAction(key);
      if (action !== null) {
        dispatch(action);
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
  //
  // Each wheel notch resolves to a SINGLE setState (not three line-up
  // dispatches) — fast scrolling otherwise produced one re-render per line
  // and Yoga relayout cost compounded. Computing the new offset inline
  // collapses N wheel events into N renders instead of 3N.
  const _WHEEL_LINES = 3;
  const handleWheelUp = useCallback(() => {
    if (!isActive) {
      return;
    }
    setLinesFromBottom((prev) =>
      wheelUpClamp({
        prev,
        totalLines,
        viewportLines,
      }),
    );
  }, [
    isActive,
    totalLines,
    viewportLines,
  ]);
  const handleWheelDown = useCallback(() => {
    if (!isActive) {
      return;
    }
    setLinesFromBottom((prev) => wheelDownClamp(prev));
  }, [
    isActive,
  ]);
  useMouseScroll({
    onScrollUp: handleWheelUp,
    onScrollDown: handleWheelDown,
    isActive,
  });

  const detached = linesFromBottom > 0;
  const canScrollUp = linesFromBottom < detachedMax;

  // Memoise the entry node list so a scroll-only re-render (linesFromBottom
  // change, no entries change) doesn't re-walk every wrapper. Without this,
  // Yoga still has to relayout the column on every margin tick, but at
  // least React isn't re-building 100+ child trees per line of scroll.
  const entryNodes = useMemo(
    () =>
      entries.map((entry, i) => (
        <Box key={keyFor(entry, i)} flexShrink={0}>
          {renderEntry(entry, i)}
        </Box>
      )),
    [
      entries,
      keyFor,
      renderEntry,
    ],
  );

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Scrolling viewport. `overflow="hidden"` clips the inner content's
          translation past its edges; flex-end aligns the inner column to the
          bottom of this region. */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden" justifyContent="flex-end">
        <Box flexDirection="column" flexShrink={0} marginBottom={-linesFromBottom}>
          {entryNodes}
          {trailing ? <Box flexShrink={0}>{trailing}</Box> : null}
        </Box>
      </Box>
      {detached ? (
        // Indicator sits OUTSIDE the overflow:hidden box so the marginBottom
        // translation can't push content into the same row. Right-aligned to
        // avoid overlapping the live token stats the LoadingSpinner renders
        // at the start of the same row when streaming is in flight.
        <Box flexShrink={0} justifyContent="flex-end">
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
