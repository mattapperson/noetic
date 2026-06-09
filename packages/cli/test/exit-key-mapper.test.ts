import { describe, expect, test } from 'bun:test';

import { mapInkKeyToExitKey } from '../src/tui/input/use-exit-on-interrupt.js';

const NEUTRAL_KEY = {
  escape: false,
  ctrl: false,
};

describe('mapInkKeyToExitKey', () => {
  test('escape key → escape', () => {
    expect(
      mapInkKeyToExitKey('', {
        escape: true,
        ctrl: false,
      }),
    ).toBe('escape');
  });

  test('Ctrl+C → ctrl-c', () => {
    expect(
      mapInkKeyToExitKey('c', {
        escape: false,
        ctrl: true,
      }),
    ).toBe('ctrl-c');
  });

  test('Ctrl+D → ctrl-d', () => {
    expect(
      mapInkKeyToExitKey('d', {
        escape: false,
        ctrl: true,
      }),
    ).toBe('ctrl-d');
  });

  test('plain c (no ctrl) → null', () => {
    expect(mapInkKeyToExitKey('c', NEUTRAL_KEY)).toBeNull();
  });

  test('Ctrl+X (unmapped) → null', () => {
    expect(
      mapInkKeyToExitKey('x', {
        escape: false,
        ctrl: true,
      }),
    ).toBeNull();
  });

  test('enabledKeys filter excludes escape when only ctrl-c registered', () => {
    expect(
      mapInkKeyToExitKey(
        '',
        {
          escape: true,
          ctrl: false,
        },
        [
          'ctrl-c',
        ],
      ),
    ).toBeNull();
  });

  test('enabledKeys filter passes through registered key', () => {
    expect(
      mapInkKeyToExitKey(
        'c',
        {
          escape: false,
          ctrl: true,
        },
        [
          'ctrl-c',
        ],
      ),
    ).toBe('ctrl-c');
  });

  test('empty enabledKeys filter blocks everything', () => {
    expect(
      mapInkKeyToExitKey(
        'c',
        {
          escape: false,
          ctrl: true,
        },
        [],
      ),
    ).toBeNull();
  });

  test('undefined enabledKeys allows all (default)', () => {
    expect(
      mapInkKeyToExitKey('d', {
        escape: false,
        ctrl: true,
      }),
    ).toBe('ctrl-d');
  });
});
