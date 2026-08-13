import { describe, expect, test } from 'bun:test';
import { runCode } from '@noetic-tools/core';

import type { SuiteDefinition } from '../../src/runner/describe';
import { runSuite } from '../../src/runner/suite-runner';
import type { ScorerFn } from '../../src/types/scorer';

//#region Helper Functions

function makeFixedScorer(score: number): ScorerFn {
  return async () => ({
    scorerId: 'fixed',
    score,
  });
}

function makeSuiteDefinition(fixedScore: number, passThreshold?: number): SuiteDefinition {
  const echoStep = runCode({
    id: 'echo',
    execute: async (input: unknown) => input,
  });

  return {
    step: echoStep,
    options: {
      objective: 'test objective',
      passThreshold,
    },
    cases: [
      {
        name: 'test case',
        async fn(ctx) {
          const exec = await ctx.execute('input');
          await exec.score([
            makeFixedScorer(fixedScore),
          ]);
        },
      },
    ],
  };
}

//#endregion

//#region Tests

describe('runSuite passThreshold', () => {
  test('score exactly at default threshold 0.5 passes', async () => {
    const result = await runSuite(makeSuiteDefinition(0.5));

    expect(result.cases[0].passed).toBe(true);
  });

  test('score at 0.499 below default threshold fails', async () => {
    const result = await runSuite(makeSuiteDefinition(0.499));

    expect(result.cases[0].passed).toBe(false);
  });

  test('score at 0.501 above default threshold passes', async () => {
    const result = await runSuite(makeSuiteDefinition(0.501));

    expect(result.cases[0].passed).toBe(true);
  });

  test('no scores (empty) passes', async () => {
    const echoStep = runCode({
      id: 'echo',
      execute: async (input: unknown) => input,
    });

    const suite: SuiteDefinition = {
      step: echoStep,
      options: {
        objective: 'empty scores test',
      },
      cases: [
        {
          name: 'no-score case',
          async fn(ctx) {
            await ctx.execute('input');
          },
        },
      ],
    };

    const result = await runSuite(suite);

    expect(result.cases[0].passed).toBe(true);
    expect(result.cases[0].scores).toHaveLength(0);
  });

  test('custom threshold 0.8 with score 0.79 fails', async () => {
    const result = await runSuite(makeSuiteDefinition(0.79, 0.8));

    expect(result.cases[0].passed).toBe(false);
  });
});

//#endregion

//#region bounded case concurrency

describe('runSuite case concurrency', () => {
  function makeConcurrencySuite(caseCount: number): {
    suite: SuiteDefinition;
    state: {
      active: number;
      maxActive: number;
      started: string[];
    };
  } {
    const echoStep = runCode({
      id: 'echo',
      execute: async (input: unknown) => input,
    });
    const state: {
      active: number;
      maxActive: number;
      started: string[];
    } = {
      active: 0,
      maxActive: 0,
      started: [],
    };
    const cases = Array.from(
      {
        length: caseCount,
      },
      (_, i) => ({
        name: `case-${i}`,
        async fn() {
          state.started.push(`case-${i}`);
          state.active++;
          state.maxActive = Math.max(state.maxActive, state.active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          state.active--;
        },
      }),
    );
    return {
      suite: {
        step: echoStep,
        options: {
          objective: 'concurrency test',
        },
        cases,
      },
      state,
    };
  }

  test('cases run concurrently by default (bounded at 4)', async () => {
    const { suite, state } = makeConcurrencySuite(8);
    const result = await runSuite(suite);

    expect(result.cases).toHaveLength(8);
    expect(state.maxActive).toBeGreaterThan(1);
    expect(state.maxActive).toBeLessThanOrEqual(4);
  });

  test('explicit concurrency bounds in-flight cases', async () => {
    const { suite, state } = makeConcurrencySuite(6);
    await runSuite(suite, {
      concurrency: 2,
    });

    expect(state.maxActive).toBeLessThanOrEqual(2);
    expect(state.maxActive).toBeGreaterThan(1);
  });

  test('rejects invalid programmatic concurrency', async () => {
    const { suite } = makeConcurrencySuite(1);
    await expect(
      runSuite(suite, {
        concurrency: Number.NaN,
      }),
    ).rejects.toThrow('positive integer');
    await expect(
      runSuite(suite, {
        concurrency: 1.5,
      }),
    ).rejects.toThrow('positive integer');
    await expect(
      runSuite(suite, {
        concurrency: 0,
      }),
    ).rejects.toThrow('positive integer');
  });

  test('concurrency 1 runs strictly sequentially', async () => {
    const { suite, state } = makeConcurrencySuite(4);
    await runSuite(suite, {
      concurrency: 1,
    });

    expect(state.maxActive).toBe(1);
  });

  test('results stay ordered by definition regardless of completion order', async () => {
    const echoStep = runCode({
      id: 'echo',
      execute: async (input: unknown) => input,
    });
    // First case is slowest: with a naive push-on-completion pool it would
    // land last. Result order must follow the definition order.
    const suite: SuiteDefinition = {
      step: echoStep,
      options: {
        objective: 'ordering test',
      },
      cases: [
        {
          name: 'slow-first',
          async fn() {
            await new Promise((resolve) => setTimeout(resolve, 30));
          },
        },
        {
          name: 'fast-second',
          async fn() {
            await new Promise((resolve) => setTimeout(resolve, 1));
          },
        },
      ],
    };

    const result = await runSuite(suite);

    expect(result.cases.map((c) => c.name)).toEqual([
      'slow-first',
      'fast-second',
    ]);
  });
});

//#endregion
