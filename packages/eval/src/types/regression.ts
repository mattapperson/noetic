export interface RegressionConfig {
  baseline?: string;
  maxRegression?: number;
  createBaselineIfMissing?: boolean;
}

export interface RegressionResult {
  passed: boolean;
  regressions: Array<{
    caseName: string;
    baselineScore: number;
    currentScore: number;
    delta: number;
  }>;
}
