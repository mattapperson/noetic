/**
 * Estimate the rendered terminal-line height of a `DisplayEntry`.
 *
 * Used by `ChatScroll` to bound its per-line scroll offset — the estimate
 * doesn't need to be perfect (overflow clipping handles small errors), but
 * Home / End accuracy and "can I scroll at all" both hinge on it being in
 * the right ballpark for tall entries (long assistant replies and shell
 * output).
 *
 * Width matters: a 1000-character response with no `\n` wraps to ~13 lines
 * at 80 columns, not 1. The estimator therefore takes the viewport width
 * and walks each line of every text payload, charging `ceil(len / cols)`
 * for each. Width-zero callers fall back to a newline-only count.
 *
 * Per-entry overhead (header / margin) is a small constant tacked on after
 * the wrapped count — underestimates here only bias Home slightly, they
 * never blank the viewport.
 */

import type { AssistantEntry } from '../item-utils.js';
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

/**
 * Count visible lines for `text` if rendered at `cols` columns. Each `\n`-
 * split line is charged its wrapped height; a width of 0 (or a non-finite
 * value) degrades to a newline-only count.
 */
export function countWrappedLines(text: string, cols: number): number {
  if (text.length === 0) {
    return 0;
  }
  const safeCols = Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : Number.POSITIVE_INFINITY;
  let n = 0;
  let i = 0;
  while (i <= text.length) {
    const next = text.indexOf('\n', i);
    const end = next === -1 ? text.length : next;
    const lineLen = end - i;
    if (lineLen === 0) {
      n += 1;
    } else if (safeCols === Number.POSITIVE_INFINITY) {
      n += 1;
    } else {
      n += Math.max(1, Math.ceil(lineLen / safeCols));
    }
    if (next === -1) {
      break;
    }
    i = next + 1;
  }
  return n;
}

function estimateCollapsedGroup(group: CollapsedReadGroup): number {
  // Header + (optional) hint line. Plus 1 if there are many ops to show.
  const ops = totalOpCount(group);
  return ops > 1 ? 3 : 2;
}

/** Body row count + optional margin. Shared by every text-bearing entry. */
function estimateText(text: string, cols: number, overhead: number): number {
  return Math.max(MIN_ENTRY_LINES, countWrappedLines(text, cols)) + overhead;
}

/**
 * Assistant Item branch. Returns `null` if the item shape isn't recognised
 * so the caller can fall through to the default. Extracted out of
 * `estimateEntryHeight` to keep its cyclomatic complexity under the
 * sentrux complex-function threshold.
 */
function estimateAssistantItem(entry: AssistantEntry, cols: number): number | null {
  if (entry.type === 'message') {
    return estimateText(extractTextContent(entry), cols, 2);
  }
  if (entry.type === 'reasoning') {
    return estimateText(extractReasoning(entry) ?? '', cols, 1);
  }
  if (entry.type === 'function_call') {
    return 2;
  }
  if (entry.type === 'function_call_output') {
    return estimateText(entry.output, cols, 0);
  }
  return null;
}

export function estimateEntryHeight(entry: DisplayEntry, _index: number, cols: number): number {
  if (isCollapsedReadGroup(entry)) {
    return estimateCollapsedGroup(entry);
  }
  if (isUserEntry(entry)) {
    return estimateText(entry.content, cols, 1);
  }
  if (isErrorEntry(entry) || isSystemEntry(entry)) {
    return estimateText(entry.content, cols, 0);
  }
  const assistantHeight = estimateAssistantItem(entry, cols);
  return assistantHeight ?? DEFAULT_UNKNOWN_LINES;
}
