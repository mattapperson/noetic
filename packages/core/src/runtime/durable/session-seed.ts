/**
 * Seed an agent harness's session history from a pre-parsed `Item[]`.
 *
 * Callers who have chat history on disk (JSONL, DB, etc.) read + parse
 * the persisted format into `Item[]` themselves — this helper is
 * deliberately path-free so it composes with any storage layer.
 *
 * The helper is a thin typed wrapper around `harness.seedSessionHistory`
 * and exists so the runnable-loop (and any other caller that wants to
 * restore a prior session) has one documented, named entrypoint rather
 * than reaching for the harness method inline.
 */

import type { Item } from '@noetic-tools/types';

//#region Types

/**
 * Minimum harness surface `seedFromItems` requires. Defined structurally
 * so tests (and out-of-process children) can pass a stub without casts;
 * `AgentHarness<P>` from core satisfies the shape directly.
 */
export interface SessionSeedHarness {
  seedSessionHistory(threadId: string, items: ReadonlyArray<Item>): void;
}

//#endregion

//#region Public API

/**
 * Seed `harness`'s session for `threadId` with the given items so the
 * next `execute()` call sees them in the item log. No-op when `items`
 * is empty (the harness call itself is also safe to make with an empty
 * array; short-circuiting here keeps the intent crisp).
 */
export function seedFromItems(
  harness: SessionSeedHarness,
  threadId: string,
  items: ReadonlyArray<Item>,
): void {
  if (items.length === 0) {
    return;
  }
  harness.seedSessionHistory(threadId, items);
}

//#endregion
