import type { RegressionConfig } from './regression';

//#region ESM Literal Enums

const OptimizeScope = {
  PromptsOnly: 'prompts-only',
  FlowStructure: 'flow-structure',
  Full: 'full',
} as const;

type OptimizeScope = (typeof OptimizeScope)[keyof typeof OptimizeScope];

//#endregion

//#region Types

export interface EvalSuiteOptions {
  objective: string;
  background?: string;
  passThreshold?: number;
  optimize?: OptimizeConfig;
  regression?: RegressionConfig;
}

export interface OptimizeConfig {
  scope: OptimizeScope;
  maxMetricCalls?: number;
  budget?: number;
  codingAgent?: import('./optimizer').CodingAgent;
  dryRun?: boolean;
}

export interface CaseResult {
  name: string;
  scores: ScoreResult[];
  passed: boolean;
  duration: number;
  error?: string;
}

export interface SuiteResult {
  suiteName: string;
  objective: string;
  cases: CaseResult[];
  aggregateScore: number;
  duration: number;
  timestamp: string;
}

export interface ScoreResult {
  scorerId: string;
  score: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface Baseline {
  suiteResult: SuiteResult;
  createdAt: string;
  version: string;
}

//#endregion

export { OptimizeScope };
