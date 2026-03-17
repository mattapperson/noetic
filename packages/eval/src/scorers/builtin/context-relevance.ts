import { z } from 'zod';

import type { ScoreResult } from '../../types/eval';
import type { EvalExecution, ScorerFn } from '../../types/scorer';
import type { JudgeConfig } from './llm-judge';
import { runJudge } from './llm-judge';

//#region Schemas

const JudgmentSchema = z.object({
  relevance: z.number().min(0).max(1),
  reasoning: z.string(),
});

//#endregion

//#region Public API

export function contextRelevance(config?: JudgeConfig): ScorerFn {
  return async (execution: EvalExecution, objective: string): Promise<ScoreResult> => {
    const result = await runJudge({
      id: 'context-relevance-judge',
      system: `You are an evaluation judge. Assess how relevant the retrieved context is to the objective.
Score 0.0 = context is completely irrelevant to the objective, 1.0 = context is highly relevant.
Consider whether the context provides useful information for addressing the objective.
Respond with a relevance score and brief reasoning.`,
      input: `Objective: ${objective}\n\nOutput: ${String(execution.output)}`,
      outputSchema: JudgmentSchema,
      judge: config,
    });

    return {
      scorerId: 'context-relevance',
      score: result.relevance,
      reason: result.reasoning,
    };
  };
}

//#endregion
