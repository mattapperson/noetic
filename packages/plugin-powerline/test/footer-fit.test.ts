import { describe, expect, test } from 'bun:test';
import { fitSegments, truncateToWidth } from '../src/fit.js';
import type { SegmentOutput } from '../src/segments/types.js';

function cell(text: string, bg = '#000', fg = '#fff'): SegmentOutput {
  return {
    text,
    bg,
    fg,
  };
}

const toText = (c: SegmentOutput): string => c.text;

const withText = (c: SegmentOutput, text: string): SegmentOutput => ({
  ...c,
  text,
});

describe('truncateToWidth', () => {
  test('returns text unchanged when it already fits', () => {
    expect(truncateToWidth('hello', 10)).toBe('hello');
  });

  test('returns text exactly at the boundary', () => {
    expect(truncateToWidth('hello', 5)).toBe('hello');
  });

  test('drops trailing chars to fit one column under width', () => {
    expect(truncateToWidth('hello', 4)).toBe('hell');
  });

  test('returns empty string for non-positive max width', () => {
    expect(truncateToWidth('hello', 0)).toBe('');
    expect(truncateToWidth('hello', -1)).toBe('');
  });

  test('handles multi-byte glyphs by code point, not utf-16 code unit', () => {
    expect(truncateToWidth('a🌈b', 2)).toBe('a');
    expect(truncateToWidth('a🌈b', 3)).toBe('a🌈');
  });
});

describe('fitSegments', () => {
  const cells: SegmentOutput[] = [
    cell('alpha'),
    cell('beta'),
    cell('gamma'),
  ];

  test('keeps every cell when budget is generous', () => {
    const result = fitSegments({
      cells,
      toText,
      withText,
      sepBetween: 1,
      sepTrailing: 1,
      budget: 1e3,
    });
    expect(result.length).toBe(3);
    expect(result.map(toText)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  test('drops trailing cells once budget is exhausted (preset order preserved)', () => {
    // ' alpha ' = 7, sepBetween 1, sepTrailing 1 -> first cell costs 7+1=8.
    // Adding beta: +1 sep + ' beta ' (6) = 7 -> total used 15, +1 trailing = 16.
    // Budget of 12 only fits the first cell.
    const result = fitSegments({
      cells,
      toText,
      withText,
      sepBetween: 1,
      sepTrailing: 1,
      budget: 12,
    });
    expect(result.map(toText)).toEqual([
      'alpha',
    ]);
  });

  test('returns empty when budget is non-positive', () => {
    expect(
      fitSegments({
        cells,
        toText,
        withText,
        sepBetween: 1,
        sepTrailing: 1,
        budget: 0,
      }),
    ).toEqual([]);
    expect(
      fitSegments({
        cells,
        toText,
        withText,
        sepBetween: 1,
        sepTrailing: 1,
        budget: -5,
      }),
    ).toEqual([]);
  });

  test('returns empty when no cells supplied', () => {
    expect(
      fitSegments({
        cells: [],
        toText,
        withText,
        sepBetween: 1,
        sepTrailing: 1,
        budget: 80,
      }),
    ).toEqual([]);
  });

  test('truncates the first cell when even it cannot fit alone', () => {
    // Budget 6, sepTrailing 1 -> textBudget = 6 - 1 - 2 = 3.
    const result = fitSegments({
      cells: [
        cell('verylongname'),
      ],
      toText,
      withText,
      sepBetween: 1,
      sepTrailing: 1,
      budget: 6,
    });
    expect(result.length).toBe(1);
    expect(result[0]?.text).toBe('ver');
    expect(result[0]?.bg).toBe('#000');
  });

  test('returns empty when budget cannot accommodate even one truncated char', () => {
    // budget 2 - sepTrailing 1 - 2 padding = -1 textBudget -> empty.
    expect(
      fitSegments({
        cells: [
          cell('any'),
        ],
        toText,
        withText,
        sepBetween: 1,
        sepTrailing: 1,
        budget: 2,
      }),
    ).toEqual([]);
  });

  test('respects ascii separator widths (3 cells, sepBetween=3, sepTrailing=0)', () => {
    // ' alpha '=7 + ' > '=3 + ' beta '=6 = 16. Budget 16 fits both, budget 15 keeps only alpha.
    const fitTwo = fitSegments({
      cells,
      toText,
      withText,
      sepBetween: 3,
      sepTrailing: 0,
      budget: 16,
    });
    expect(fitTwo.map(toText)).toEqual([
      'alpha',
      'beta',
    ]);
    const fitOne = fitSegments({
      cells,
      toText,
      withText,
      sepBetween: 3,
      sepTrailing: 0,
      budget: 15,
    });
    expect(fitOne.map(toText)).toEqual([
      'alpha',
    ]);
  });

  test('boundary tests at the inclusion threshold', () => {
    // ' alpha ' = 7, sepTrailing 1 -> N=8 to include alpha alone.
    // Budget 7: too narrow -> truncation fallback. textBudget = 7 - 1 - 2 = 4 -> 'alph'.
    const narrow = fitSegments({
      cells: [
        cell('alpha'),
      ],
      toText,
      withText,
      sepBetween: 1,
      sepTrailing: 1,
      budget: 7,
    });
    expect(narrow.length).toBe(1);
    expect(narrow[0]?.text).toBe('alph');
    expect(
      fitSegments({
        cells: [
          cell('alpha'),
        ],
        toText,
        withText,
        sepBetween: 1,
        sepTrailing: 1,
        budget: 8,
      })[0]?.text,
    ).toBe('alpha');
    expect(
      fitSegments({
        cells: [
          cell('alpha'),
        ],
        toText,
        withText,
        sepBetween: 1,
        sepTrailing: 1,
        budget: 9,
      })[0]?.text,
    ).toBe('alpha');
  });
});
