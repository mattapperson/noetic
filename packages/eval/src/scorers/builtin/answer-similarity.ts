import { z } from 'zod';

import type { ScoreResult } from '../../types/eval';
import type { EvalExecution, ScorerFn } from '../../types/scorer';
import { applyThreshold } from './apply-threshold';
import type { JudgeConfig } from './llm-judge';
import { runJudge } from './llm-judge';

//#region Types

interface AnswerSimilarityConfig extends JudgeConfig {
  expected: string;
  threshold?: number;
}

//#endregion

//#region Schemas

const JudgmentSchema = z.object({
  similarity: z.number().min(0).max(1),
  reasoning: z.string(),
});

//#endregion

//#region Public API

export function answerSimilarity(config: AnswerSimilarityConfig): ScorerFn {
  return async (execution: EvalExecution, objective: string): Promise<ScoreResult> => {
    const result = await runJudge({
      id: 'answer-similarity-judge',
      instructions: `You are an evaluation judge. Compare the given output to the expected answer.
Rate their semantic similarity from 0.0 (completely different) to 1.0 (identical meaning).
Consider meaning and intent, not just exact wording.
Respond with a similarity score and brief reasoning.`,
      input: `Objective: ${objective}\n\nExpected: ${config.expected}\n\nActual Output: ${String(execution.output)}`,
      outputSchema: JudgmentSchema,
      judge: config,
    });

    // threshold gates pass/fail: similarity >= threshold -> 1, below -> 0.
    return {
      scorerId: 'answer-similarity',
      score: applyThreshold(result.similarity, config.threshold),
      reason: result.reasoning,
      metadata: {
        threshold: config.threshold,
        rawScore: result.similarity,
      },
    };
  };
}

//#endregion
