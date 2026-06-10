import { describe, expect, test } from 'bun:test';

import { applyThreshold } from '../../../src/scorers/builtin/apply-threshold';

const THRESHOLD = 0.7;
const EPSILON = 1e-9;

describe('applyThreshold', () => {
  test('undefined threshold passes the raw score through', () => {
    expect(applyThreshold(0.42, undefined)).toBe(0.42);
    expect(applyThreshold(0, undefined)).toBe(0);
    expect(applyThreshold(1, undefined)).toBe(1);
  });

  test('raw just below threshold -> 0 (boundary N-epsilon)', () => {
    expect(applyThreshold(THRESHOLD - EPSILON, THRESHOLD)).toBe(0);
  });

  test('raw exactly at threshold -> 1 (boundary N)', () => {
    expect(applyThreshold(THRESHOLD, THRESHOLD)).toBe(1);
  });

  test('raw just above threshold -> 1 (boundary N+epsilon)', () => {
    expect(applyThreshold(THRESHOLD + EPSILON, THRESHOLD)).toBe(1);
  });

  test('threshold 0 gates everything to 1', () => {
    expect(applyThreshold(0, 0)).toBe(1);
    expect(applyThreshold(0.5, 0)).toBe(1);
  });

  test('threshold 1 requires a perfect score', () => {
    expect(applyThreshold(0.999, 1)).toBe(0);
    expect(applyThreshold(1, 1)).toBe(1);
  });
});
