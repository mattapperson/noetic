import type { Context, SpanImpl } from '@noetic/core';
import type { ZodType } from 'zod';

import type { ScoreResult } from './eval';

//#region Types

export interface EvalExecution {
  output: unknown;
  context: Context;
  traces: SpanImpl[];
  score(scorers: ScorerFn[]): Promise<ScoreResult[]>;
}

export type ScorerFn = (
  execution: EvalExecution,
  objective: string,
  background: string,
) => Promise<ScoreResult>;

export type ScorerResult = ScoreResult;

export interface ScorerPipelineConfig {
  id: string;
  judge?: {
    model: string;
  };
}

export type PreprocessFn<T> = (params: { execution: EvalExecution }) => T | Promise<T>;

export interface AnalyzeConfig<T, R> {
  outputSchema: ZodType<R>;
  createPrompt: (data: T, objective: string) => string;
}

export type GenerateScoreFn<R> = (params: { results: R }) => number;

export interface GenerateReasonConfig<R> {
  createPrompt: (results: R, score: number) => string;
}

//#endregion
