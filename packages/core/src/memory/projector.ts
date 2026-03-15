import type { Item } from '../types/items';
import type { ProjectionPolicy } from '../types/memory';

export function assembleView(
  systemPromptItems: Item[],
  layerOutputItems: Item[],
  historyItems: Item[],
  policy?: ProjectionPolicy,
): Item[] {
  const view: Item[] = [];

  // Add system prompt items
  view.push(...systemPromptItems);

  // Add layer output items (sorted by slot already from recall)
  view.push(...layerOutputItems);

  // Add history items (with overflow handling if policy specified)
  if (policy && policy.overflow === 'sliding_window' && policy.windowSize) {
    const windowItems = historyItems.slice(-policy.windowSize);
    view.push(...windowItems);
  } else if (policy && policy.overflow === 'truncate') {
    // Simple truncation - take all items (truncation happens at token level upstream)
    view.push(...historyItems);
  } else {
    view.push(...historyItems);
  }

  return view;
}
