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
      setSnapshot(metrics.liveTokens.current);
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
