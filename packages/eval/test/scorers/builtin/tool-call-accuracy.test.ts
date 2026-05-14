import { describe, expect, test } from 'bun:test';

import { AgentHarness } from '@noetic-tools/core';
import { ContextImpl, SpanImpl } from '@noetic-tools/core/internal/test';
import { toolCallAccuracy } from '../../../src/scorers/builtin/tool-call-accuracy';
import type { EvalExecution, ScoreResult, ScorerFn } from '../../../src/scorers/types';

//#region Helper Functions

const testHarness = new AgentHarness({
  name: 'test',
  params: {},
});

function createMockExecution(toolNames: string[]): EvalExecution {
  const ctx = new ContextImpl({
    harness: testHarness,
  });
  ctx.cost = 0;
  ctx.tokens = {
    input: 0,
    output: 0,
    total: 0,
  };
  ctx.lastStepMeta =
    toolNames.length > 0
      ? {
          toolCalls: toolNames.map((name, i) => ({
            id: `call-${i}`,
            type: 'function_call' as const,
            callId: `call-${i}`,
            name,
            arguments: '{}',
            status: 'completed' as const,
          })),
        }
      : null;

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

describe('toolCallAccuracy scorer (non-strict)', () => {
  const scorer = toolCallAccuracy({
    expectedTools: [
      'search',
      'fetch',
      'parse',
    ],
  });

  test('returns 1.0 when all expected tools are called', async () => {
    const result = await scorer(
      createMockExecution([
        'search',
        'fetch',
        'parse',
      ]),
      '',
      '',
    );
    expect(result.score).toBe(1.0);
    expect(result.scorerId).toBe('tool-call-accuracy');
  });

  test('returns 1.0 when all expected tools are called plus extras', async () => {
    const result = await scorer(
      createMockExecution([
        'search',
        'fetch',
        'parse',
        'validate',
      ]),
      '',
      '',
    );
    expect(result.score).toBe(1.0);
  });

  test('returns partial score when some expected tools are called', async () => {
    const result = await scorer(
      createMockExecution([
        'search',
        'fetch',
      ]),
      '',
      '',
    );
    // 2/3 matched
    expect(result.score).toBeCloseTo(2 / 3, 5);
  });

  test('returns 0.0 when no expected tools are called', async () => {
    const result = await scorer(
      createMockExecution([
        'validate',
        'transform',
      ]),
      '',
      '',
    );
    expect(result.score).toBe(0.0);
  });

  test('returns 0.0 when no tools are called at all', async () => {
    const result = await scorer(createMockExecution([]), '', '');
    expect(result.score).toBe(0.0);
  });

  test('returns 1/3 when one of three expected tools is called', async () => {
    const result = await scorer(
      createMockExecution([
        'parse',
      ]),
      '',
      '',
    );
    expect(result.score).toBeCloseTo(1 / 3, 5);
  });

  test('includes metadata with expected, actual, and matched', async () => {
    const result = await scorer(
      createMockExecution([
        'search',
        'validate',
      ]),
      '',
      '',
    );
    expect(result.metadata).toEqual({
      expected: [
        'search',
        'fetch',
        'parse',
      ],
      actual: [
        'search',
        'validate',
      ],
      matched: [
        'search',
      ],
    });
  });
});

describe('toolCallAccuracy scorer (strict)', () => {
  const scorer = toolCallAccuracy({
    expectedTools: [
      'search',
      'fetch',
    ],
    strict: true,
  });

  test('returns 1.0 when tools match exactly', async () => {
    const result = await scorer(
      createMockExecution([
        'search',
        'fetch',
      ]),
      '',
      '',
    );
    expect(result.score).toBe(1.0);
    expect(result.scorerId).toBe('tool-call-accuracy');
  });

  test('returns 1.0 when tools match in different order', async () => {
    const result = await scorer(
      createMockExecution([
        'fetch',
        'search',
      ]),
      '',
      '',
    );
    expect(result.score).toBe(1.0);
  });

  test('returns 0.0 when extra tools are present', async () => {
    const result = await scorer(
      createMockExecution([
        'search',
        'fetch',
        'parse',
      ]),
      '',
      '',
    );
    expect(result.score).toBe(0.0);
  });

  test('returns 0.0 when tools are missing', async () => {
    const result = await scorer(
      createMockExecution([
        'search',
      ]),
      '',
      '',
    );
    expect(result.score).toBe(0.0);
  });

  test('returns 0.0 when no tools are called', async () => {
    const result = await scorer(createMockExecution([]), '', '');
    expect(result.score).toBe(0.0);
  });

  test('returns 0.0 when completely different tools are called', async () => {
    const result = await scorer(
      createMockExecution([
        'validate',
        'transform',
      ]),
      '',
      '',
    );
    expect(result.score).toBe(0.0);
  });

  test('includes metadata with strict flag', async () => {
    const result = await scorer(
      createMockExecution([
        'search',
        'fetch',
      ]),
      '',
      '',
    );
    expect(result.metadata).toEqual({
      expected: [
        'search',
        'fetch',
      ],
      actual: [
        'search',
        'fetch',
      ],
      strict: true,
    });
  });
});

describe('toolCallAccuracy scorer (empty expected)', () => {
  const scorer = toolCallAccuracy({
    expectedTools: [],
  });

  test('returns 1.0 when no tools expected and none called', async () => {
    const result = await scorer(createMockExecution([]), '', '');
    expect(result.score).toBe(1.0);
  });

  test('returns 1.0 when no tools expected even if tools are called', async () => {
    const result = await scorer(
      createMockExecution([
        'search',
      ]),
      '',
      '',
    );
    expect(result.score).toBe(1.0);
  });
});

describe('toolCallAccuracy scorer (empty expected, strict)', () => {
  const scorer = toolCallAccuracy({
    expectedTools: [],
    strict: true,
  });

  test('returns 1.0 when no tools expected and none called', async () => {
    const result = await scorer(createMockExecution([]), '', '');
    expect(result.score).toBe(1.0);
  });

  test('returns 0.0 when no tools expected but tools are called', async () => {
    const result = await scorer(
      createMockExecution([
        'search',
      ]),
      '',
      '',
    );
    expect(result.score).toBe(0.0);
  });
});

//#endregion
