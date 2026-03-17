import { frameworkCast } from '../interpreter/framework-cast';
import type { Item } from '../types/items';

/**
 * Finds the first function_call item matching `name`, parses its JSON arguments,
 * and returns the result as a record. Returns null if no match or invalid data.
 */
export function findFunctionCall(
  items: ReadonlyArray<Item>,
  name: string,
): Record<string, unknown> | null {
  for (const item of items) {
    if (item.type !== 'function_call') {
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
