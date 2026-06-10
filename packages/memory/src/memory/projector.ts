import type { Item, ProjectionPolicy } from '@noetic-tools/types';
import { estimateTokens } from '@noetic-tools/types';
import { stripUnresolvedToolCalls } from './strip-unresolved';

//#region Types

interface AssembleViewParams {
  systemPromptItems: Item[];
  layerOutputItems: Item[];
  historyItems: Item[];
  policy?: ProjectionPolicy;
}

//#endregion

//#region Helpers

/** Conservative per-item token estimate (serialized form ⇒ never under-counts). */
function itemTokens(item: Item): number {
  return estimateTokens(JSON.stringify(item));
}

function totalTokens(items: ReadonlyArray<Item>): number {
  let total = 0;
  for (const item of items) {
    total += itemTokens(item);
  }
  return total;
}

/**
 * Keep items from a slot-ascending list within `budget`, considering items in
 * slot order and dropping each non-fitting item INDIVIDUALLY. Layer-output
 * items are independent contributions (no contiguity requirement, unlike
 * history), so an oversized low-slot item must not evict later items that
 * still fit — lower-slot output gets first claim on the budget, and
 * higher-slot output is dropped first when space runs out.
 */
function keepFrontWithinBudget(items: ReadonlyArray<Item>, budget: number): Item[] {
  const kept: Item[] = [];
  let used = 0;
  for (const item of items) {
    const cost = itemTokens(item);
    if (used + cost > budget) {
      continue;
    }
    kept.push(item);
    used += cost;
  }
  return kept;
}

/**
 * Keep the MOST RECENT history items within `budget`, then strip any orphan
 * tool calls/outputs left dangling at the slice boundary. An optional
 * `windowSize` caps item count first (sliding-window overflow mode).
 */
function keepRecentWithinBudget(
  items: ReadonlyArray<Item>,
  budget: number,
  windowSize?: number,
): Item[] {
  const windowed = windowSize ? items.slice(-windowSize) : items;
  const kept: Item[] = [];
  let used = 0;
  for (let i = windowed.length - 1; i >= 0; i--) {
    const item = windowed[i];
    const cost = itemTokens(item);
    if (used + cost > budget) {
      break;
    }
    kept.unshift(item);
    used += cost;
  }
  return stripUnresolvedToolCalls(kept);
}

//#endregion

//#region Public API

/**
 * Assemble the model's context window from system prompt items, memory-layer
 * recall output (slot-ascending), and conversation history.
 *
 * Without a `policy` the inputs are concatenated as-is (optionally sliding the
 * history window by `windowSize`). With a `policy` the assembled view is held to
 * a hard token budget: system items are always kept; layer output is kept
 * low-slot-first (highest-slot dropped when tight); history takes the remainder,
 * keeping the most recent turns.
 */
export function assembleView({
  systemPromptItems,
  layerOutputItems,
  historyItems,
  policy,
}: AssembleViewParams): Item[] {
  if (!policy) {
    return [
      ...systemPromptItems,
      ...layerOutputItems,
      ...historyItems,
    ];
  }

  const budget = Math.max(0, policy.tokenBudget - policy.responseReserve);
  // System items are never dropped — they anchor the conversation.
  const afterSystem = Math.max(0, budget - totalTokens(systemPromptItems));
  const keptLayers = keepFrontWithinBudget(layerOutputItems, afterSystem);
  const afterLayers = Math.max(0, afterSystem - totalTokens(keptLayers));
  const keptHistory = keepRecentWithinBudget(historyItems, afterLayers, policy.windowSize);

  return [
    ...systemPromptItems,
    ...keptLayers,
    ...keptHistory,
  ];
}

//#endregion
