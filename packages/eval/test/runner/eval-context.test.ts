import { describe, expect, test } from 'bun:test';
import { step } from '@noetic/core';

import { createEvalContext } from '../../src/runner/eval-context';

describe('createEvalContext()', () => {
  test('creates context with objective and background', () => {
    const testStep = step.run({
      id: 'echo',
      execute: async (input: unknown) => input,
    });

    const ctx = createEvalContext(
      {
        step: testStep,
      },
      'test objective',
      'test background',
    );

    expect(ctx.objective).toBe('test objective');
    expect(ctx.background).toBe('test background');
    expect(typeof ctx.execute).toBe('function');
  });

  test('execute() returns EvalExecution with output and context', async () => {
    const testStep = step.run({
      id: 'doubler',
      execute: async (input: unknown) => Number(input) * 2,
    });

    const ctx = createEvalContext(
      {
        step: testStep,
      },
      'doubling objective',
      '',
    );

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

    const ctx = createEvalContext(
      {
        step: testStep,
      },
      'greeting objective',
      'greeting background',
    );

    const result = await ctx.execute('world');
    expect(result.output).toBe('hello world');
  });

  test('score() invokes scorer functions', async () => {
    const testStep = step.run({
      id: 'echo',
      execute: async (input: unknown) => input,
    });

    const ctx = createEvalContext(
      {
        step: testStep,
      },
      'score test',
      'background',
    );

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
});
