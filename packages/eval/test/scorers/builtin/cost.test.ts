import { describe, expect, test } from 'bun:test';

import { AgentHarness } from '@noetic-tools/core';
import { ContextImpl, SpanImpl } from '@noetic-tools/core/internal/test';
import { cost } from '../../../src/scorers/builtin/cost';
import type { EvalExecution, ScoreResult, ScorerFn } from '../../../src/scorers/types';

//#region Helper Functions

const testHarness = new AgentHarness({
  name: 'test',
  params: {},
});

function createMockExecution(costOverride: number): EvalExecution {
  const ctx = new ContextImpl({
    harness: testHarness,
  });
  ctx.cost = costOverride;
  ctx.tokens = {
    input: 0,
    output: 0,
    total: 0,
  };
  ctx.lastStepMeta = null;

  Object.defineProperty(ctx, 'elapsed', {
    get(): number {
      return 0;
    },
  });

  return {
    output: null,
    context: ctx,
    traces: [
      new SpanImpl('test', null),
    ],
    score(_scorers: ScorerFn[]): Promise<ScoreResult[]> {
      return Promise.resolve([]);
    },
  };
}

//#endregion

//#region Tests

describe('cost scorer', () => {
  const scorer = cost({
    budgetPerCall: 0.01,
  });

  test('returns 1.0 when cost is zero', async () => {
    const result = await scorer(createMockExecution(0), '', '');
    expect(result.score).toBe(1.0);
    expect(result.scorerId).toBe('cost');
  });

  test('returns 1.0 when cost is below budget', async () => {
    const result = await scorer(createMockExecution(0.005), '', '');
    expect(result.score).toBe(1.0);
  });

  test('returns 1.0 when cost equals budget (N boundary)', async () => {
    const result = await scorer(createMockExecution(0.01), '', '');
    expect(result.score).toBe(1.0);
  });

  test('returns 1.0 at N-1 (just below budget)', async () => {
    const result = await scorer(createMockExecution(0.009), '', '');
    expect(result.score).toBe(1.0);
  });

  test('returns linearly decreasing score when cost exceeds budget (N+1)', async () => {
    const result = await scorer(createMockExecution(0.011), '', '');
    // ratio = 0.011 / 0.01 = 1.1, score = 1 - (1.1 - 1) = 0.9
    expect(result.score).toBeCloseTo(0.9, 5);
  });

  test('returns 0.5 when cost is 1.5x budget', async () => {
    const result = await scorer(createMockExecution(0.015), '', '');
    // ratio = 1.5, score = 1 - (1.5 - 1) = 0.5
    expect(result.score).toBeCloseTo(0.5, 5);
  });

  test('returns 0.0 when cost is 2x budget', async () => {
    const result = await scorer(createMockExecution(0.02), '', '');
    // ratio = 2.0, score = 1 - (2.0 - 1) = 0.0
    expect(result.score).toBe(0.0);
  });

  test('returns 0.0 when cost far exceeds budget', async () => {
    const result = await scorer(createMockExecution(0.05), '', '');
    // ratio = 5.0, score = max(0, 1 - 4) = 0.0
    expect(result.score).toBe(0.0);
  });

  test('includes metadata with actual cost and budget', async () => {
    const result = await scorer(createMockExecution(0.007), '', '');
    expect(result.metadata).toEqual({
      actual: 0.007,
      budget: 0.01,
    });
  });
});

//#endregion
