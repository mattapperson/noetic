import type { CaseResult, ScoreResult, SuiteResult } from '../types/eval';
import { averageScores, maxScore, medianScore, minScore, stddevScore } from '../utils/scores';

//#region Types

interface ReporterOptions {
  verbose?: boolean;
  json?: boolean;
}

//#endregion

//#region Helper Functions

function formatCaseScore(caseResult: CaseResult): string {
  if (caseResult.scores.length === 0) {
    return 'N/A';
  }
  return averageScores(caseResult.scores).toFixed(2);
}

function printAggregates(cases: CaseResult[]): void {
  const allScores = cases.flatMap((c) => c.scores);
  if (allScores.length === 0) {
    return;
  }

  const byScorer = new Map<string, ScoreResult[]>();
  for (const s of allScores) {
    const existing = byScorer.get(s.scorerId) ?? [];
    existing.push(s);
    byScorer.set(s.scorerId, existing);
  }

  console.log('  Aggregates:');
  for (const [id, scores] of byScorer) {
    const mean = averageScores(scores).toFixed(2);
    const med = medianScore(scores).toFixed(2);
    const mn = minScore(scores).toFixed(2);
    const mx = maxScore(scores).toFixed(2);
    const sd = stddevScore(scores).toFixed(2);
    console.log(`    ${id}: mean=${mean} median=${med} min=${mn} max=${mx} stddev=${sd}`);
  }
}

//#endregion

//#region Public API

export function reportResults(results: SuiteResult[], options?: ReporterOptions): void {
  if (options?.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  for (const suite of results) {
    console.log('');
    console.log(`EVAL  ${suite.suiteName}`);
    for (const c of suite.cases) {
      const icon = c.passed ? '\u2713' : '\u2717';
      const avgScore = formatCaseScore(c);
      console.log(`  ${icon} ${c.name.padEnd(40)} ${avgScore}`);

      if (options?.verbose && c.scores.length > 0) {
        for (const score of c.scores) {
          const reason = score.reason ? ` \u2014 ${score.reason}` : '';
          console.log(`      ${score.scorerId}: ${score.score.toFixed(2)}${reason}`);
        }
      }

      if (c.error) {
        console.log(`      Error: ${c.error}`);
      }
    }

    if (options?.verbose) {
      printAggregates(suite.cases);
    }

    console.log(`  Suite score: ${suite.aggregateScore.toFixed(2)}`);
    console.log('');
  }
}

export function reportSummary(results: SuiteResult[]): void {
  const totalCases = results.reduce((sum, s) => sum + s.cases.length, 0);
  const passed = results.reduce((sum, s) => sum + s.cases.filter((c) => c.passed).length, 0);
  const failed = totalCases - passed;
  const avgScore =
    results.length > 0
      ? (results.reduce((sum, s) => sum + s.aggregateScore, 0) / results.length).toFixed(2)
      : '0.00';

  console.log(`${passed} passed, ${failed} failed, ${totalCases} total`);
  console.log(`Average score: ${avgScore}`);
}

//#endregion
