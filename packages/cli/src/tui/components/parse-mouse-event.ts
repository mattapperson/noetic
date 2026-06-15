/**
 * Parse a single SGR mouse-event escape sequence into a normalised event.
 *
 * Reference (xterm control sequences, "Extended coordinates", SGR mode):
 *   CSI < Cb ; Cx ; Cy M    — press
 *   CSI < Cb ; Cx ; Cy m    — release  (lowercase final byte)
 *
 * `Cb` (button) encoding bits:
 *   0–2  : button id (0=left, 1=middle, 2=right, 3=release-of-any in 1000-mode
 *          — SGR doesn't use 3 because the final byte already disambiguates)
 *   4    : Shift
 *   5    : Meta / Alt
 *   6    : Control
 *   7    : Motion flag (drag — only sent in 1002/1003 modes)
 *   6+   : Extra-button bit — button id is 64 + idx for wheel events:
 *            64 = wheel up
 *            65 = wheel down
 *            66 = wheel left (rare)
 *            67 = wheel right (rare)
 *
 * The parser is intentionally tolerant: anything that doesn't match the exact
 * `CSI <…M|m` shape returns null so the caller can fall back to keystroke
 * handling.
 */

export type MouseEventKind = 'wheel-up' | 'wheel-down' | 'press' | 'release' | 'other';

export interface MouseEvent {
  kind: MouseEventKind;
  /** 1-based column, as reported by the terminal. */
  x: number;
  /** 1-based row. */
  y: number;
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
}

// Constructed via RegExp so the lint rule against literal control characters
// stays clean — the source pattern still matches a real ESC byte (0x1B).
const SGR_MOUSE_RE = new RegExp(`^${String.fromCharCode(0x1b)}\\[<(\\d+);(\\d+);(\\d+)([Mm])`);

/**
 * Try to parse the head of `chunk` as an SGR mouse event. Returns the parsed
 * event plus the number of bytes consumed, or `null` if the chunk doesn't
 * start with one.
 */
export function parseMouseEvent(chunk: string): {
  event: MouseEvent;
  consumed: number;
} | null {
  const match = SGR_MOUSE_RE.exec(chunk);
  if (!match) {
    return null;
  }
  const [whole, rawButton, rawX, rawY, finalByte] = match;
  const button = Number(rawButton);
  const x = Number(rawX);
  const y = Number(rawY);
  if (!Number.isFinite(button) || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  const isRelease = finalByte === 'm';
  const shift = (button & 4) !== 0;
  const meta = (button & 8) !== 0;
  const ctrl = (button & 16) !== 0;
  // Mask out modifier bits and motion flag to recover the base button id.
  const baseButton = button & ~(4 | 8 | 16 | 32);
  let kind: MouseEventKind;
  if (baseButton === 64) {
    kind = 'wheel-up';
  } else if (baseButton === 65) {
    kind = 'wheel-down';
  } else if (baseButton === 66 || baseButton === 67) {
    // Horizontal wheel — not used by ChatScroll today, but flag it as
    // "other" so the caller can ignore explicitly rather than fall through.
    kind = 'other';
  } else if (isRelease) {
    kind = 'release';
  } else {
    kind = 'press';
  }
  return {
    event: {
      kind,
      x,
      y,
      shift,
      meta,
      ctrl,
    },
    consumed: whole.length,
  };
}

/**
 * Iterate every SGR mouse event in `chunk` and yield each. Non-mouse bytes are
 * silently skipped — the caller is responsible for forwarding them to whoever
 * handles keystrokes (typically Ink, which sees the same data via its own
 * `stdin` subscription).
 */
export function* iterMouseEvents(chunk: string): Generator<MouseEvent> {
  let rest = chunk;
  while (rest.length > 0) {
    const parsed = parseMouseEvent(rest);
    if (parsed) {
      yield parsed.event;
      rest = rest.slice(parsed.consumed);
      continue;
    }
    // Find the next plausible CSI-< prefix; if none, we're done with this
    // chunk. This intentionally walks one byte at a time on a miss rather
    // than indexOf-jumping so a malformed sequence doesn't swallow a valid
    // event right after it.
    rest = rest.slice(1);
  }
}
