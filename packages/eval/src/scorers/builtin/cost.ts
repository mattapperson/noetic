import type { ScorerFn } from '../types';

//#region Types

interface CostConfig {
  budgetPerCall: number;
}

//#endregion

//#region Public API

export function cost(config: CostConfig): ScorerFn {
  return async (execution) => {
    const actual = execution.context.cost;
    const ratio = actual / config.budgetPerCall;
    const score = ratio <= 1 ? 1.0 : Math.max(0, 1 - (ratio - 1));

    return {
      scorerId: 'cost',
      score,
      reason: `Cost: $${actual.toFixed(4)} (budget: $${config.budgetPerCall.toFixed(4)})`,
      metadata: {
        actual,
        budget: config.budgetPerCall,
      },
    };
  };
}

//#endregion
