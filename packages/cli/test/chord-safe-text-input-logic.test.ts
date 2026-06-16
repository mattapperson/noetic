/**
 * Unit tests for the pure helpers behind `ChordSafeTextInput`.
 *
 * The existing `chord-safe-text-input.test.ts` is a source-pin guarding
 * the explicit `if (key.ctrl) return` against accidental removal. This
 * file covers the actual behaviour: ignored-key predicate, the
 * non-typed-input filter (SGR mouse remnants), and the cursor/buffer
 * reducer that runs once per accepted keystroke.
 */

import { describe, expect, test } from 'bun:test';
import type { ChordSafeKey } from '../src/tui/components/chord-safe-text-input.js';
import {
  computeNextState,
  isIgnoredKey,
  isNonTypedInput,
} from '../src/tui/components/chord-safe-text-input.js';

//#region isIgnoredKey

describe('isIgnoredKey', () => {
  test('returns true for any Ctrl-modified key (Ctrl+W is the canonical reason)', () => {
    expect(
      isIgnoredKey({
        ctrl: true,
      }),
    ).toBe(true);
    expect(
      isIgnoredKey({
        ctrl: true,
        shift: true,
      }),
    ).toBe(true);
  });

  test('returns true for arrows and Tab', () => {
    expect(
      isIgnoredKey({
        upArrow: true,
      }),
    ).toBe(true);
    expect(
      isIgnoredKey({
        downArrow: true,
      }),
    ).toBe(true);
    expect(
      isIgnoredKey({
        tab: true,
      }),
    ).toBe(true);
    expect(
      isIgnoredKey({
        shift: true,
        tab: true,
      }),
    ).toBe(true);
  });

  test('returns false for ordinary printable keystrokes (no flags set)', () => {
    expect(isIgnoredKey({})).toBe(false);
    // Shift on its own (e.g. Shift+'a') is normal text — must not be ignored.
    expect(
      isIgnoredKey({
        shift: true,
      }),
    ).toBe(false);
  });

  test('left/right arrows are NOT ignored (cursor movement is the reducer’s job)', () => {
    expect(
      isIgnoredKey({
        leftArrow: true,
      }),
    ).toBe(false);
    expect(
      isIgnoredKey({
        rightArrow: true,
      }),
    ).toBe(false);
  });

  test('backspace / delete are NOT ignored (handled by the reducer)', () => {
    expect(
      isIgnoredKey({
        backspace: true,
      }),
    ).toBe(false);
    expect(
      isIgnoredKey({
        delete: true,
      }),
    ).toBe(false);
  });
});

//#endregion

//#region isNonTypedInput (SGR mouse remnant filter)

describe('isNonTypedInput', () => {
  test('detects the bare SGR mouse remnant (ESC already stripped by ink)', () => {
    expect(isNonTypedInput('[<64;1;1M')).toBe(true);
    expect(isNonTypedInput('[<0;10;20m')).toBe(true);
  });

  test('detects modifier-bitmask wheel events (Ctrl/Shift held while scrolling)', () => {
    // 64 + 4 (shift) + 16 (ctrl) = 84
    expect(isNonTypedInput('[<84;1;1M')).toBe(true);
  });

  test('returns false for ordinary typed text that happens to begin with `[`', () => {
    expect(isNonTypedInput('[hello]')).toBe(false);
    expect(isNonTypedInput('[<not a mouse event')).toBe(false);
  });

  test('returns false for non-mouse CSI remnants (e.g. PgUp = ESC[5~ → "[5~")', () => {
    expect(isNonTypedInput('[5~')).toBe(false);
  });

  test('returns false for plain ASCII keystrokes', () => {
    expect(isNonTypedInput('a')).toBe(false);
    expect(isNonTypedInput('')).toBe(false);
  });
});

//#endregion

//#region computeNextState

const NO_KEY: ChordSafeKey = {};

describe('computeNextState — typed text', () => {
  test('inserts a single character at the cursor', () => {
    const result = computeNextState({
      input: 'a',
      key: NO_KEY,
      originalValue: 'hi',
      cursorOffset: 2,
      showCursor: true,
    });
    expect(result.nextValue).toBe('hia');
    expect(result.nextCursorOffset).toBe(3);
    expect(result.nextCursorWidth).toBe(0);
  });

  test('inserts mid-buffer (cursor offset between characters)', () => {
    const result = computeNextState({
      input: 'X',
      key: NO_KEY,
      originalValue: 'hello',
      cursorOffset: 2,
      showCursor: true,
    });
    expect(result.nextValue).toBe('heXllo');
    expect(result.nextCursorOffset).toBe(3);
  });

  test('multi-character input (paste) advances cursor by input.length and flags cursorWidth', () => {
    const result = computeNextState({
      input: 'paste',
      key: NO_KEY,
      originalValue: '',
      cursorOffset: 0,
      showCursor: true,
    });
    expect(result.nextValue).toBe('paste');
    expect(result.nextCursorOffset).toBe(5);
    expect(result.nextCursorWidth).toBe(5);
  });
});

describe('computeNextState — cursor movement', () => {
  test('left arrow decrements cursor offset when showCursor is on', () => {
    const result = computeNextState({
      input: '',
      key: {
        leftArrow: true,
      },
      originalValue: 'hello',
      cursorOffset: 3,
      showCursor: true,
    });
    expect(result.nextCursorOffset).toBe(2);
    expect(result.nextValue).toBe('hello'); // buffer untouched
  });

  test('right arrow increments cursor offset when showCursor is on', () => {
    const result = computeNextState({
      input: '',
      key: {
        rightArrow: true,
      },
      originalValue: 'hello',
      cursorOffset: 2,
      showCursor: true,
    });
    expect(result.nextCursorOffset).toBe(3);
  });

  test('left arrow with showCursor=false is a no-op', () => {
    const result = computeNextState({
      input: '',
      key: {
        leftArrow: true,
      },
      originalValue: 'hello',
      cursorOffset: 3,
      showCursor: false,
    });
    expect(result.nextCursorOffset).toBe(3);
  });

  test('cursor offset cannot go negative', () => {
    const result = computeNextState({
      input: '',
      key: {
        leftArrow: true,
      },
      originalValue: 'hello',
      cursorOffset: 0,
      showCursor: true,
    });
    // After decrement → -1 → clamped to 0.
    expect(result.nextCursorOffset).toBe(0);
  });

  test('cursor offset cannot exceed value length after an insert', () => {
    const result = computeNextState({
      input: 'x',
      key: NO_KEY,
      originalValue: '',
      cursorOffset: 5, // stale — past end
      showCursor: true,
    });
    expect(result.nextValue).toBe('x');
    expect(result.nextCursorOffset).toBeLessThanOrEqual(result.nextValue.length);
  });
});

describe('computeNextState — deletion', () => {
  test('backspace removes the character before the cursor', () => {
    const result = computeNextState({
      input: '',
      key: {
        backspace: true,
      },
      originalValue: 'abcdef',
      cursorOffset: 3,
      showCursor: true,
    });
    expect(result.nextValue).toBe('abdef');
    expect(result.nextCursorOffset).toBe(2);
  });

  test('delete uses the same backspace-style behaviour (consistent with upstream ink-text-input)', () => {
    const result = computeNextState({
      input: '',
      key: {
        delete: true,
      },
      originalValue: 'abcdef',
      cursorOffset: 3,
      showCursor: true,
    });
    expect(result.nextValue).toBe('abdef');
    expect(result.nextCursorOffset).toBe(2);
  });

  test('backspace at the start of the buffer is a no-op (no negative cursor)', () => {
    const result = computeNextState({
      input: '',
      key: {
        backspace: true,
      },
      originalValue: 'abc',
      cursorOffset: 0,
      showCursor: true,
    });
    expect(result.nextValue).toBe('abc');
    expect(result.nextCursorOffset).toBe(0);
  });
});
