/**
 * Resolve the desired context panel width for the current terminal column
 * count and user config.
 *
 *  - `'responsive'` → clamp(PANEL_MIN_WIDTH, floor(0.40 * cols), PANEL_MAX_WIDTH).
 *  - numeric        → the requested value, clamped down at runtime if the
 *                     terminal cannot also fit CHAT_MIN_WIDTH chat columns.
 *
 * Returned width is always at least PANEL_MIN_WIDTH, never larger than the
 * total terminal width, and — for fixed config values — never large enough
 * to crowd the chat below CHAT_MIN_WIDTH (the caller still uses
 * decideLayoutMode to choose between wide/narrow rendering).
 *
 * See specs/28-context-split-view.md.
 */

import { CHAT_MIN_WIDTH, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from './constants.js';
import type { ContextPanelWidthConfig } from './types.js';

const RESPONSIVE_FRACTION = 0.4;

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

export function resolvePanelWidth(cols: number, config: ContextPanelWidthConfig): number {
  if (config === 'responsive') {
    const ideal = Math.floor(RESPONSIVE_FRACTION * cols);
    return clamp(ideal, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH);
  }
  // Fixed numeric: respect the request, but clamp down so chat can still
  // claim CHAT_MIN_WIDTH if the terminal is roomy enough. If it isn't,
  // leave the requested value alone — decideLayoutMode will then pick
  // 'narrow' and the panel will stack rather than steal chat columns.
  const fitsBoth = cols - CHAT_MIN_WIDTH;
  if (fitsBoth >= PANEL_MIN_WIDTH && config > fitsBoth) {
    return clamp(fitsBoth, PANEL_MIN_WIDTH, config);
  }
  return Math.max(PANEL_MIN_WIDTH, config);
}
