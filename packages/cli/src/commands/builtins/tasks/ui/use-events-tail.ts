/**
 * React hook that signals when the task event log changes.
 *
 * Combines two signals:
 *
 * 1. **Polling**: stat the project's `_events.jsonl` once per second; bump
 *    the returned counter when the file size grows. This catches writes
 *    made by daemons / other processes — anyone that appends an event via
 *    `appendEvent` from `fs-store.ts`.
 * 2. **In-process bus**: subscribe to `taskEvents` for instant updates
 *    when the same process writes events (the chat TUI, agent-ci runner,
 *    etc.).
 *
 * The returned `revision` number monotonically increases. Consumers depend
 * on it as a re-fetch trigger (e.g. inside a `useEffect`).
 */

import type { FsAdapter } from '@noetic/core';
import { useEffect, useState } from 'react';

import { taskEvents } from '../events.js';
import { taskRootPaths } from '../paths.js';
import type { Event, EventKind } from '../schemas.js';

//#region Types

export interface UseEventsTailOptions {
  /** Project root whose `.noetic/tasks/_events.jsonl` is being watched. */
  readonly projectRoot: string;
  /** FS adapter used to stat the events file. */
  readonly fs: FsAdapter;
  /** When false, polling and subscriptions are paused. Defaults to true. */
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
}): Promise<number> {
  const paths = taskRootPaths(opts.projectRoot);
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

/** Set of every `EventKind` so listeners are wired exhaustively. */
const ALL_EVENT_KINDS: ReadonlyArray<EventKind> = [
  'task:created',
  'task:updated',
  'task:moved',
  'task:archived',
  'task:reviewStatusChanged',
  'session:finished',
  'log:appended',
  'milestone:created',
  'slice:created',
  'feature:created',
  'assertion:created',
  'feature:loopStateChanged',
  'feature:linkedToTask',
  'feature:fixGenerated',
  'feature:budgetExhausted',
  'validator:runRecorded',
  'mission:statusChanged',
];

//#endregion

//#region Public hook

/**
 * Subscribe to task-event activity. Returns a `revision` number whose
 * value changes (always increasing) every time fresh events appear, and
 * `lastEvent` — the most recent in-process event observed via
 * `taskEvents`. `lastEvent` is `null` until the first in-process emission;
 * out-of-process events bump `revision` without populating `lastEvent`.
 */
export function useEventsTail(options: UseEventsTailOptions): {
  revision: number;
  lastEvent: Event | null;
} {
  const enabled = options.enabled ?? true;
  const pollIntervalMs = options.pollIntervalMs ?? 1e3;
  const [revision, setRevision] = useState(0);
  const [lastEvent, setLastEvent] = useState<Event | null>(null);

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

    const onEvent = (event: Event): void => {
      setLastEvent(event);
      setRevision((r) => r + 1);
    };
    for (const kind of ALL_EVENT_KINDS) {
      taskEvents.on(kind, onEvent);
    }

    return () => {
      cancelled = true;
      clearInterval(interval);
      for (const kind of ALL_EVENT_KINDS) {
        taskEvents.off(kind, onEvent);
      }
    };
  }, [
    enabled,
    options.fs,
    options.projectRoot,
    pollIntervalMs,
  ]);

  return {
    revision,
    lastEvent,
  };
}

//#endregion
