/**
 * Drop dangling tool-call state from an item list. A `function_call` without a
 * matching `function_call_output` (or vice-versa) wedges the model on the next
 * round (it typically fabricates an output), so we filter both sides of any
 * incomplete pair. Order-preserving and pure — safe to run after a slice.
 *
 * Mirrors Claude Code's `filterUnresolvedToolUses`. Used by the CLI's
 * session-resume path to drop dangling pairs left by a crash, and by the
 * `historyWindow` memory layer to clean orphans at the slice boundary.
 */

import type { Item } from '../types/items';

/** @public */
export function stripUnresolvedToolCalls(items: ReadonlyArray<Item>): Item[] {
  const outputCallIds = new Set<string>();
  const callCallIds = new Set<string>();
  for (const item of items) {
    if (item.type === 'function_call_output') {
      outputCallIds.add(item.callId);
      continue;
    }
    if (item.type === 'function_call') {
      callCallIds.add(item.callId);
    }
  }

  const keep: Item[] = [];
  for (const item of items) {
    if (item.type === 'function_call' && !outputCallIds.has(item.callId)) {
      continue;
    }
    if (item.type === 'function_call_output' && !callCallIds.has(item.callId)) {
      continue;
    }
    keep.push(item);
  }
  return keep;
}
