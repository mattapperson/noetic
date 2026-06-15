/**
 * Estimate the rendered terminal-line height of a `DisplayEntry`.
 *
 * Used by `ChatScroll` to bound its per-line scroll offset — the estimate
 * doesn't need to be perfect (overflow clipping handles small errors), but
 * Home / End accuracy depends on it being in the right ballpark for tall
 * entries like long assistant messages and shell output.
 *
 * The estimator is intentionally simple:
 *   - Count `\n` + 1 in any string content we can find.
 *   - Add a small per-entry overhead (1–2 lines) for headers / margins.
 *   - Default to 2 lines for entry shapes we don't recognise rather than
 *     trying to read every possible item type — small underestimates only
 *     bias Home slightly, never blank the screen.
 *
 * Width-based wrapping is intentionally NOT modelled here. Most chat
 * content stays under 80–100 columns; the extra precision isn't worth the
 * cost of plumbing terminal width through every caller.
 */

import {
  extractReasoning,
  extractTextContent,
  isErrorEntry,
  isSystemEntry,
  isUserEntry,
} from '../item-utils.js';
import type { CollapsedReadGroup, DisplayEntry } from './types.js';
import { isCollapsedReadGroup, totalOpCount } from './types.js';

const MIN_ENTRY_LINES = 1;
const DEFAULT_UNKNOWN_LINES = 2;

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      n++;
    }
  }
  return n;
}

function estimateCollapsedGroup(group: CollapsedReadGroup): number {
  // Header + (optional) hint line. Plus 1 if there are many ops to show.
  const ops = totalOpCount(group);
  return ops > 1 ? 3 : 2;
}

export function estimateEntryHeight(entry: DisplayEntry): number {
  if (isCollapsedReadGroup(entry)) {
    return estimateCollapsedGroup(entry);
  }
  if (isUserEntry(entry)) {
    // User row + a margin line.
    return Math.max(MIN_ENTRY_LINES, countLines(entry.content)) + 1;
  }
  if (isErrorEntry(entry) || isSystemEntry(entry)) {
    return Math.max(MIN_ENTRY_LINES, countLines(entry.content));
  }
  // AssistantEntry — Item or StreamingItem. Switch on `type`.
  if (entry.type === 'message') {
    const text = extractTextContent(entry);
    // Header (role label) + content + trailing blank.
    return Math.max(MIN_ENTRY_LINES, countLines(text)) + 2;
  }
  if (entry.type === 'reasoning') {
    const text = extractReasoning(entry) ?? '';
    return Math.max(MIN_ENTRY_LINES, countLines(text)) + 1;
  }
  if (entry.type === 'function_call') {
    // `→ ToolName(args)` row, possibly an args preview line beneath.
    return 2;
  }
  if (entry.type === 'function_call_output') {
    return Math.max(MIN_ENTRY_LINES, countLines(entry.output));
  }
  return DEFAULT_UNKNOWN_LINES;
}
