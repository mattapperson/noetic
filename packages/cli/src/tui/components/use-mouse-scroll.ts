/**
 * React hook that surfaces terminal mouse-wheel scroll events as plain
 * `'up' | 'down'` callbacks.
 *
 * Why this exists: noetic runs inside the alternate screen buffer, which
 * suspends the terminal's native scrollback. The keyboard (PgUp/PgDn,
 * Shift+↑/↓) already drives `ChatScroll`'s scroll state machine. Mouse
 * support is the same machinery wired to a different input source —
 * SGR-encoded mouse events that arrive on stdin once we've enabled mouse
 * reporting in `buildTerminalEnterSequence`.
 *
 * Ink owns the same stdin stream for keystrokes and uses
 * `parseKeypress`, which silently rejects mouse SGR sequences as unparsable
 * — they never reach a `useInput` callback. We attach our own `'data'`
 * listener alongside Ink's; the two coexist without interfering.
 *
 * When `isActive` is false the listener is removed entirely so an inactive
 * pane can't dispatch scroll events for keystrokes destined elsewhere.
 */

import { useEffect } from 'react';
import { iterMouseEvents } from './parse-mouse-event.js';

export interface UseMouseScrollOptions {
  /** Fired for every wheel-up event. */
  onScrollUp: () => void;
  /** Fired for every wheel-down event. */
  onScrollDown: () => void;
  /** When false, the listener is removed and no callbacks fire. */
  isActive?: boolean;
  /**
   * The stream to listen on. Defaults to `process.stdin`; tests pass a fake
   * with the same `on`/`off` shape.
   */
  stdin?: Pick<NodeJS.ReadStream, 'on' | 'off'>;
}

type DataChunk = string | Buffer;

export function useMouseScroll(opts: UseMouseScrollOptions): void {
  const { onScrollUp, onScrollDown, isActive = true, stdin = process.stdin } = opts;

  useEffect(() => {
    if (!isActive) {
      return;
    }
    const listener = (data: DataChunk): void => {
      const chunk = typeof data === 'string' ? data : data.toString('utf8');
      for (const event of iterMouseEvents(chunk)) {
        if (event.kind === 'wheel-up') {
          onScrollUp();
        } else if (event.kind === 'wheel-down') {
          onScrollDown();
        }
        // press/release/other intentionally ignored — ChatScroll is a
        // scrollback view, not a click target. The events still get parsed
        // out so they don't fall through and confuse downstream consumers.
      }
    };
    stdin.on('data', listener);
    return (): void => {
      stdin.off('data', listener);
    };
  }, [
    isActive,
    stdin,
    onScrollUp,
    onScrollDown,
  ]);
}
