import { describe, expect, test } from 'bun:test';
import { step } from '@noetic-tools/core';

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
  const echoStep = step.run({
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
    const echoStep = step.run({
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
