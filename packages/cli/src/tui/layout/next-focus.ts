/**
 * Pure two-pane focus toggle for the Context Split View.
 * See specs/28-context-split-view.md.
 */

import type { Pane } from './types.js';

export function nextFocus(current: Pane): Pane {
  return current === 'chat' ? 'context' : 'chat';
}
