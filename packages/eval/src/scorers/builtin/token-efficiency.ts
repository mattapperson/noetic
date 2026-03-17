import type { ScorerFn } from '../types';

//#region Types

interface TokenEfficiencyConfig {
  maxOutputTokens: number;
}

//#endregion

//#region Public API

export function tokenEfficiency(config: TokenEfficiencyConfig): ScorerFn {
  return async (execution) => {
    const outputTokens = execution.context.tokens.output;
    const ratio = outputTokens / config.maxOutputTokens;
    const score = ratio <= 1 ? 1.0 : Math.max(0, 1 - (ratio - 1));

    return {
      scorerId: 'token-efficiency',
      score,
      reason: `Output tokens: ${outputTokens} (max: ${config.maxOutputTokens})`,
      metadata: {
        outputTokens,
        maxOutputTokens: config.maxOutputTokens,
      },
    };
  };
}

//#endregion
