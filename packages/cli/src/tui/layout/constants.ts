/**
 * Constants for the Context Split View layout primitives.
 * See specs/28-context-split-view.md.
 */

/** Minimum number of columns the chat pane requires before we switch to the narrow stacked layout. */
export const CHAT_MIN_WIDTH = 60;

/**
 * Minimum number of columns the context panel needs (also the floor of the
 * 'responsive' clamp). Sized so the per-layer row (14 label + 7 tokens + 24
 * bar = 45 cols) fits on a single line inside the narrow-mode bordered box
 * (2 border cols + 2 padding cols).
 */
export const PANEL_MIN_WIDTH = 49;

/** Maximum number of columns the context panel will occupy under 'responsive'. */
export const PANEL_MAX_WIDTH = 56;

/** Lower bound of the user-facing fixed-width config range. */
export const PANEL_CONFIG_MIN = 49;

/** Upper bound of the user-facing fixed-width config range. */
export const PANEL_CONFIG_MAX = 80;
