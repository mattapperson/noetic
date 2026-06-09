/**
 * React hook that signals when the task event log changes.
 *
 * The hook polls `_events.jsonl` once per second; whenever the file size
 * grows, it bumps the returned `revision` counter. This catches every
 * `appendEvent` call regardless of which process produced it (chat TUI,
 * agent-ci runner, daemon flow, etc.) — the on-disk file is the durable,
 * cross-process record.
 *
 * Out-of-process daemon code reacts to runner outcomes through the
 * external `tasks.events` channel (`channels.ts`); the TUI hook keeps
 * its single, simple file-tail signal so it doesn't need a harness in
 * scope to render.
 *
 * The returned `revision` number monotonically increases. Consumers
 * depend on it as a re-fetch trigger (e.g. inside a `useEffect`).
 */

import { taskRootPaths } from '@noetic-tools/code-agent/tasks/store/fs-node';
import type { FsAdapter } from '@noetic-tools/core';
import { useEffect, useState } from 'react';

//#region Types

export interface UseEventsTailOptions {
  /** Project root whose `.noetic/tasks/_events.jsonl` is being watched. */
  readonly projectRoot: string;
  /** FS adapter used to stat the events file. */
  readonly fs: FsAdapter;
  /** When false, polling is paused. Defaults to true. */
  readonly enabled?: boolean;
  /** Polling interval in milliseconds. Defaults to 1000 (1 Hz). */
  readonly pollIntervalMs?: number;
}

//#endregion

//#region Helpers

/**
 * Read the size of `_events.jsonl`, returning -1 when the file is absent
 * (the negative sentinel is distinct from the legitimate `0` size of a
 * freshly truncated file).
 */
export async function readEventsSize(opts: {
  fs: FsAdapter;
  projectRoot: string;
  tasksRoot?: string;
}): Promise<number> {
  const paths = taskRootPaths(opts);
  try {
    const stats = await opts.fs.stat(paths.events);
    return stats.size;
  } catch {
    return -1;
  }
}

/**
 * Pure predicate: should the watermark advance the revision counter?
 *
 * - First observation (`prev === -1`): always advance, so consumers fetch
 *   the initial state.
 * - Subsequent observations: advance only when the size increased — events
 *   are append-only, so any growth means new entries.
 */
export function shouldBumpRevision(prev: number, next: number): boolean {
  if (prev === -1) {
    return next >= 0;
  }
  return next > prev;
}

//#endregion

//#region Public hook

/**
 * Subscribe to task-event activity. Returns a `revision` number whose
 * value increases every time the on-disk events file grows. Consumers
 * use the counter as a re-fetch trigger.
 */
export function useEventsTail(options: UseEventsTailOptions): {
  revision: number;
} {
  const enabled = options.enabled ?? true;
  const pollIntervalMs = options.pollIntervalMs ?? 1e3;
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    let prevSize = -1;

    async function poll(): Promise<void> {
      const next = await readEventsSize({
        fs: options.fs,
        projectRoot: options.projectRoot,
      });
      if (cancelled) {
        return;
      }
      if (shouldBumpRevision(prevSize, next)) {
        prevSize = next;
        setRevision((r) => r + 1);
      }
    }

    void poll();
    const interval = setInterval(() => {
      void poll();
    }, pollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [
    enabled,
    options.fs,
    options.projectRoot,
    pollIntervalMs,
  ]);

  return {
    revision,
  };
}

//#endregion
