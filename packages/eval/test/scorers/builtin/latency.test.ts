import { describe, expect, test } from 'bun:test';

import { AgentHarness } from '@noetic-tools/core';
import { ContextImpl, SpanImpl } from '@noetic-tools/core/internal/test';
import { latency } from '../../../src/scorers/builtin/latency';
import type { EvalExecution, ScoreResult, ScorerFn } from '../../../src/scorers/types';

//#region Helper Functions

const testHarness = new AgentHarness({
  name: 'test',
  params: {},
});

function createMockExecution(elapsedOverride: number): EvalExecution {
  const ctx = new ContextImpl({
    harness: testHarness,
  });
  ctx.cost = 0;
  ctx.tokens = {
    input: 0,
    output: 0,
    total: 0,
  };
  ctx.lastStepMeta = null;

  // Override elapsed by patching the getter with a fixed value
  Object.defineProperty(ctx, 'elapsed', {
    get(): number {
      return elapsedOverride;
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

describe('latency scorer', () => {
  const scorer = latency({
    target: 1e3,
    maxAcceptable: 5e3,
  });

  test('returns 1.0 when elapsed is below target', async () => {
    const result = await scorer(createMockExecution(500), '', '');
    expect(result.score).toBe(1.0);
    expect(result.scorerId).toBe('latency');
  });

  test('returns 1.0 when elapsed equals target', async () => {
    const result = await scorer(createMockExecution(1e3), '', '');
    expect(result.score).toBe(1.0);
  });

  test('returns linearly decreasing score between target and maxAcceptable', async () => {
    const result = await scorer(createMockExecution(3e3), '', '');
    // (3000 - 1000) / (5000 - 1000) = 0.5, so score = 1 - 0.5 = 0.5
    expect(result.score).toBe(0.5);
  });

  test('returns 0.0 when elapsed equals maxAcceptable', async () => {
    const result = await scorer(createMockExecution(5e3), '', '');
    expect(result.score).toBe(0.0);
  });

  test('returns 0.0 when elapsed exceeds maxAcceptable', async () => {
    const result = await scorer(createMockExecution(10e3), '', '');
    expect(result.score).toBe(0.0);
  });

  test('includes metadata with elapsed and config', async () => {
    const result = await scorer(createMockExecution(2e3), '', '');
    expect(result.metadata).toEqual({
      elapsed: 2e3,
      target: 1e3,
      maxAcceptable: 5e3,
    });
  });

  test('maxAcceptable < target throws RangeError at construction', () => {
    expect(() =>
      latency({
        target: 1e3,
        maxAcceptable: 500,
      }),
    ).toThrow(RangeError);
  });

  test('maxAcceptable === target acts as a step function (boundaries N-1/N/N+1)', async () => {
    const stepScorer = latency({
      target: 1e3,
      maxAcceptable: 1e3,
    });
    expect((await stepScorer(createMockExecution(999), '', '')).score).toBe(1);
    expect((await stepScorer(createMockExecution(1e3), '', '')).score).toBe(1);
    expect((await stepScorer(createMockExecution(1001), '', '')).score).toBe(0);
  });

  test('score never exceeds 1 (linear branch clamped)', async () => {
    const result = await scorer(createMockExecution(1001), '', '');
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});

//#endregion
