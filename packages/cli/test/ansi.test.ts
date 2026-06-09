import { describe, expect, test } from 'bun:test';
import { buildWrappedLines } from '../src/tui/components/ansi.js';

describe('buildWrappedLines', () => {
  test('wraps at word boundaries without leaving a staircase space', () => {
    // The bug: Ink's internal wrap-ansi uses `trim: false`, which produces
    // a stray leading space on the continuation line. buildWrappedLines must
    // pre-wrap with `trim: true` so no continuation begins with whitespace.
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel india';
    const lines = buildWrappedLines(text, 20);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.content.startsWith(' ')).toBe(false);
    }
  });

  test('no line exceeds maxWidth', () => {
    // Fixture is plain ASCII; the length assertion measures raw string length
    // which equals visible width only when no ANSI escapes are present.
    const text = 'a '.repeat(200);
    const lines = buildWrappedLines(text, 30);
    for (const line of lines) {
      expect(line.content.length).toBeLessThanOrEqual(30);
    }
  });

  test('preserves blank lines with a placeholder so Ink does not collapse them', () => {
    const lines = buildWrappedLines('first\n\nthird', 80);
    expect(lines.map((l) => l.content)).toEqual([
      'first',
      ' ',
      'third',
    ]);
  });

  test('produces unique keys for every line', () => {
    const lines = buildWrappedLines('one\ntwo\nthree\n\nfive', 80);
    const keys = lines.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('hard-breaks words longer than maxWidth', () => {
    const lines = buildWrappedLines('supercalifragilisticexpialidocious', 10);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.content.length).toBeLessThanOrEqual(10);
    }
  });

  test('handles empty input', () => {
    const lines = buildWrappedLines('', 80);
    expect(lines).toEqual([
      {
        key: '0',
        content: ' ',
      },
    ]);
  });

  test('every word is preserved when wrapping', () => {
    // Regression guard for `trim: true` — trimming must not drop characters,
    // only reshape where newlines fall.
    const words = [
      'alpha',
      'bravo',
      'charlie',
      'delta',
      'echo',
      'foxtrot',
    ];
    const lines = buildWrappedLines(words.join(' '), 15);
    const joined = lines
      .map((l) => l.content)
      .join(' ')
      .trim()
      .split(/\s+/);
    expect(joined).toEqual(words);
  });

  test.each([
    14,
    15,
    16,
  ])('wraps cleanly at maxWidth=%i (boundary)', (width) => {
    const lines = buildWrappedLines('alpha bravo charlie delta', width);
    for (const line of lines) {
      expect(line.content.length).toBeLessThanOrEqual(width);
      expect(line.content.startsWith(' ')).toBe(false);
    }
  });

  test('preserves ANSI escape codes embedded in the input', () => {
    // `[31m` is SGR red, `[0m` is reset. Using the unicode-
    // escape form keeps the ESC byte visible in source so a reader can
    // see the test is exercising real escape sequences, not bare brackets.
    const red = '\u001b[31m';
    const reset = '\u001b[0m';
    const lines = buildWrappedLines(`${red}hello ${reset}world`, 80);
    const joined = lines.map((l) => l.content).join('');
    expect(joined).toContain(red);
    expect(joined).toContain(reset);
  });
});
