/**
 * Drop dangling tool-call state from a transcript before it's persisted or
 * replayed into the LLM. A `function_call` without a matching
 * `function_call_output` (or vice-versa) can be left behind by a crash or
 * abort mid-turn; if the model sees that on resume it typically wedges or
 * fabricates an output. Mirrors Claude Code's `filterUnresolvedToolUses`.
 */

import type { Item } from '@noetic/core';

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
