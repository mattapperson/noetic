/**
 * The running handles a `SubprocessAdapter` holds, each paired with the
 * promise its `spawn()` caller waits on. A handle leaves the table the moment
 * it settles, so callers hear about a finished child at once (no polling) and
 * the adapter keeps nothing once the result is delivered.
 */

import type { SpawnedSubprocess, SubprocessHandle } from '@noetic-tools/types';

//#region Types

/** @public Running handles keyed by id; see `createLiveHandles`. */
export interface LiveHandles {
  /** Tracks a running handle. Returns what `spawn()` hands back. */
  add(handle: SubprocessHandle): SpawnedSubprocess;
  /** The running handle with this id, or `undefined` once it has settled. */
  get(handleId: string): SubprocessHandle | undefined;
  /** Replaces a running handle, e.g. on pause or resume. Ignored once it has settled. */
  update(handle: SubprocessHandle): void;
  /**
   * Ends a handle: resolves its `settled` with `handle` (which carries the
   * final status) and forgets it. Returns `false`, changing nothing, when the
   * handle already settled — a stopped child that finishes late, say.
   */
  settle(handle: SubprocessHandle): boolean;
  /** Every running handle. */
  values(): IterableIterator<SubprocessHandle>;
}

interface Entry {
  handle: SubprocessHandle;
  resolve(handle: SubprocessHandle): void;
}

//#endregion

//#region Public API

/** @public Creates an empty `LiveHandles` table for a `SubprocessAdapter`. */
export function createLiveHandles(): LiveHandles {
  const entries = new Map<string, Entry>();
  return {
    add(handle) {
      const settled = new Promise<SubprocessHandle>((resolve) => {
        entries.set(handle.id, {
          handle,
          resolve,
        });
      });
      return {
        handle,
        settled,
      };
    },
    get(handleId) {
      return entries.get(handleId)?.handle;
    },
    update(handle) {
      const entry = entries.get(handle.id);
      if (entry) {
        entry.handle = handle;
      }
    },
    settle(handle) {
      const entry = entries.get(handle.id);
      if (!entry) {
        return false;
      }
      entries.delete(handle.id);
      entry.resolve(handle);
      return true;
    },
    *values() {
      for (const entry of entries.values()) {
        yield entry.handle;
      }
    },
  };
}

//#endregion
