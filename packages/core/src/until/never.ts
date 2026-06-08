import type { Until, Verdict } from '@noetic-tools/types';

/**
 * Termination predicate that never stops the loop. Use with `every`-like
 * forever-loops or with explicit cancellation paths.
 *
 * @public
 * @returns An `Until` predicate that always returns `{ stop: false }`.
 */
export function never(): Until {
  return (): Verdict => ({
    stop: false,
  });
}
