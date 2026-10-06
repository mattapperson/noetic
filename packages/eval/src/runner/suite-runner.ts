import type { CaseResult, SuiteResult } from '../types/eval';
import { runPool } from '../utils/run-pool';
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

/** Options controlling suite execution. */
export interface RunSuiteOptions {
  /**
   * Max cases running concurrently within a suite. Every case executes a real
   * agent plus scorers, so wall-clock scales ~linearly with this. Results are
   * ordered by definition regardless of completion order. Default 4; pass 1
   * for strictly sequential runs (e.g. cases sharing external state).
   */
  concurrency?: number;
}

const DEFAULT_CASE_CONCURRENCY = 4;

export async function runSuite(
  suite: SuiteDefinition,
  options?: RunSuiteOptions,
): Promise<SuiteResult> {
  const suiteStart = performance.now();
  const concurrency = options?.concurrency ?? DEFAULT_CASE_CONCURRENCY;

  // Cases run concurrently (each has its own harness/context — see
  // createEvalContext); `runCase` already converts throws into CaseResult
  // errors, so a failed case never rejects the pool.
  const cases = await runPool(
    suite.cases.map((caseDef) => () => runCase(caseDef, suite)),
    concurrency,
  );

  return {
    suiteName: suite.options.objective,
    objective: suite.options.objective,
    cases,
    aggregateScore: computeAggregateScore(cases),
    duration: performance.now() - suiteStart,
    timestamp: new Date().toISOString(),
  };
}

export async function runAllSuites(
  suites: ReadonlyArray<SuiteDefinition>,
  options?: RunSuiteOptions,
): Promise<SuiteResult[]> {
  // Suites stay sequential: aggregate scores feed baseline comparisons, and
  // cross-suite interleaving would make timing-sensitive suites flaky.
  const results: SuiteResult[] = [];
  for (const suite of suites) {
    results.push(await runSuite(suite, options));
  }
  return results;
}

//#endregion
