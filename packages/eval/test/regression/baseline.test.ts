import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadBaseline, saveBaseline } from '../../src/regression/baseline';
import type { SuiteResult } from '../../src/types/eval';

const SUITE_NAME = 'test-suite';

function makeSuiteResult(name: string): SuiteResult {
  return {
    suiteName: name,
    objective: 'test objective',
    cases: [
      {
        name: 'case-1',
        scores: [
          {
            scorerId: 'accuracy',
            score: 0.9,
          },
        ],
        passed: true,
        duration: 100,
      },
    ],
    aggregateScore: 0.9,
    duration: 200,
    timestamp: new Date().toISOString(),
  };
}

describe('baseline', () => {
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noetic-baseline-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, {
      recursive: true,
      force: true,
    });
  });

  test('saveBaseline creates a file', async () => {
    const result = makeSuiteResult(SUITE_NAME);
    const filePath = await saveBaseline(result);

    expect(fs.existsSync(filePath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(content.suiteResult.suiteName).toBe(SUITE_NAME);
    expect(content.version).toBe('1.0.0');
    expect(typeof content.createdAt).toBe('string');
  });

  test('loadBaseline returns null for non-existent baseline', async () => {
    const result = await loadBaseline('non-existent-suite');
    expect(result).toBeNull();
  });

  test('save + load roundtrip preserves data', async () => {
    const suiteResult = makeSuiteResult(SUITE_NAME);
    await saveBaseline(suiteResult);
    const loaded = await loadBaseline(SUITE_NAME);

    assert(loaded, 'Expected baseline to be loaded');
    expect(loaded.suiteResult.suiteName).toBe(SUITE_NAME);
    expect(loaded.suiteResult.objective).toBe('test objective');
    expect(loaded.suiteResult.cases).toHaveLength(1);
    expect(loaded.suiteResult.cases[0].scores[0].score).toBe(0.9);
    expect(loaded.version).toBe('1.0.0');
  });
});
