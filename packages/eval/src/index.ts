// Types — adapter

// Adapters
export {
  clearRegisteredFields,
  createAdapter,
  getRegisteredFields,
} from './adapters/adapter-factory';
// Optimization
export { discoverFields } from './optimization/field-discovery';
export { applyCandidate } from './optimization/mutator';
export type { OptimizeOptions, OptimizeResult } from './optimization/optimizer';
export { optimize } from './optimization/optimizer';
// Regression
export { loadBaseline, saveBaseline } from './regression/baseline';
export { checkRegression } from './regression/comparator';
export type { CaseDefinition, SuiteDefinition } from './runner/describe';
// Runner
export { describe } from './runner/describe';
export type { EvalContext } from './runner/eval-context';
export { createEvalContext } from './runner/eval-context';
export { it } from './runner/it';
export { clearSuites, getSuites } from './runner/registry';
export { runAllSuites, runSuite } from './runner/suite-runner';
// Scorers
export { scorer } from './scorers/index';
export { createScorer } from './scorers/scorer-pipeline';
export type { EvalExecution, ScorerFn } from './scorers/types';
export type { AdapterConfig, FieldMapping } from './types/adapter';
// Types — eval
export type {
  CaseResult,
  EvalObjective,
  EvalSuiteConfig,
  OptimizeConfig,
  ScoreResult,
  SuiteResult,
} from './types/eval';
export { OptimizeScope } from './types/eval';
// Types — optimizer
export type {
  ApplyResult,
  Candidate,
  CodingAgent,
  OptimizableField,
  OptimizationRecommendation,
  OptimizationResult,
} from './types/optimizer';
export { FieldKind } from './types/optimizer';
// Types — regression
export type { Baseline, RegressionConfig, RegressionResult } from './types/regression';
// Types — scorer
export type {
  AnalyzeConfig,
  GenerateReasonConfig,
  GenerateScoreFn,
  PreprocessFn,
  ScorerPipelineConfig,
  ScorerResult,
} from './types/scorer';
// Types — source-location
export type { SourceLocation } from './types/source-location';
