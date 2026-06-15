/**
 * Pure scroll-state machine for ChatScroll.
 *
 * Extracted from the component so the math is unit-testable without spinning
 * up Ink. `linesFromBottom` counts *terminal lines* (not entries) hidden
 * below the bottom of the viewport. `0` means "stuck to bottom" — new
 * content arriving at offset 0 keeps the user looking at the latest output.
 *
 * Per-line granularity is the right unit here: entry-granularity scroll
 * blanks the viewport when the only entries are taller than the screen
 * (e.g. a 200-line bash output or a long assistant message). Lines let the
 * user walk through a tall entry one row at a time.
 *
 * The reducer never returns a negative offset and clamps the maximum to
 * `max(0, totalLines - viewportLines)` so a Home jump lands exactly at the
 * point where the first content line touches the top of the viewport.
 */

export type ScrollAction =
  | {
      kind: 'page-up';
    }
  | {
      kind: 'page-down';
    }
  | {
      kind: 'line-up';
    }
  | {
      kind: 'line-down';
    }
  | {
      kind: 'home';
    }
  | {
      kind: 'end';
    }
  /**
   * Re-clamp the current offset against a new content/viewport size — used
   * when the transcript or terminal changes so a detached view doesn't sit
   * past the new ceiling or below 0.
   */
  | {
      kind: 'clamp';
    };

export interface ScrollContext {
  /**
   * Total rendered height of the content stack, in terminal lines. The
   * caller measures this from rendered entries; the reducer doesn't try to
   * inspect entry shapes.
   */
  totalLines: number;
  /** Height of the visible viewport in terminal lines. */
  viewportLines: number;
  /** Lines moved per page-up / page-down. Typically ~viewport/2. */
  pageSize: number;
}

export function pageSizeFor(viewportRows: number): number {
  return Math.max(1, Math.floor(viewportRows / 2));
}

export function maxOffset(totalLines: number, viewportLines: number): number {
  return Math.max(0, totalLines - viewportLines);
}

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) {
    return lo;
  }
  if (value > hi) {
    return hi;
  }
  return value;
}

export function applyScrollAction(
  current: number,
  action: ScrollAction,
  ctx: ScrollContext,
): number {
  const hi = maxOffset(ctx.totalLines, ctx.viewportLines);
  switch (action.kind) {
    case 'page-up':
      return clamp(current + ctx.pageSize, 0, hi);
    case 'page-down':
      return clamp(current - ctx.pageSize, 0, hi);
    case 'line-up':
      return clamp(current + 1, 0, hi);
    case 'line-down':
      return clamp(current - 1, 0, hi);
    case 'home':
      return hi;
    case 'end':
      return 0;
    case 'clamp':
      return clamp(current, 0, hi);
  }
}
