import { describe, expect, test } from 'bun:test';
import { step } from '@noetic-tools/core';

import { createEvalContext } from '../../src/runner/eval-context';

describe('createEvalContext()', () => {
  test('creates context with objective and background', () => {
    const testStep = step.run({
      id: 'echo',
      execute: async (input: unknown) => input,
    });

    const ctx = createEvalContext(testStep, {
      objective: 'test objective',
      background: 'test background',
    });

    expect(ctx.objective).toBe('test objective');
    expect(ctx.background).toBe('test background');
    expect(typeof ctx.execute).toBe('function');
  });

  test('execute() returns EvalExecution with output and context', async () => {
    const testStep = step.run({
      id: 'doubler',
      execute: async (input: unknown) => Number(input) * 2,
    });

    const ctx = createEvalContext(testStep, {
      objective: 'doubling objective',
    });

    const result = await ctx.execute(5);

    expect(result.output).toBe(10);
    expect(result.context).toBeDefined();
    expect(result.context.id).toBeDefined();
    expect(Array.isArray(result.traces)).toBe(true);
    expect(typeof result.score).toBe('function');
  });

  test('execute() with string input returns correct output', async () => {
    const testStep = step.run({
      id: 'greeter',
      execute: async (input: unknown) => `hello ${input}`,
    });

    const ctx = createEvalContext(testStep, {
      objective: 'greeting objective',
      background: 'greeting background',
    });

    const result = await ctx.execute('world');
    expect(result.output).toBe('hello world');
  });

  test('score() invokes scorer functions', async () => {
    const testStep = step.run({
      id: 'echo',
      execute: async (input: unknown) => input,
    });

    const ctx = createEvalContext(testStep, {
      objective: 'score test',
      background: 'background',
    });

    const result = await ctx.execute('test');

    const scores = await result.score([
      async (execution, objective) => ({
        scorerId: 'test-scorer',
        score: execution.output === 'test' ? 1 : 0,
        reason: `objective: ${objective}`,
      }),
    ]);

    expect(scores).toHaveLength(1);
    expect(scores[0].scorerId).toBe('test-scorer');
    expect(scores[0].score).toBe(1);
    expect(scores[0].reason).toBe('objective: score test');
  });

  test('score() sanitizes out-of-range scores from scorers bypassing the pipeline', async () => {
    const testStep = step.run({
      id: 'echo',
      execute: async (input: unknown) => input,
    });
    const ctx = createEvalContext(testStep, {
      objective: 'sanitize test',
    });
    const result = await ctx.execute('x');

    const scores = await result.score([
      async () => ({
        scorerId: 'too-high',
        score: 3.0,
      }),
    ]);

    expect(scores[0].score).toBe(1);
    expect(scores[0].metadata?.sanitizedFrom).toBe(3.0);
    expect(ctx.accumulatedScores[0].score).toBe(1);
  });

  test('score() sanitizes NaN to 0 and the result round-trips through a baseline', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const originalCwd = process.cwd();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-context-baseline-'));
    process.chdir(tmpDir);
    try {
      const testStep = step.run({
        id: 'echo',
        execute: async (input: unknown) => input,
      });
      const ctx = createEvalContext(testStep, {
        objective: 'nan baseline test',
      });
      const result = await ctx.execute('x');

      const scores = await result.score([
        async () => ({
          scorerId: 'nan-scorer',
          score: 0 / 0,
        }),
      ]);

      expect(scores[0].score).toBe(0);
      expect(Number.isNaN(scores[0].metadata?.sanitizedFrom)).toBe(true);

      const { saveBaseline, loadBaseline } = await import('../../src/regression/baseline');
      await saveBaseline({
        suiteName: 'nan-suite',
        objective: 'nan baseline test',
        cases: [
          {
            name: 'case-1',
            scores: [
              ...ctx.accumulatedScores,
            ],
            passed: false,
            duration: 1,
          },
        ],
        aggregateScore: 0,
        duration: 1,
        timestamp: new Date().toISOString(),
      });
      const loaded = await loadBaseline('nan-suite');
      expect(loaded).not.toBeNull();
      expect(loaded?.suiteResult.cases[0].scores[0].score).toBe(0);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmpDir, {
        recursive: true,
        force: true,
      });
    }
  });
});
