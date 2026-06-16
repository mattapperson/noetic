/**
 * Decide whether the context split view should render side-by-side ('wide')
 * or stacked ('narrow') given current terminal width and chosen panel width.
 *
 * See specs/28-context-split-view.md.
 */

import { CHAT_MIN_WIDTH } from './constants.js';
import type { LayoutMode } from './types.js';

export function decideLayoutMode(cols: number, panelWidth: number): LayoutMode {
  return cols >= panelWidth + CHAT_MIN_WIDTH ? 'wide' : 'narrow';
}
