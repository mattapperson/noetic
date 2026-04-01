import { z } from 'zod';

import type { ScoreResult } from '../../types/eval';
import type { EvalExecution, ScorerFn } from '../../types/scorer';
import type { JudgeConfig } from './llm-judge';
import { runJudge } from './llm-judge';

//#region Types

interface HallucinationConfig extends JudgeConfig {
  context?: string;
}

//#endregion

//#region Schemas

const JudgmentSchema = z.object({
  hallucinationScore: z.number().min(0).max(1),
  reasoning: z.string(),
});

//#endregion

//#region Public API

export function hallucination(config?: HallucinationConfig): ScorerFn {
  return async (execution: EvalExecution, objective: string): Promise<ScoreResult> => {
    const contextLine = config?.context ? `\n\nReference Context: ${config.context}` : '';

    const result = await runJudge({
      id: 'hallucination-judge',
      instructions: `You are an evaluation judge. Detect hallucinated content in the output.
Hallucination means the output contains fabricated facts, unsupported claims, or invented details.
Rate the hallucination level: 0.0 = fully hallucinated, 1.0 = no hallucination detected.
If reference context is provided, check claims against it. Otherwise, assess general factual plausibility.
Respond with a hallucinationScore and brief reasoning.`,
      input: `Objective: ${objective}${contextLine}\n\nOutput: ${String(execution.output)}`,
      outputSchema: JudgmentSchema,
      judge: config,
    });

    return {
      scorerId: 'hallucination',
      score: result.hallucinationScore,
      reason: result.reasoning,
    };
  };
}

//#endregion
