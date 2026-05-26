/**
 * CLI startup helper for reattaching to long-lived subprocess children
 * that survived a parent restart.
 *
 * Phase A2 gave every `SubprocessAdapter` a durable `reattach(handleId)` +
 * `listLive()` surface. A CLI host that configures a durable
 * `StorageAdapter` on its harness + subprocess adapter can call this once
 * after harness construction to:
 *
 *   1. Enumerate every live handle the adapter recognises.
 *   2. For each handle that carries an `executionId`, ask the harness to
 *      rebuild the parent context from the persisted checkpoint.
 *
 * The returned map lets the TUI / host look up the restored context by
 * handle id so any pending ask-user replay (see Chunk 6+ of Phase A2)
 * can target the correct modal.
 *
 * A harness configured without durable storage has empty `listLive`
 * results and a null-returning `restore`, so this call is a cheap no-op
 * in the default zero-config path. No allocation, no side effects, and
 * no impact on CLI startup time.
 */
import type { AgentHarness, Context, SubprocessHandle } from '@noetic-tools/core';

//#region Types

/** @public Outcome of a single reattach pass over the live subprocess set. */
export interface ReattachLiveResult {
  /** Every live handle the adapter recognised at startup. */
  readonly handles: ReadonlyArray<SubprocessHandle>;
  /**
   * Restored parent contexts keyed by handle id. Handles without an
   * `executionId` (or whose checkpoint was missing) are omitted.
   */
  readonly contexts: ReadonlyMap<string, Context>;
}

//#endregion

//#region Helpers

function executionIdFromHandle(handle: SubprocessHandle): string | null {
  const id = handle.metadata?.executionId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

//#endregion

//#region Public API

/**
 * @public
 * Rediscover and rehydrate every live subprocess child the adapter
 * recognises after a parent-process restart. Safe to call on every
 * startup path — when no durable storage is configured, returns empty
 * results without side effects.
 */
export async function reattachLiveChildren(harness: AgentHarness): Promise<ReattachLiveResult> {
  const handles = await harness.subprocess.listLive();
  const contexts = new Map<string, Context>();
  for (const handle of handles) {
    const executionId = executionIdFromHandle(handle);
    if (executionId === null) {
      continue;
    }
    const ctx = await harness.restore(executionId);
    if (ctx !== null) {
      contexts.set(handle.id, ctx);
    }
  }
  return {
    handles,
    contexts,
  };
}

//#endregion
