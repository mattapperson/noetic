import { describe, expect, test } from 'bun:test';

import { AgentHarness } from '@noetic/core';
import { ContextImpl, SpanImpl } from '@noetic/core/internal/test';
import { tokenEfficiency } from '../../../src/scorers/builtin/token-efficiency';
import type { EvalExecution, ScoreResult, ScorerFn } from '../../../src/scorers/types';

//#region Helper Functions

const testHarness = new AgentHarness({
  name: 'test',
  params: {},
});

function createMockExecution(outputTokens: number): EvalExecution {
  const ctx = new ContextImpl({
    harness: testHarness,
  });
  ctx.cost = 0;
  ctx.tokens = {
    input: 0,
    output: outputTokens,
    total: outputTokens,
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

describe('tokenEfficiency scorer', () => {
  const scorer = tokenEfficiency({
    maxOutputTokens: 1e3,
  });

  test('returns 1.0 when output tokens are zero', async () => {
    const result = await scorer(createMockExecution(0), '', '');
    expect(result.score).toBe(1.0);
    expect(result.scorerId).toBe('token-efficiency');
  });

  test('returns 1.0 when output tokens are below max', async () => {
    const result = await scorer(createMockExecution(500), '', '');
    expect(result.score).toBe(1.0);
  });

  test('returns 1.0 at N-1 (just below max)', async () => {
    const result = await scorer(createMockExecution(999), '', '');
    expect(result.score).toBe(1.0);
  });

  test('returns 1.0 when output tokens equal max (N boundary)', async () => {
    const result = await scorer(createMockExecution(1e3), '', '');
    expect(result.score).toBe(1.0);
  });

  test('returns linearly decreasing score above max (N+1)', async () => {
    const result = await scorer(createMockExecution(1001), '', '');
    // ratio = 1001/1000 = 1.001, score = 1 - 0.001 = 0.999
    expect(result.score).toBeCloseTo(0.999, 3);
  });

  test('returns 0.5 when output tokens are 1.5x max', async () => {
    const result = await scorer(createMockExecution(1500), '', '');
    // ratio = 1.5, score = 1 - (1.5 - 1) = 0.5
    expect(result.score).toBe(0.5);
  });

  test('returns 0.0 when output tokens are 2x max', async () => {
    const result = await scorer(createMockExecution(2e3), '', '');
    // ratio = 2.0, score = 1 - (2.0 - 1) = 0.0
    expect(result.score).toBe(0.0);
  });

  test('returns 0.0 when output tokens far exceed max', async () => {
    const result = await scorer(createMockExecution(5e3), '', '');
    // ratio = 5.0, score = max(0, 1 - 4) = 0.0
    expect(result.score).toBe(0.0);
  });

  test('includes metadata with outputTokens and maxOutputTokens', async () => {
    const result = await scorer(createMockExecution(750), '', '');
    expect(result.metadata).toEqual({
      outputTokens: 750,
      maxOutputTokens: 1e3,
    });
  });
});

//#endregion
