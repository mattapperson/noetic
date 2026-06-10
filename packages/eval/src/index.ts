// Adapters
export {
  clearRegisteredFields,
  createAdapter,
  getRegisteredFields,
} from './adapters/adapter-factory';
// Optimization
export { discoverFields, enrichWithSourceLocations } from './optimization/field-discovery';
export { applyCandidate } from './optimization/mutator';
export type { OptimizeOptions, OptimizeResult } from './optimization/optimizer';
export { optimize } from './optimization/optimizer';
export type {
  SkippedWrite,
  WriteBackEntry,
  WriteBackReport,
} from './optimization/source-writer';
// Regression
export { loadBaseline, saveBaseline } from './regression/baseline';
export { checkRegression } from './regression/comparator';
export type { CaseDefinition, DescribeStep, SuiteDefinition } from './runner/describe';
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
// Static analysis
export { discoverFieldsFromSource } from './static-analysis/ast-field-discovery';
export type { AdapterConfig, FieldMapping } from './types/adapter';
// Types — eval
// Types — regression
export type {
  Baseline,
  CaseResult,
  EvalSuiteOptions,
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
export type { RegressionConfig, RegressionResult } from './types/regression';
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
