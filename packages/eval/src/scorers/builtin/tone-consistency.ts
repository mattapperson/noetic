import { z } from 'zod';

import type { ScoreResult } from '../../types/eval';
import type { EvalExecution, ScorerFn } from '../../types/scorer';
import type { JudgeConfig } from './llm-judge';
import { runJudge } from './llm-judge';

//#region Types

interface ToneConsistencyConfig extends JudgeConfig {
  target: string;
}

//#endregion

//#region Schemas

const JudgmentSchema = z.object({
  consistency: z.number().min(0).max(1),
  reasoning: z.string(),
});

//#endregion

//#region Public API

export function toneConsistency(config: ToneConsistencyConfig): ScorerFn {
  return async (execution: EvalExecution, objective: string): Promise<ScoreResult> => {
    const result = await runJudge({
      id: 'tone-consistency-judge',
      instructions: `You are an evaluation judge. Assess whether the output maintains the target tone throughout.
Target tone: "${config.target}"
Score 0.0 = completely wrong tone, 1.0 = perfectly consistent with target tone.
Respond with a consistency score and brief reasoning.`,
      input: `Objective: ${objective}\n\nTarget Tone: ${config.target}\n\nOutput: ${String(execution.output)}`,
      outputSchema: JudgmentSchema,
      judge: config,
    });

    return {
      scorerId: 'tone-consistency',
      score: result.consistency,
      reason: result.reasoning,
      metadata: {
        target: config.target,
      },
    };
  };
}

//#endregion
