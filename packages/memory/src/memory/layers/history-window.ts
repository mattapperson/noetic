/**
 * History-window memory layer — caps the number of items projected to the LLM
 * without touching `itemLog` storage. Pure read-side projection via the
 * `projectHistory` hook.
 *
 * Algorithm per turn:
 *   1. Slice the last `maxItems`.
 *   2. If the slice lacks a user `message` or an assistant `message`, expand
 *      backward until both are present. The cap may be exceeded, but only up to
 *      a hard bound (`maxItems * MAX_EXPANSION_MULTIPLE`) — a tool-only burst
 *      cannot grow the window back to the start of history.
 *   3. Re-attach a system/anchor message from the head if it fell outside the
 *      window, so core instructions survive windowing.
 *   4. Drop any orphan `function_call` / `function_call_output` left at the
 *      slice boundary via `stripUnresolvedToolCalls`.
 */

import type { Item, MemoryLayer } from '@noetic-tools/types';
import { isAssistantMessage, isUserMessage, NoeticConfigError, Slot } from '@noetic-tools/types';
import { stripUnresolvedToolCalls } from '../strip-unresolved';

//#region Constants

const DEFAULT_MAX_ITEMS = 40;
const MIN_MAX_ITEMS = 2;
const MAX_MAX_ITEMS = 1e4;
const HISTORY_WINDOW_SLOT = Slot.PROCEDURAL + 25; // 275 — runs after recall-contributing layers
// Hard upper bound on how far minimum-exchange expansion may grow the window,
// expressed as a multiple of maxItems. Without this, a tool-only burst lets the
// window expand back to the first role-pair, defeating the cap entirely.
const MAX_EXPANSION_MULTIPLE = 4;
// How many leading items to scan for a system/anchor message to preserve.
const ANCHOR_SCAN_LIMIT = 4;

//#endregion

//#region Types

/** @public Configuration for the {@link historyWindow} layer. */
export interface HistoryWindowConfig {
  /** Cap on the number of trailing items projected to the LLM. Defaults to 40. */
  maxItems?: number;
}

//#endregion

//#region Helpers

function validateMaxItems(value: number): void {
  if (!Number.isInteger(value) || value < MIN_MAX_ITEMS || value > MAX_MAX_ITEMS) {
    throw new NoeticConfigError({
      code: 'INVALID_HISTORY_WINDOW_MAX_ITEMS',
      message: `historyWindow: maxItems must be an integer in [${MIN_MAX_ITEMS}, ${MAX_MAX_ITEMS}], got ${value}`,
      hint: 'Pass a sensible cap such as { maxItems: 40 }, or omit the layer to keep history uncapped.',
    });
  }
}

/**
 * Walk backwards from the natural slice point until both a user message and
 * an assistant message are present. Returns the index at which the projected
 * window should start in the full `items` array.
 */
function expandToMinimumExchange(items: ReadonlyArray<Item>, sliceStart: number): number {
  let start = sliceStart;
  let needsUser = true;
  let needsAssistant = true;
  // Pass 1: scan the natural slice for the user/assistant pair. Early-return
  // at the original sliceStart when both roles are already inside.
  for (let i = items.length - 1; i >= start; i--) {
    const item = items[i];
    if (needsUser && isUserMessage(item)) {
      needsUser = false;
    }
    if (needsAssistant && isAssistantMessage(item)) {
      needsAssistant = false;
    }
    if (!needsUser && !needsAssistant) {
      return start;
    }
  }
  // Pass 2: walk backward past the slice until the missing role(s) are found.
  for (let i = start - 1; i >= 0 && (needsUser || needsAssistant); i--) {
    const item = items[i];
    if (needsUser && isUserMessage(item)) {
      needsUser = false;
      start = i;
      continue;
    }
    if (needsAssistant && isAssistantMessage(item)) {
      needsAssistant = false;
      start = i;
    }
  }
  return start;
}

/**
 * Find a system/anchor message in the leading items that falls outside the
 * projected window (`windowStart`). Returns it so it can be re-attached to the
 * head of the projection; returns null when there is none.
 */
function findHeadAnchor(items: ReadonlyArray<Item>, windowStart: number): Item | null {
  const limit = Math.min(windowStart, ANCHOR_SCAN_LIMIT);
  for (let i = 0; i < limit; i++) {
    const item = items[i];
    if (item.type === 'message' && item.role === 'system') {
      return item;
    }
  }
  return null;
}

//#endregion

//#region Public API

/**
 * Creates a history-window memory layer that caps the trailing items projected
 * to the LLM. Storage stays unbounded; only the wire payload is narrowed.
 *
 * @public
 * @param config - Optional `{ maxItems }`. Defaults to 40.
 * @returns A `MemoryLayer` that contributes only a `projectHistory` hook.
 */
export function historyWindow(config?: HistoryWindowConfig): MemoryLayer<null> {
  const maxItems = config?.maxItems ?? DEFAULT_MAX_ITEMS;
  validateMaxItems(maxItems);

  return {
    id: 'history-window',
    name: 'History Window',
    slot: HISTORY_WINDOW_SLOT,
    scope: 'execution',
    hooks: {
      async init() {
        return {
          state: null,
        };
      },
      async projectHistory({ items }) {
        if (items.length <= maxItems) {
          return {
            items,
          };
        }
        const sliceStart = items.length - maxItems;
        let expandedStart = expandToMinimumExchange(items, sliceStart);
        // Hard upper bound: minimum-exchange expansion (e.g. for a tool-only
        // burst) must never grow the window without limit. Drop the oldest
        // excess so the projected count stays a bounded multiple of maxItems.
        const maxWindow = maxItems * MAX_EXPANSION_MULTIPLE;
        if (items.length - expandedStart > maxWindow) {
          expandedStart = items.length - maxWindow;
        }
        const window = items.slice(expandedStart);
        // Preserve a system/anchor message at the head even when it falls
        // outside the trailing window.
        const anchor = findHeadAnchor(items, expandedStart);
        const cleaned = stripUnresolvedToolCalls(
          anchor
            ? [
                anchor,
                ...window,
              ]
            : window,
        );
        return {
          items: cleaned,
        };
      },
    },
  } satisfies MemoryLayer<null>;
}

//#endregion
