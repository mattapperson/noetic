/**
 * Shared types for the Context Split View layout primitives.
 * See specs/28-context-split-view.md.
 */

export type LayoutMode = 'wide' | 'narrow';
export type Pane = 'chat' | 'context';

/**
 * The user-facing `ui.contextPanelWidth` value. `'responsive'` lets the
 * layout pick a column count based on terminal width; a number pins the
 * panel to that column count (clamped at runtime if the terminal is too
 * narrow to also fit `CHAT_MIN_WIDTH` chat columns).
 */
export type ContextPanelWidthConfig = 'responsive' | number;
