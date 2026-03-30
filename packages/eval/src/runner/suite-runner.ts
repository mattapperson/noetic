import type { CaseResult, SuiteResult } from '../types/eval';
import type { SuiteDefinition } from './describe';
import { createEvalContext } from './eval-context';

//#region Helper Functions

async function runCase(
  caseDef: SuiteDefinition['cases'][number],
  suite: SuiteDefinition,
): Promise<CaseResult> {
  const caseStart = performance.now();
  const ctx = createEvalContext(suite.step, suite.options);

  try {
    await caseDef.fn(ctx);
    const scores = [
      ...ctx.accumulatedScores,
    ];
    const passThreshold = suite.options.passThreshold ?? 0.5;
    const passed = scores.length === 0 || scores.every((s) => s.score >= passThreshold);
    return {
      name: caseDef.name,
      scores,
      passed,
      duration: performance.now() - caseStart,
    };
  } catch (error) {
    return {
      name: caseDef.name,
      scores: [],
      passed: false,
      duration: performance.now() - caseStart,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function computeAggregateScore(cases: CaseResult[]): number {
  const scores = cases.flatMap((c) => c.scores);
  if (scores.length === 0) {
    return 0;
  }
  return scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
}

//#endregion

//#region Public API

export async function runSuite(suite: SuiteDefinition): Promise<SuiteResult> {
  const suiteStart = performance.now();
  const cases: CaseResult[] = [];

  for (const caseDef of suite.cases) {
    cases.push(await runCase(caseDef, suite));
  }

  return {
    suiteName: suite.options.objective,
    objective: suite.options.objective,
    cases,
    aggregateScore: computeAggregateScore(cases),
    duration: performance.now() - suiteStart,
    timestamp: new Date().toISOString(),
  };
}

export async function runAllSuites(suites: ReadonlyArray<SuiteDefinition>): Promise<SuiteResult[]> {
  const results: SuiteResult[] = [];
  for (const suite of suites) {
    results.push(await runSuite(suite));
  }
  return results;
}

//#endregion
