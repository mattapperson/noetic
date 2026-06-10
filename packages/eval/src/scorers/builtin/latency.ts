import type { ScorerFn } from '../types';

//#region Types

interface LatencyConfig {
  target: number;
  maxAcceptable: number;
}

//#endregion

//#region Helper Functions

function computeLatencyScore(elapsed: number, config: LatencyConfig): number {
  if (elapsed <= config.target) {
    return 1.0;
  }
  // target === maxAcceptable degenerates to a step function around target.
  if (config.maxAcceptable === config.target) {
    return 0;
  }
  const linear = 1 - (elapsed - config.target) / (config.maxAcceptable - config.target);
  return Math.max(0, Math.min(1, linear));
}

//#endregion

//#region Public API

/**
 * Scores wall-clock latency: 1.0 at or below `target`, falling linearly to 0
 * at `maxAcceptable` (clamped to [0, 1]). Throws `RangeError` at construction
 * when `maxAcceptable < target` — an inverted range would otherwise produce
 * scores above 1.
 */
export function latency(config: LatencyConfig): ScorerFn {
  if (config.maxAcceptable < config.target) {
    throw new RangeError(
      `latency(): maxAcceptable (${config.maxAcceptable}) must be >= target (${config.target})`,
    );
  }
  return async (execution) => {
    const elapsed = execution.context.elapsed;
    const score = computeLatencyScore(elapsed, config);

    return {
      scorerId: 'latency',
      score,
      reason: `Elapsed: ${Math.round(elapsed)}ms (target: ${config.target}ms)`,
      metadata: {
        elapsed,
        target: config.target,
        maxAcceptable: config.maxAcceptable,
      },
    };
  };
}

//#endregion
