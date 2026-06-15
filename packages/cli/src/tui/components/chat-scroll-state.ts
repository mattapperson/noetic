/**
 * Pure scroll-state machine for ChatScroll.
 *
 * Extracted from the component so the math is unit-testable without spinning
 * up Ink. `scrollFromBottom` counts entries hidden below the bottom of the
 * viewport. `0` means "stuck to bottom" — new entries arriving at offset 0
 * keep the user looking at the latest message. Anything `> 0` means the view
 * is detached.
 *
 * The reducer never returns a negative offset and clamps the maximum to
 * `max(0, entriesLen - 1)` so a jump-to-top is well-defined for both empty
 * and single-entry transcripts.
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
   * Re-clamp the current offset against a new `entriesLen` — used when the
   * transcript shrinks (session restart, history truncation) so a detached
   * view doesn't sit "below" the available content.
   */
  | {
      kind: 'clamp';
    };

export interface ScrollContext {
  entriesLen: number;
  pageSize: number;
}

export function pageSizeFor(viewportRows: number): number {
  return Math.max(1, Math.floor(viewportRows / 2));
}

export function maxOffset(entriesLen: number): number {
  return Math.max(0, entriesLen - 1);
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
  const hi = maxOffset(ctx.entriesLen);
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
