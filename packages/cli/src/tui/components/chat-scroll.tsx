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
 * State is a single integer `scrollFromBottom`, counted in *entries* (not
 * lines). `0` means "stuck to bottom" — new entries arriving while the view
 * is anchored at the bottom keep the most recent entry visible. Any value
 * `> 0` means the view is detached; new entries do NOT pull the view down,
 * and an indicator at the bottom announces how many entries are below the
 * fold.
 *
 * Entry-granularity scrolling is coarse for very tall entries (e.g. a 50-
 * line bash output), but it has two virtues: it works without measuring
 * Ink's variable-height rendered content, and the boundary between two
 * entries is always a clean place to land. A future iteration could add
 * line-granularity within the focused entry.
 *
 * Keybindings (active only when `isActive` is true)
 * -------------------------------------------------
 *   PgUp / PgDn        — scroll one viewport at a time (~ rows-3 entries)
 *   Shift+Up / Shift+Down — scroll a single entry
 *   Home               — jump to the top (oldest)
 *   End / Esc          — jump to the bottom (latest, re-stick)
 *
 * The arrow keys without Shift are deliberately not bound here — the prompt
 * uses them for cursor movement and history navigation.
 */

import { Box, Text, useInput, useStdout } from 'ink';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { ScrollAction } from './chat-scroll-state.js';
import { applyScrollAction, pageSizeFor } from './chat-scroll-state.js';
import { useMouseScroll } from './use-mouse-scroll.js';

//#region Types

export interface ChatScrollProps<TEntry> {
  /** All entries to display, oldest first. */
  entries: ReadonlyArray<TEntry>;
  /** Renders a single entry. The wrapper Box (with key) is provided by ChatScroll. */
  renderEntry: (entry: TEntry, index: number) => ReactNode;
  /** Stable key per entry — used for React reconciliation and indicator math. */
  keyFor: (entry: TEntry, index: number) => string;
  /**
   * Optional element appended after the entry stream (e.g. a streaming
   * spinner). Always rendered with the latest content; never scrolled past.
   */
  trailing?: ReactNode;
  /**
   * When false, scroll keys are not consumed (e.g. when an overlay or modal
   * is open). The viewport still renders.
   */
  isActive?: boolean;
}

//#endregion

//#region Hooks

function useViewportRows(): number {
  const { stdout } = useStdout();
  const [rows, setRows] = useState<number>(stdout?.rows ?? 24);
  useEffect(() => {
    if (!stdout) {
      return;
    }
    const handler = (): void => {
      setRows(stdout.rows);
    };
    stdout.on('resize', handler);
    return (): void => {
      stdout.off('resize', handler);
    };
  }, [
    stdout,
  ]);
  return rows;
}

//#endregion

//#region Component

export function ChatScroll<TEntry>(props: ChatScrollProps<TEntry>): ReactNode {
  const { entries, renderEntry, keyFor, trailing, isActive = true } = props;
  const rows = useViewportRows();
  // `scrollFromBottom` counts entries hidden below the visible window. 0 =
  // stuck to bottom (most recent visible). Clamped to `entries.length` so a
  // jump-to-top is well-defined even on growing logs.
  const [scrollFromBottom, setScrollFromBottom] = useState(0);

  const entriesLen = entries.length;

  const pageSize = pageSizeFor(rows);

  // Re-clamp the current offset when the transcript shrinks (session
  // restart, history truncation) so a detached view doesn't sit "below" the
  // available content.
  useEffect(() => {
    setScrollFromBottom((prev) =>
      applyScrollAction(
        prev,
        {
          kind: 'clamp',
        },
        {
          entriesLen,
          pageSize: 1,
        },
      ),
    );
  }, [
    entriesLen,
  ]);

  const dispatch = useCallback(
    (action: ScrollAction) => {
      setScrollFromBottom((prev) =>
        applyScrollAction(prev, action, {
          entriesLen,
          pageSize,
        }),
      );
    },
    [
      entriesLen,
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

  // Mouse-wheel scrolling. Three notches per wheel tick is the conventional
  // "feels right" multiplier — single-entry granularity is too sticky on a
  // standard mouse wheel and a full page per notch overshoots. Trackpad
  // users get one event per "click" of inertial scroll, which matches.
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

  const visibleCount = Math.max(0, entriesLen - scrollFromBottom);
  const visible = entries.slice(0, visibleCount);
  const detached = scrollFromBottom > 0;

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      <Box flexDirection="column" flexGrow={1} justifyContent="flex-end">
        {visible.map((entry, i) => (
          <Box key={keyFor(entry, i)} flexShrink={0}>
            {renderEntry(entry, i)}
          </Box>
        ))}
        {!detached && trailing ? <Box flexShrink={0}>{trailing}</Box> : null}
      </Box>
      {detached ? (
        <Box>
          <Text dimColor>
            ↓ {scrollFromBottom} {scrollFromBottom === 1 ? 'entry' : 'entries'} below — End / Esc to
            jump to latest
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

//#endregion
