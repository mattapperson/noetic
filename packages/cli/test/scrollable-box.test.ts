/**
 * Unit tests for the pure scroll math behind <ScrollableBox>.
 * Keyboard/render behavior is covered via pilotty-driven e2e.
 */

import { describe, expect, test } from 'bun:test';
import { clampScrollTop, computeMaxScroll } from '../src/tui/components/tabs/scrollable-box.js';

describe('computeMaxScroll', () => {
  test('yields 0 when rowCount < height', () => {
    expect(computeMaxScroll(4, 10)).toBe(0);
  });
  test('yields 0 at the N = height boundary (no overflow)', () => {
    expect(computeMaxScroll(10, 10)).toBe(0);
  });
  test('yields 1 at N = height + 1 (just overflows)', () => {
    expect(computeMaxScroll(11, 10)).toBe(1);
  });
  test('grows linearly past overflow', () => {
    expect(computeMaxScroll(25, 10)).toBe(15);
  });
  test('clamps negative inputs to 0', () => {
    expect(computeMaxScroll(0, 10)).toBe(0);
  });
});

describe('clampScrollTop', () => {
  test('returns 0 for negative inputs', () => {
    expect(clampScrollTop(-5, 10)).toBe(0);
  });
  test('returns the input when in range', () => {
    expect(clampScrollTop(3, 10)).toBe(3);
  });
  test('returns maxScroll when input exceeds it', () => {
    expect(clampScrollTop(99, 10)).toBe(10);
  });
  test('returns 0 when maxScroll is 0', () => {
    expect(clampScrollTop(5, 0)).toBe(0);
  });
});
