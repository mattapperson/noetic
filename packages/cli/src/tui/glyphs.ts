/**
 * Shared unicode glyphs for the TUI. The platform branch on BLACK_CIRCLE
 * matches the reference UI — the vertically-aligned U+23FA ⏺ renders well on
 * macOS terminals but is often mis-sized on Windows/Linux consoles, so fall
 * back to the bullet U+25CF ●.
 */

export const BLACK_CIRCLE = process.platform === 'darwin' ? '⏺' : '●';
export const CORNER = '⎿';
export const ELLIPSIS = '…';
export const EXPAND_HINT_TEXT = '(ctrl+o to expand)' as const;
