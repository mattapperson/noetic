/**
 * Constants for the Context Split View layout primitives.
 * See specs/28-context-split-view.md.
 */

/** Minimum number of columns the chat pane requires before we switch to the narrow stacked layout. */
export const CHAT_MIN_WIDTH = 60;

/** Minimum number of columns the context panel needs (also the floor of the 'responsive' clamp). */
export const PANEL_MIN_WIDTH = 32;

/** Maximum number of columns the context panel will occupy under 'responsive'. */
export const PANEL_MAX_WIDTH = 56;

/** Lower bound of the user-facing fixed-width config range. */
export const PANEL_CONFIG_MIN = 28;

/** Upper bound of the user-facing fixed-width config range. */
export const PANEL_CONFIG_MAX = 80;
