/**
 * Single-flight serialization for async factories.
 *
 * Wraps an async function so that at most one invocation runs at a time.
 * Callers that arrive while a flight is in progress wait for it to settle
 * and then run their own function — which lets them re-check any cache the
 * winner populated and return the cached value instead of duplicating work.
 *
 * Properties:
 * - Stacked callers drain strictly one at a time, in arrival order.
 * - A rejected flight does not wedge the gate: the rejection propagates to
 *   its own caller only, and the next waiter proceeds normally.
 */

export type SingleFlight = <T>(fn: () => Promise<T>) => Promise<T>;

export function createSingleFlight(): SingleFlight {
  let inFlight: Promise<void> | null = null;

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    // Wait out every flight ahead of us. The loop (not a single await) is
    // load-bearing: when a flight settles, all parked waiters wake, but only
    // the first to resume finds `inFlight === null` — it claims the gate
    // synchronously below, and the rest loop back to wait on the new flight.
    while (inFlight !== null) {
      await inFlight;
    }
    const flight = fn();
    // Track a rejection-swallowed mirror so waiters never see (or unhandled-
    // reject on) another caller's failure; the original promise still carries
    // the rejection to this caller via the await below.
    inFlight = flight.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await flight;
    } finally {
      inFlight = null;
    }
  };
}
