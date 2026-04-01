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

export function answerRelevancy(config?: JudgeConfig): ScorerFn {
  return async (execution: EvalExecution, objective: string): Promise<ScoreResult> => {
    const result = await runJudge({
      id: 'answer-relevancy-judge',
      instructions: `You are an evaluation judge. Rate how relevant the given output is to the stated objective.
Score 0.0 = completely irrelevant, 1.0 = perfectly relevant.
Respond with a relevance score and brief reasoning.`,
      input: `Objective: ${objective}\n\nOutput: ${String(execution.output)}`,
      outputSchema: JudgmentSchema,
      judge: config,
    });

    return {
      scorerId: 'answer-relevancy',
      score: result.relevance,
      reason: result.reasoning,
    };
  };
}

//#endregion
