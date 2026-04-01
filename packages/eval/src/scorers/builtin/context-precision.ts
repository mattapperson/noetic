import { z } from 'zod';

import type { ScoreResult } from '../../types/eval';
import type { EvalExecution, ScorerFn } from '../../types/scorer';
import type { JudgeConfig } from './llm-judge';
import { runJudge } from './llm-judge';

//#region Schemas

const JudgmentSchema = z.object({
  precision: z.number().min(0).max(1),
  reasoning: z.string(),
});

//#endregion

//#region Public API

export function contextPrecision(config?: JudgeConfig): ScorerFn {
  return async (execution: EvalExecution, objective: string): Promise<ScoreResult> => {
    const result = await runJudge({
      id: 'context-precision-judge',
      instructions: `You are an evaluation judge. Assess the precision of context usage in the output.
Precision measures how much of the context used was actually relevant to answering the objective.
Score 0.0 = context was used imprecisely (irrelevant info included), 1.0 = only relevant context was used.
Respond with a precision score and brief reasoning.`,
      input: `Objective: ${objective}\n\nOutput: ${String(execution.output)}`,
      outputSchema: JudgmentSchema,
      judge: config,
    });

    return {
      scorerId: 'context-precision',
      score: result.precision,
      reason: result.reasoning,
    };
  };
}

//#endregion
