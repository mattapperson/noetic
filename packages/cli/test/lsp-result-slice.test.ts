import { describe, expect, test } from 'bun:test';
import { MAX_RESULT_LINES, sliceResults } from '../src/tui/components/items/lsp-result.js';

describe('sliceResults', () => {
  test('returns empty slice for empty string', () => {
    const out = sliceResults('', false);
    expect(out.visible).toEqual([]);
    expect(out.hidden).toBe(0);
  });

  test('returns single line as-is', () => {
    const out = sliceResults('only-line', false);
    expect(out.visible).toEqual([
      'only-line',
    ]);
    expect(out.hidden).toBe(0);
  });

  test('drops a single trailing empty string from split', () => {
    const out = sliceResults('a\nb\n', false);
    expect(out.visible).toEqual([
      'a',
      'b',
    ]);
    expect(out.hidden).toBe(0);
  });

  test('preserves intermediate blank lines', () => {
    const out = sliceResults('a\n\nb\n', false);
    expect(out.visible).toEqual([
      'a',
      '',
      'b',
    ]);
    expect(out.hidden).toBe(0);
  });

  test('preserves multiple trailing blank lines beyond the first', () => {
    // `"a\n\n\n"` → split gives ['a','','',''] → pop one empty → ['a','',''].
    // Intermediate/trailing blank-line *content* is preserved — only the
    // single extra empty from the trailing newline is dropped.
    const out = sliceResults('a\n\n\n', false);
    expect(out.visible).toEqual([
      'a',
      '',
      '',
    ]);
    expect(out.hidden).toBe(0);
  });

  test('caps at MAX_RESULT_LINES when collapsed', () => {
    const lines = Array.from(
      {
        length: MAX_RESULT_LINES + 3,
      },
      (_, i) => `line-${i}`,
    );
    const out = sliceResults(lines.join('\n'), false);
    expect(out.visible).toHaveLength(MAX_RESULT_LINES);
    expect(out.hidden).toBe(3);
    expect(out.visible[0]).toBe('line-0');
    expect(out.visible[MAX_RESULT_LINES - 1]).toBe(`line-${MAX_RESULT_LINES - 1}`);
  });

  test('shows everything when expanded', () => {
    const lines = Array.from(
      {
        length: MAX_RESULT_LINES + 5,
      },
      (_, i) => `line-${i}`,
    );
    const out = sliceResults(lines.join('\n'), true);
    expect(out.visible).toHaveLength(MAX_RESULT_LINES + 5);
    expect(out.hidden).toBe(0);
  });

  test('boundary: exactly MAX_RESULT_LINES produces no hidden', () => {
    const lines = Array.from(
      {
        length: MAX_RESULT_LINES,
      },
      (_, i) => `line-${i}`,
    );
    const out = sliceResults(lines.join('\n'), false);
    expect(out.visible).toHaveLength(MAX_RESULT_LINES);
    expect(out.hidden).toBe(0);
  });

  test('boundary: MAX_RESULT_LINES + 1 produces hidden=1', () => {
    const lines = Array.from(
      {
        length: MAX_RESULT_LINES + 1,
      },
      (_, i) => `line-${i}`,
    );
    const out = sliceResults(lines.join('\n'), false);
    expect(out.visible).toHaveLength(MAX_RESULT_LINES);
    expect(out.hidden).toBe(1);
  });
});
