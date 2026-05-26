/**
 * React context that exposes live stream metric refs to the loading spinner.
 *
 * The spinner re-renders on its own animation clock (~80ms) and reads these
 * refs each tick so per-delta updates (text streaming in char by char) never
 * trigger a React render of the whole app tree.
 */

import type { MutableRefObject, ReactNode } from 'react';
import { createContext, useContext } from 'react';

//#region Types

export interface LiveTokens {
  input: number;
  output: number;
  cached?: number;
}

export interface StreamMetricsRefs {
  /** Wall-clock time `turn_started` fired, or null when idle. */
  turnStartedAt: MutableRefObject<number | null>;
  /** Wall-clock time the first assistant text delta arrived this turn, or null. */
  firstTokenAt: MutableRefObject<number | null>;
  /** Accumulated assistant-text characters for the current turn (resets per turn). */
  liveOutputChars: MutableRefObject<number>;
  /** Exact token usage after `turn_completed` resolves `getAgentResponse()`. */
  liveTokens: MutableRefObject<LiveTokens | null>;
}

//#endregion

//#region Context

const StreamMetricsReactContext = createContext<StreamMetricsRefs | null>(null);

export function StreamMetricsProvider({
  value,
  children,
}: {
  value: StreamMetricsRefs;
  children: ReactNode;
}): ReactNode {
  return (
    <StreamMetricsReactContext.Provider value={value}>
      {children}
    </StreamMetricsReactContext.Provider>
  );
}

/**
 * Returns the stream metric refs. Returns `null` outside a provider so
 * components can gracefully render without live metrics (e.g. tests that
 * mount the spinner in isolation).
 */
export function useStreamMetrics(): StreamMetricsRefs | null {
  return useContext(StreamMetricsReactContext);
}

//#endregion
