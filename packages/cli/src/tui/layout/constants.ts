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

/**
 * Maximum number of columns the context panel will occupy under 'responsive'.
 * Sized so the 0.40 fraction continues to scale on wide terminals (≥180
 * cols) instead of pinning at the bar width; users on extreme widths can
 * still pin a larger fixed value up to PANEL_CONFIG_MAX.
 */
export const PANEL_MAX_WIDTH = 72;

// PANEL_CONFIG_MIN / PANEL_CONFIG_MAX (the user-facing fixed-width range)
// live in `packages/cli/src/types/config.ts` so the Zod schema can derive
// its bounds from the same constants. The accessors + field description
// import them directly from there. `PANEL_CONFIG_MIN` must stay ≥
// `PANEL_MIN_WIDTH`; the invariant is asserted in
// `test/layout-primitives.test.ts`.
