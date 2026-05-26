import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Baseline, CaseResult, SuiteResult } from '../../src/types/eval';

//#region Constants

const SUITE_NAME = 'comparator-suite';
const BASELINE_DIR = '.noetic/baselines';

//#endregion

//#region Helper Functions

function makeScores(score: number): CaseResult['scores'] {
  return [
    {
      scorerId: 'accuracy',
      score,
    },
  ];
}

function makeCase(name: string, score: number): CaseResult {
  return {
    name,
    scores: makeScores(score),
    passed: true,
    duration: 100,
  };
}

function makeSuiteResult(cases: CaseResult[]): SuiteResult {
  return {
    suiteName: SUITE_NAME,
    objective: 'test objective',
    cases,
    aggregateScore: 0.9,
    duration: 200,
    timestamp: new Date().toISOString(),
  };
}

function makeBaseline(cases: CaseResult[]): Baseline {
  return {
    suiteResult: makeSuiteResult(cases),
    createdAt: new Date().toISOString(),
    version: '1.0.0',
  };
}

function writeBaseline(dir: string, baseline: Baseline): void {
  const baselineDir = path.join(dir, BASELINE_DIR);
  fs.mkdirSync(baselineDir, {
    recursive: true,
  });
  const sanitized = baseline.suiteResult.suiteName.replace(/[^a-zA-Z0-9-_]/g, '_');
  fs.writeFileSync(
    path.join(baselineDir, `${sanitized}.json`),
    JSON.stringify(baseline, null, 2),
    'utf-8',
  );
}

//#endregion

//#region Tests

describe('checkRegression', () => {
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noetic-comparator-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, {
      recursive: true,
      force: true,
    });
  });

  test('no baseline exists -> passes with empty regressions', async () => {
    const { checkRegression } = await import('../../src/regression/comparator');
    const current = makeSuiteResult([
      makeCase('case-1', 0.8),
    ]);
    const result = await checkRegression(current);

    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  test('score drop exactly at threshold (-0.05) -> no regression (boundary N)', async () => {
    const { checkRegression } = await import('../../src/regression/comparator');
    // Use 0.5 and 0.45 to avoid IEEE 754 rounding: 0.45 - 0.5 = -0.04999...
    // which is NOT less than -0.05, so no regression is reported
    const baseline = makeBaseline([
      makeCase('case-1', 0.5),
    ]);
    writeBaseline(tmpDir, baseline);

    const current = makeSuiteResult([
      makeCase('case-1', 0.45),
    ]);
    const result = await checkRegression(current);

    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  test('score drop just beyond threshold (-0.051) -> regression detected (boundary N+1)', async () => {
    const { checkRegression } = await import('../../src/regression/comparator');
    const baseline = makeBaseline([
      makeCase('case-1', 0.9),
    ]);
    writeBaseline(tmpDir, baseline);

    const current = makeSuiteResult([
      makeCase('case-1', 0.849),
    ]);
    const result = await checkRegression(current);

    expect(result.passed).toBe(false);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].caseName).toBe('case-1');
    expect(result.regressions[0].baselineScore).toBe(0.9);
    expect(result.regressions[0].currentScore).toBe(0.849);
    expect(result.regressions[0].delta).toBeCloseTo(-0.051, 10);
  });

  test('score drop within threshold (-0.04) -> no regression (boundary N-1)', async () => {
    const { checkRegression } = await import('../../src/regression/comparator');
    const baseline = makeBaseline([
      makeCase('case-1', 0.9),
    ]);
    writeBaseline(tmpDir, baseline);

    const current = makeSuiteResult([
      makeCase('case-1', 0.86),
    ]);
    const result = await checkRegression(current);

    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  test('new case not in baseline -> skipped (no regression)', async () => {
    const { checkRegression } = await import('../../src/regression/comparator');
    const baseline = makeBaseline([
      makeCase('case-1', 0.9),
    ]);
    writeBaseline(tmpDir, baseline);

    const current = makeSuiteResult([
      makeCase('case-1', 0.9),
      makeCase('case-new', 0.3),
    ]);
    const result = await checkRegression(current);

    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  test('multiple regressions in one suite', async () => {
    const { checkRegression } = await import('../../src/regression/comparator');
    const baseline = makeBaseline([
      makeCase('case-1', 0.9),
      makeCase('case-2', 0.8),
      makeCase('case-3', 0.7),
    ]);
    writeBaseline(tmpDir, baseline);

    const current = makeSuiteResult([
      makeCase('case-1', 0.8),
      makeCase('case-2', 0.7),
      makeCase('case-3', 0.7),
    ]);
    const result = await checkRegression(current);

    expect(result.passed).toBe(false);
    expect(result.regressions).toHaveLength(2);

    const names = result.regressions.map((r) => r.caseName);
    expect(names).toContain('case-1');
    expect(names).toContain('case-2');
  });

  test('custom threshold override (0.1)', async () => {
    const { checkRegression } = await import('../../src/regression/comparator');
    const baseline = makeBaseline([
      makeCase('case-1', 0.9),
    ]);
    writeBaseline(tmpDir, baseline);

    // Drop of 0.08 -- within default 0.05 would regress, but within custom 0.1 threshold
    const current = makeSuiteResult([
      makeCase('case-1', 0.82),
    ]);
    const result = await checkRegression(current, 0.1);

    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  test('all scores improved -> passes', async () => {
    const { checkRegression } = await import('../../src/regression/comparator');
    const baseline = makeBaseline([
      makeCase('case-1', 0.7),
      makeCase('case-2', 0.6),
    ]);
    writeBaseline(tmpDir, baseline);

    const current = makeSuiteResult([
      makeCase('case-1', 0.9),
      makeCase('case-2', 0.85),
    ]);
    const result = await checkRegression(current);

    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });
});

//#endregion
