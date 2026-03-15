import type { Item } from '../types/items';
import type { ProjectionPolicy } from '../types/memory';

//#region Types

interface AssembleViewParams {
  systemPromptItems: Item[];
  layerOutputItems: Item[];
  historyItems: Item[];
  policy?: ProjectionPolicy;
}

//#endregion

//#region Public API

export function assembleView({
  systemPromptItems,
  layerOutputItems,
  historyItems,
  policy,
}: AssembleViewParams): Item[] {
  const view: Item[] = [];

  // Add system prompt items
  view.push(...systemPromptItems);

  // Add layer output items (sorted by slot already from recall)
  view.push(...layerOutputItems);

  // Add history items (with overflow handling if policy specified)
  if (policy?.overflow === 'sliding_window' && policy.windowSize) {
    const windowItems = historyItems.slice(-policy.windowSize);
    view.push(...windowItems);
  } else {
    view.push(...historyItems);
  }

  return view;
}

//#endregion
