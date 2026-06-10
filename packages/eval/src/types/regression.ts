export interface RegressionConfig {
  baseline?: string;
  maxRegression?: number;
  createBaselineIfMissing?: boolean;
}

export interface RegressionResult {
  /** False when any case regressed OR any baseline case is missing from the run. */
  passed: boolean;
  regressions: Array<{
    caseName: string;
    baselineScore: number;
    currentScore: number;
    delta: number;
  }>;
  /** Baseline case names absent from the current run (deleted, renamed, or never registered). */
  missingCases: string[];
  /** False when no baseline exists for the suite (the check is skipped, not failed). */
  baselineFound: boolean;
}
