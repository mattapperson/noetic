import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { relativizeHome } from '../src/tui/paths.js';
import { pluralize } from '../src/tui/plural.js';

describe('pluralize', () => {
  test.each([
    [
      0,
      'lines',
    ],
    [
      1,
      'line',
    ],
    [
      2,
      'lines',
    ],
    [
      100,
      'lines',
    ],
  ])('%i → %s', (count, expected) => {
    expect(pluralize(count, 'line', 'lines')).toBe(expected);
  });
});

describe('relativizeHome', () => {
  test('replaces $HOME prefix with ~', () => {
    const home = homedir();
    expect(relativizeHome(`${home}/project/file.ts`)).toBe('~/project/file.ts');
  });

  test('passes through paths outside $HOME', () => {
    expect(relativizeHome('/etc/hosts')).toBe('/etc/hosts');
  });

  test('passes through non-absolute paths', () => {
    expect(relativizeHome('relative/path.ts')).toBe('relative/path.ts');
  });
});
