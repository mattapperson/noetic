import type { LlmProviderConfig } from '@noetic/core';
import { AgentHarness, step } from '@noetic/core';
import type { ZodType } from 'zod';

import type { EvalExecution, ScoreResult, ScorerFn } from './types';

//#region Types

interface ScorerPipelineConfig {
  id: string;
  judge?: {
    model: string;
    llm?: LlmProviderConfig;
  };
}

interface JudgeConfig {
  model: string;
  llm?: LlmProviderConfig;
}

interface PipelineStep1 {
  preprocess<T>(fn: (params: { execution: EvalExecution }) => T | Promise<T>): PipelineStep2<T>;
}

interface PipelineStep2<T> {
  analyze<R>(config: {
    outputSchema: ZodType<R>;
    createPrompt: (data: T, objective: string) => string;
  }): PipelineStep3<R>;
  generateScore(fn: (params: { results: T }) => number): PipelineStep4;
}

interface PipelineStep3<R> {
  generateScore(fn: (params: { results: R }) => number): PipelineStep4;
}

interface PipelineStep4 {
  (execution: EvalExecution, objective: string, background: string): Promise<ScoreResult>;
  generateReason(config: { createPrompt: (score: number) => string }): ScorerFn;
}

//#endregion

//#region Helper Functions

function clampScore(raw: number): {
  score: number;
  clamped: boolean;
} {
  if (raw < 0 || raw > 1) {
    return {
      score: Math.max(0, Math.min(1, raw)),
      clamped: true,
    };
  }
  return {
    score: raw,
    clamped: false,
  };
}

function parseAnalyzedResult<R>(raw: unknown, schema: ZodType<R>): R {
  return schema.parse(raw);
}

function buildAnalyzeScorerFn<T, R>(
  pipelineId: string,
  judge: JudgeConfig | undefined,
  preprocessFn: (params: { execution: EvalExecution }) => T | Promise<T>,
  analyzeConfig: {
    outputSchema: ZodType<R>;
    createPrompt: (data: T, objective: string) => string;
  },
  scoreFn: (params: { results: R }) => number,
): ScorerFn {
  return async (execution, objective, background): Promise<ScoreResult> => {
    const preprocessed = await preprocessFn({
      execution,
    });
    const prompt = analyzeConfig.createPrompt(preprocessed, objective);

    const model = judge?.model ?? 'openai/gpt-4o-mini';
    const judgeStep = step.llm({
      id: `${pipelineId}-judge`,
      model,
      instructions: prompt,
    });

    const harness = new AgentHarness({
      name: 'scorer-analyze',
      params: {},
      llm: judge?.llm,
    });
    const ctx = harness.createContext();
    const raw = await harness.run(judgeStep, background, ctx);
    const analyzed = parseAnalyzedResult(raw, analyzeConfig.outputSchema);

    const rawScore = scoreFn({
      results: analyzed,
    });
    const { score, clamped } = clampScore(rawScore);

    if (clamped) {
      return {
        scorerId: pipelineId,
        score,
        metadata: {
          originalScore: rawScore,
          clamped: true,
        },
      };
    }
    return {
      scorerId: pipelineId,
      score,
    };
  };
}

function buildDirectScorerFn<T>(
  pipelineId: string,
  preprocessFn: (params: { execution: EvalExecution }) => T | Promise<T>,
  scoreFn: (params: { results: T }) => number,
): ScorerFn {
  return async (execution): Promise<ScoreResult> => {
    const preprocessed = await preprocessFn({
      execution,
    });
    const rawScore = scoreFn({
      results: preprocessed,
    });
    const { score, clamped } = clampScore(rawScore);

    if (clamped) {
      return {
        scorerId: pipelineId,
        score,
        metadata: {
          originalScore: rawScore,
          clamped: true,
        },
      };
    }
    return {
      scorerId: pipelineId,
      score,
    };
  };
}

function makePipelineStep4(
  baseFn: ScorerFn,
  pipelineId: string,
  judge?: JudgeConfig,
): PipelineStep4 {
  return Object.assign(
    (execution: EvalExecution, objective: string, background: string): Promise<ScoreResult> =>
      baseFn(execution, objective, background),
    {
      generateReason(reasonConfig: { createPrompt: (score: number) => string }): ScorerFn {
        return async (execution, objective, background): Promise<ScoreResult> => {
          const result = await baseFn(execution, objective, background);

          if (!judge) {
            return {
              ...result,
              reason: reasonConfig.createPrompt(result.score),
            };
          }

          const model = judge.model ?? 'openai/gpt-4o-mini';
          const reasonStep = step.llm({
            id: `${pipelineId}-reason`,
            model,
            instructions: reasonConfig.createPrompt(result.score),
          });

          const harness = new AgentHarness({
            name: 'scorer-reason',
            params: {},
            llm: judge.llm,
          });
          const ctx = harness.createContext();
          const reason = await harness.run(reasonStep, '', ctx);
          return {
            ...result,
            reason: String(reason),
          };
        };
      },
    },
  ) satisfies PipelineStep4;
}

//#endregion

//#region Public API

export function createScorer(config: ScorerPipelineConfig): PipelineStep1 {
  return {
    preprocess<T>(
      preprocessFn: (params: { execution: EvalExecution }) => T | Promise<T>,
    ): PipelineStep2<T> {
      return {
        analyze<R>(analyzeConfig: {
          outputSchema: ZodType<R>;
          createPrompt: (data: T, objective: string) => string;
        }): PipelineStep3<R> {
          return {
            generateScore(scoreFn: (params: { results: R }) => number): PipelineStep4 {
              const run = buildAnalyzeScorerFn(
                config.id,
                config.judge,
                preprocessFn,
                analyzeConfig,
                scoreFn,
              );
              return makePipelineStep4(run, config.id, config.judge);
            },
          };
        },
        generateScore(scoreFn: (params: { results: T }) => number): PipelineStep4 {
          const run = buildDirectScorerFn(config.id, preprocessFn, scoreFn);
          return makePipelineStep4(run, config.id);
        },
      };
    },
  };
}

//#endregion
