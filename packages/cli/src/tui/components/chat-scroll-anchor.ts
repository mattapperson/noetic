/**
 * Pure helpers for the ChatScroll viewport behaviours that ship alongside
 * the basic reducer (`chat-scroll-state.ts`):
 *
 *   - `anchoredOffsetAfterDelta` keeps a detached viewport pinned to the
 *     same content rows when new content arrives at the bottom. The naive
 *     "linesFromBottom stays the same" model drifts toward the latest as
 *     content grows, because the bottom edge moves too.
 *
 *   - `clampWheelLines` is the inline math the wheel handler runs to
 *     resolve a notch into a single setState (instead of three line-up
 *     dispatches → three relayouts).
 *
 * Both are exported as standalone functions so the component stays a thin
 * binding around React state + Yoga rendering, and the logic is testable
 * without ink.
 */

import { maxOffset } from './chat-scroll-state.js';

//#region Anchor on content growth

export interface AnchorArgs {
  /** Current `linesFromBottom` value. */
  prev: number;
  /** `totalLines` change since the last anchor pass (positive = content grew). */
  delta: number;
  /** New total content height in lines. */
  totalLines: number;
  /** Viewport height in lines. */
  viewportLines: number;
}

/**
 * Resolve the next `linesFromBottom` after a content-size change. Behaviour:
 *
 *  1. Stuck-to-bottom (`prev === 0`) stays stuck — new content tails. This
 *     is the only path where the user keeps following the latest output.
 *  2. Detached + content grew: anchor the viewport to the same content rows
 *     by adding `delta` to the offset (so the visible row range shifts by
 *     the same amount the content's row positions did).
 *  3. Content shrank (e.g. `/clear`): fall back to a hard clamp against the
 *     new ceiling so the offset can't sit above the new content top.
 *  4. Always clamp the result to `[0, maxOffset(totalLines, viewportLines)]`
 *     so a near-top user near the previous max doesn't overshoot when the
 *     new max is smaller.
 */
export function anchoredOffsetAfterDelta(args: AnchorArgs): number {
  const { prev, delta, totalLines, viewportLines } = args;
  if (prev === 0) {
    return 0;
  }
  const target = delta > 0 ? prev + delta : prev;
  const hi = maxOffset(totalLines, viewportLines);
  if (target < 0) {
    return 0;
  }
  if (target > hi) {
    return hi;
  }
  return target;
}

//#endregion

//#region Wheel clamp

/** Number of lines a single wheel notch advances the offset by. */
export const WHEEL_LINES = 3;

export interface WheelClampArgs {
  prev: number;
  totalLines: number;
  viewportLines: number;
}

/**
 * Next offset after a wheel-up notch. Inlined into the wheel handler so
 * each event is a single setState (not three `line-up` dispatches → three
 * Yoga relayouts).
 */
export function wheelUpClamp(args: WheelClampArgs): number {
  const hi = maxOffset(args.totalLines, args.viewportLines);
  const next = args.prev + WHEEL_LINES;
  return next > hi ? hi : next;
}

/**
 * Next offset after a wheel-down notch. `totalLines` / `viewportLines` are
 * not needed because the lower bound is always 0 — kept symmetric with
 * `wheelUpClamp` for call-site clarity.
 */
export function wheelDownClamp(prev: number): number {
  const next = prev - WHEEL_LINES;
  return next < 0 ? 0 : next;
}

//#endregion
