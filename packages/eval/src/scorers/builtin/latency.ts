import type { ScorerFn } from '../types';

//#region Types

interface LatencyConfig {
  target: number;
  maxAcceptable: number;
}

//#endregion

//#region Public API

export function latency(config: LatencyConfig): ScorerFn {
  return async (execution) => {
    const elapsed = execution.context.elapsed;
    const score =
      elapsed <= config.target
        ? 1.0
        : Math.max(0, 1 - (elapsed - config.target) / (config.maxAcceptable - config.target));

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
