import type { SuiteResult } from '../types/eval';
import type { RegressionResult } from '../types/regression';
import { averageScores } from '../utils/scores';
import { loadBaseline } from './baseline';

//#region Constants

const DEFAULT_MAX_REGRESSION = 0.05;

//#endregion

//#region Types

export interface RegressionEntry {
  caseName: string;
  baselineScore: number;
  currentScore: number;
  delta: number;
}

//#endregion

//#region Public API

export async function checkRegression(
  currentResult: SuiteResult,
  maxRegression?: number,
): Promise<RegressionResult> {
  const threshold = maxRegression ?? DEFAULT_MAX_REGRESSION;
  const baseline = await loadBaseline(currentResult.suiteName);

  if (!baseline) {
    return {
      passed: true,
      regressions: [],
    };
  }

  const regressions: RegressionEntry[] = [];

  for (const currentCase of currentResult.cases) {
    const baselineCase = baseline.suiteResult.cases.find((c) => c.name === currentCase.name);
    if (!baselineCase) {
      continue;
    }

    const currentAvg = averageScores(currentCase.scores);
    const baselineAvg = averageScores(baselineCase.scores);
    const delta = currentAvg - baselineAvg;

    if (delta < -threshold) {
      regressions.push({
        caseName: currentCase.name,
        baselineScore: baselineAvg,
        currentScore: currentAvg,
        delta,
      });
    }
  }

  return {
    passed: regressions.length === 0,
    regressions,
  };
}

//#endregion
