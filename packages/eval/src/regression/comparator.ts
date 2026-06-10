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

/**
 * Compare a suite result against its saved baseline.
 *
 * Two directions are checked:
 * - forward: a present case whose average score dropped more than the
 *   threshold is a regression
 * - reverse: a baseline case absent from the current run (deleted, renamed,
 *   or never registered) is reported in `missingCases` — a vanished case is
 *   the maximal degradation and must not pass silently
 *
 * `passed` is true only when there are no regressions AND no missing cases.
 * Without a saved baseline the check is skipped (`baselineFound: false`,
 * `passed: true`).
 */
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
      missingCases: [],
      baselineFound: false,
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

  const currentNames = new Set(currentResult.cases.map((c) => c.name));
  const missingCases = baseline.suiteResult.cases
    .map((c) => c.name)
    .filter((name) => !currentNames.has(name));

  return {
    passed: regressions.length === 0 && missingCases.length === 0,
    regressions,
    missingCases,
    baselineFound: true,
  };
}

//#endregion
