import { z } from 'zod';

import type { ScoreResult } from '../../types/eval';
import type { EvalExecution, ScorerFn } from '../../types/scorer';
import type { JudgeConfig } from './llm-judge';
import { runJudge } from './llm-judge';

//#region Types

interface FaithfulnessConfig extends JudgeConfig {
  context: string;
}

//#endregion

//#region Schemas

const JudgmentSchema = z.object({
  faithfulness: z.number().min(0).max(1),
  reasoning: z.string(),
});

//#endregion

//#region Public API

export function faithfulness(config: FaithfulnessConfig): ScorerFn {
  return async (execution: EvalExecution, objective: string): Promise<ScoreResult> => {
    const result = await runJudge({
      id: 'faithfulness-judge',
      instructions: `You are an evaluation judge. Evaluate whether the output is faithful to the provided context.
A faithful output only contains information supported by the context, without adding unsupported claims.
Score 0.0 = completely unfaithful (fabricated), 1.0 = perfectly faithful to context.
Respond with a faithfulness score and brief reasoning.`,
      input: `Objective: ${objective}\n\nContext: ${config.context}\n\nOutput: ${String(execution.output)}`,
      outputSchema: JudgmentSchema,
      judge: config,
    });

    return {
      scorerId: 'faithfulness',
      score: result.faithfulness,
      reason: result.reasoning,
    };
  };
}

//#endregion
