import type { FunctionCallItem, Item } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';

function isFunctionCall(item: Item): item is FunctionCallItem {
  return item.type === 'function_call' && 'callId' in item && 'name' in item;
}

/**
 * Finds the first function_call item matching `name`, parses its JSON arguments,
 * and returns the result as a record. Returns null if no match or invalid data.
 */
export function findFunctionCall(
  items: ReadonlyArray<Item>,
  name: string,
): Record<string, unknown> | null {
  for (const item of items) {
    if (!isFunctionCall(item)) {
      continue;
    }
    if (item.name !== name) {
      continue;
    }
    try {
      const raw = JSON.parse(item.arguments);
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        continue;
      }
      return frameworkCast<Record<string, unknown>>(raw);
    } catch {}
  }
  return null;
}
