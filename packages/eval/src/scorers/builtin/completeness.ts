import { z } from 'zod';

import type { ScoreResult } from '../../types/eval';
import type { EvalExecution, ScorerFn } from '../../types/scorer';
import type { JudgeConfig } from './llm-judge';
import { runJudge } from './llm-judge';

//#region Schemas

const JudgmentSchema = z.object({
  completeness: z.number().min(0).max(1),
  reasoning: z.string(),
});

//#endregion

//#region Public API

export function completeness(config?: JudgeConfig): ScorerFn {
  return async (execution: EvalExecution, objective: string): Promise<ScoreResult> => {
    const result = await runJudge({
      id: 'completeness-judge',
      system: `You are an evaluation judge. Assess whether the output fully addresses all aspects of the objective.
Score 0.0 = completely incomplete (misses everything), 1.0 = fully complete (addresses all aspects).
Consider whether all parts of the objective are covered and whether the response is thorough.
Respond with a completeness score and brief reasoning.`,
      input: `Objective: ${objective}\n\nOutput: ${String(execution.output)}`,
      outputSchema: JudgmentSchema,
      judge: config,
    });

    return {
      scorerId: 'completeness',
      score: result.completeness,
      reason: result.reasoning,
    };
  };
}

//#endregion
