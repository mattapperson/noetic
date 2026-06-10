/**
 * Splits the display stream into a frozen prefix for Ink's `<Static>` and a
 * live suffix rendered in the dynamic region.
 *
 * `<Static>` renders each index exactly once and flushes it irreversibly to
 * terminal scrollback — so an entry may only enter it once nothing will
 * mutate it in place again. The frozen prefix therefore ends at the FIRST
 * still-mutable entry:
 *
 * - a queued user entry anywhere (markUserEntrySent later replaces it, and
 *   `<Static>` would freeze the "(queued)" badge forever);
 * - the trailing CollapsedReadGroup while a turn is active
 *   (streaming | submitted) — it keeps absorbing later reads;
 * - the trailing non-user entry while streaming — it's the entry currently
 *   being mutated in place by the item stream.
 *
 * Because entries are append-only and queued entries only ever flip to
 * `sent`, the frozen prefix only grows — positional static keys stay stable.
 */

import type { ChatStatus } from '../chat-status.js';
import { isUserEntry } from '../item-utils.js';
import type { DisplayEntry } from './types.js';
import { isCollapsedReadGroup } from './types.js';

export interface SplitStaticEntriesResult {
  /** Frozen prefix — safe to hand to `<Static>`. */
  staticEntries: DisplayEntry[];
  /** Live suffix — render in the dynamic region with offset indices. */
  liveEntries: DisplayEntry[];
}

function isQueuedUserEntry(entry: DisplayEntry): boolean {
  if (isCollapsedReadGroup(entry)) {
    return false;
  }
  return isUserEntry(entry) && entry.deliveryStatus === 'queued';
}

function isMutableTrailingEntry(entry: DisplayEntry, status: ChatStatus): boolean {
  if (isCollapsedReadGroup(entry)) {
    return status === 'streaming' || status === 'submitted';
  }
  return status === 'streaming' && !isUserEntry(entry);
}

export function splitStaticEntries(
  entries: ReadonlyArray<DisplayEntry>,
  status: ChatStatus,
): SplitStaticEntriesResult {
  let frozenEnd = entries.length;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry !== undefined && isQueuedUserEntry(entry)) {
      frozenEnd = i;
      break;
    }
  }
  const last = entries[entries.length - 1];
  if (last !== undefined && isMutableTrailingEntry(last, status)) {
    frozenEnd = Math.min(frozenEnd, entries.length - 1);
  }
  return {
    staticEntries: entries.slice(0, frozenEnd),
    liveEntries: entries.slice(frozenEnd),
  };
}
