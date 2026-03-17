import type { EvalExecution, ScorerFn } from '../types';

//#region Types

interface CustomConfig {
  generateScore: (execution: EvalExecution) => number | Promise<number>;
  generateReason?: (execution: EvalExecution, score: number) => string | Promise<string>;
}

//#endregion

//#region Public API

export function custom(id: string, config: CustomConfig): ScorerFn {
  return async (execution) => {
    const score = await config.generateScore(execution);
    const reason = config.generateReason
      ? await config.generateReason(execution, score)
      : undefined;

    return {
      scorerId: id,
      score,
      reason,
    };
  };
}

//#endregion
