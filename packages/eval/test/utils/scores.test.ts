import { describe, expect, test } from 'bun:test';

import {
  averageNumbers,
  averageScores,
  maxScore,
  medianScore,
  minScore,
  stddevScore,
} from '../../src/utils/scores';

//#region Helper Functions

function makeScores(values: readonly number[]): ReadonlyArray<{
  score: number;
}> {
  return values.map((score) => ({
    score,
  }));
}

//#endregion

//#region Tests

describe('averageNumbers', () => {
  test('empty array returns 0', () => {
    expect(averageNumbers([])).toBe(0);
  });

  test('single value returns that value', () => {
    expect(
      averageNumbers([
        0.7,
      ]),
    ).toBe(0.7);
  });

  test('multiple values returns arithmetic mean', () => {
    expect(
      averageNumbers([
        0.2,
        0.4,
        0.6,
        0.8,
      ]),
    ).toBe(0.5);
  });
});

describe('averageScores', () => {
  test('empty array returns 0', () => {
    expect(averageScores([])).toBe(0);
  });

  test('single score returns that score', () => {
    expect(
      averageScores(
        makeScores([
          0.9,
        ]),
      ),
    ).toBe(0.9);
  });

  test('multiple scores returns arithmetic mean', () => {
    expect(
      averageScores(
        makeScores([
          0.0,
          1.0,
        ]),
      ),
    ).toBe(0.5);
  });
});

describe('medianScore', () => {
  test('empty array returns 0', () => {
    expect(medianScore([])).toBe(0);
  });

  test('odd count returns middle value', () => {
    expect(
      medianScore(
        makeScores([
          0.1,
          0.5,
          0.9,
        ]),
      ),
    ).toBe(0.5);
  });

  test('even count returns average of two middle values', () => {
    expect(
      medianScore(
        makeScores([
          0.2,
          0.4,
          0.6,
          0.8,
        ]),
      ),
    ).toBe(0.5);
  });
});

describe('minScore', () => {
  test('empty array returns 0', () => {
    expect(minScore([])).toBe(0);
  });

  test('finds minimum score', () => {
    expect(
      minScore(
        makeScores([
          0.8,
          0.3,
          0.6,
        ]),
      ),
    ).toBe(0.3);
  });
});

describe('maxScore', () => {
  test('empty array returns 0', () => {
    expect(maxScore([])).toBe(0);
  });

  test('finds maximum score', () => {
    expect(
      maxScore(
        makeScores([
          0.2,
          0.9,
          0.5,
        ]),
      ),
    ).toBe(0.9);
  });
});

describe('stddevScore', () => {
  test('empty array returns 0', () => {
    expect(stddevScore([])).toBe(0);
  });

  test('single score returns 0', () => {
    expect(
      stddevScore(
        makeScores([
          0.5,
        ]),
      ),
    ).toBe(0);
  });

  test('known values produce correct stddev', () => {
    const result = stddevScore(
      makeScores([
        0.2,
        0.4,
        0.6,
        0.8,
      ]),
    );
    expect(result).toBeCloseTo(0.2236, 3);
  });
});

//#endregion
