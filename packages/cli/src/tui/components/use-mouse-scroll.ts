/**
 * React hook that surfaces terminal mouse-wheel scroll events as plain
 * `'up' | 'down'` callbacks.
 *
 * Why this exists: noetic runs inside the alternate screen buffer, which
 * suspends the terminal's native scrollback. The keyboard (PgUp/PgDn,
 * Shift+↑/↓) already drives `ChatScroll`'s scroll state machine. Mouse
 * support is the same machinery wired to a different input source.
 *
 * The actual stdin interception (parse SGR mouse, strip the bytes from
 * what ink sees) lives in `mouse-stdin-filter.ts`. This hook is just the
 * React-flavoured registration boundary: subscribe on mount, unsubscribe on
 * unmount, refcounted so siblings can coexist.
 */

import { useEffect } from 'react';
import { subscribeMouseEvents } from './mouse-stdin-filter.js';

export interface UseMouseScrollOptions {
  /** Fired for every wheel-up event. */
  onScrollUp: () => void;
  /** Fired for every wheel-down event. */
  onScrollDown: () => void;
  /** When false, no subscription is installed and no callbacks fire. */
  isActive?: boolean;
}

export function useMouseScroll(opts: UseMouseScrollOptions): void {
  const { onScrollUp, onScrollDown, isActive = true } = opts;

  useEffect(() => {
    if (!isActive) {
      return;
    }
    return subscribeMouseEvents((event) => {
      if (event.kind === 'wheel-up') {
        onScrollUp();
      } else if (event.kind === 'wheel-down') {
        onScrollDown();
      }
      // press / release / other intentionally ignored — ChatScroll is a
      // scrollback view, not a click target. The events are still parsed
      // out at the stdin layer so they can never leak into the prompt.
    });
  }, [
    isActive,
    onScrollUp,
    onScrollDown,
  ]);
}
