/**
 * Subscribes to the streaming `liveTokensRef` and yields a useState-backed
 * snapshot at a fixed cadence (default 10 Hz). Lets the context panel header
 * track live token usage without re-rendering the chat tree on every delta.
 *
 * See specs/28-context-split-view.md.
 */

import { useEffect, useState } from 'react';
import type { LiveTokens } from './stream-metrics-context.js';
import { useStreamMetrics } from './stream-metrics-context.js';

const DEFAULT_INTERVAL_MS = 100;

function shallowEqual(a: LiveTokens | null, b: LiveTokens | null): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null) {
    return false;
  }
  return a.input === b.input && a.output === b.output && a.cached === b.cached;
}

export function useThrottledLiveTokens(
  intervalMs: number = DEFAULT_INTERVAL_MS,
): LiveTokens | null {
  const metrics = useStreamMetrics();
  const [snapshot, setSnapshot] = useState<LiveTokens | null>(metrics?.liveTokens.current ?? null);

  useEffect(() => {
    if (!metrics) {
      return;
    }
    const id = setInterval(() => {
      const next = metrics.liveTokens.current;
      // Skip identity-only ticks — the ref often holds the same numbers
      // across consecutive timer fires (especially between turns), and
      // setState would otherwise re-render every subscriber at 10 Hz.
      setSnapshot((prev) => (shallowEqual(prev, next) ? prev : next));
    }, intervalMs);
    return (): void => {
      clearInterval(id);
    };
  }, [
    metrics,
    intervalMs,
  ]);

  return snapshot;
}
