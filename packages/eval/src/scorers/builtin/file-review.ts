import * as fs from 'node:fs/promises';

import { z } from 'zod';

import type { ScoreResult } from '../../types/eval';
import type { EvalExecution, ScorerFn } from '../../types/scorer';
import type { JudgeConfig } from './llm-judge';
import { runJudge } from './llm-judge';

//#region Types

interface FileReviewConfig extends JudgeConfig {
  path: string;
  instructions: string;
}

//#endregion

//#region Schemas

const JudgmentSchema = z.object({
  compliance: z.number().min(0).max(1),
  reasoning: z.string(),
});

//#endregion

//#region Public API

export function fileReview(config: FileReviewConfig): ScorerFn {
  return async (_execution: EvalExecution, objective: string): Promise<ScoreResult> => {
    const contents = await fs.readFile(config.path, 'utf-8');

    const result = await runJudge({
      id: 'file-review-judge',
      instructions: `You are a code/file review judge. Review the file contents against the given instructions.
Score 0.0 = completely fails instructions, 1.0 = perfectly follows all instructions.
Respond with a compliance score and brief reasoning.`,
      input: `Objective: ${objective}\n\nInstructions: ${config.instructions}\n\nFile Path: ${config.path}\n\nFile Contents:\n${contents}`,
      outputSchema: JudgmentSchema,
      judge: config,
    });

    return {
      scorerId: 'file-review',
      score: result.compliance,
      reason: result.reasoning,
      metadata: {
        path: config.path,
      },
    };
  };
}

//#endregion
