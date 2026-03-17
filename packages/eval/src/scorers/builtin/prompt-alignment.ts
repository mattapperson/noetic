import { z } from 'zod';

import type { ScoreResult } from '../../types/eval';
import type { EvalExecution, ScorerFn } from '../../types/scorer';
import type { JudgeConfig } from './llm-judge';
import { runJudge } from './llm-judge';

//#region Schemas

const JudgmentSchema = z.object({
  alignment: z.number().min(0).max(1),
  reasoning: z.string(),
});

//#endregion

//#region Public API

export function promptAlignment(config?: JudgeConfig): ScorerFn {
  return async (execution: EvalExecution, objective: string): Promise<ScoreResult> => {
    const result = await runJudge({
      id: 'prompt-alignment-judge',
      system: `You are an evaluation judge. Assess whether the output follows the system prompt's instructions and constraints.
Score 0.0 = completely ignores instructions, 1.0 = perfectly follows all instructions.
Check for adherence to format, tone, constraints, and any specific requirements in the objective.
Respond with an alignment score and brief reasoning.`,
      input: `Instructions/Objective: ${objective}\n\nOutput: ${String(execution.output)}`,
      outputSchema: JudgmentSchema,
      judge: config,
    });

    return {
      scorerId: 'prompt-alignment',
      score: result.alignment,
      reason: result.reasoning,
    };
  };
}

//#endregion
