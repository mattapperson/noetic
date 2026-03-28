import { describe, expect, test } from 'bun:test';

import { InMemoryAgentHarness } from '@noetic/core';
import { ContextImpl, SpanImpl } from '@noetic/core/internal/test';
import { createScorer } from '../../src/scorers/scorer-pipeline';
import type { EvalExecution, ScoreResult, ScorerFn } from '../../src/scorers/types';

//#region Helper Functions

const testHarness = new InMemoryAgentHarness({
  name: 'test',
  params: {},
});

function createMockExecution(output: unknown): EvalExecution {
  const ctx = new ContextImpl({
    harness: testHarness,
  });
  ctx.cost = 0.01;
  ctx.tokens = {
    input: 50,
    output: 25,
    total: 75,
  };
  ctx.lastStepMeta = null;

  Object.defineProperty(ctx, 'elapsed', {
    get(): number {
      return 100;
    },
  });

  return {
    output,
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

describe('createScorer pipeline', () => {
  test('preprocess + generateScore produces correct ScoreResult', async () => {
    const scorer = createScorer({
      id: 'test-scorer',
    })
      .preprocess(({ execution }) => ({
        outputLength: String(execution.output).length,
      }))
      .generateScore(({ results }) => (results.outputLength < 10 ? 1.0 : 0.5));

    const execution = createMockExecution('hello');
    const result = await scorer(execution, 'test objective', 'test background');

    expect(result.scorerId).toBe('test-scorer');
    expect(result.score).toBe(1.0);
  });

  test('scorer returns low score for long output', async () => {
    const scorer = createScorer({
      id: 'length-scorer',
    })
      .preprocess(({ execution }) => ({
        outputLength: String(execution.output).length,
      }))
      .generateScore(({ results }) => (results.outputLength < 10 ? 1.0 : 0.5));

    const execution = createMockExecution('this is a long output string');
    const result = await scorer(execution, '', '');

    expect(result.score).toBe(0.5);
  });

  test('generateReason attaches reason to result', async () => {
    const scorer = createScorer({
      id: 'reason-scorer',
    })
      .preprocess(({ execution }) => ({
        value: execution.output,
      }))
      .generateScore(({ results }) => (results.value === 'yes' ? 1.0 : 0.0))
      .generateReason({
        createPrompt: (score) => `Score was ${score}`,
      });

    const execution = createMockExecution('yes');
    const result = await scorer(execution, '', '');

    expect(result.scorerId).toBe('reason-scorer');
    expect(result.score).toBe(1.0);
    expect(result.reason).toBe('Score was 1');
  });
});

//#endregion
