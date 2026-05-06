/**
 * Coverage for the pure `applyKey` reducer behind `MultilineTextArea`.
 *
 * The reducer owns the entire cursor + text state machine, so these tests
 * exercise it directly without rendering Ink. Every branch matters: bad
 * cursor math here is what produces visual glitches and dropped keystrokes
 * in the form.
 */

import { describe, expect, test } from 'bun:test';
import type { Key } from 'ink';
import type { EditorState } from '../../../src/tui/tasks/runtime-ui/multiline-text-area.js';
import { applyKey } from '../../../src/tui/tasks/runtime-ui/multiline-text-area.js';

const BLANK_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};

function key(overrides: Partial<Key>): Key {
  return {
    ...BLANK_KEY,
    ...overrides,
  };
}

function state(value: string, cursor: number): EditorState {
  return {
    value,
    cursor,
  };
}

describe('applyKey: printable input', () => {
  test('inserts a character at the cursor', () => {
    const next = applyKey(state('hello', 5), '!', BLANK_KEY);
    expect(next).toEqual({
      value: 'hello!',
      cursor: 6,
    });
  });

  test('inserts mid-string and advances cursor by input length', () => {
    const next = applyKey(state('hllo', 1), 'e', BLANK_KEY);
    expect(next).toEqual({
      value: 'hello',
      cursor: 2,
    });
  });

  test('ignores empty input with no special key flags', () => {
    const next = applyKey(state('hi', 1), '', BLANK_KEY);
    expect(next).toEqual({
      value: 'hi',
      cursor: 1,
    });
  });

  test('ignores Ctrl-modified input (parent owns shortcuts)', () => {
    const next = applyKey(
      state('hi', 1),
      'a',
      key({
        ctrl: true,
      }),
    );
    expect(next).toEqual({
      value: 'hi',
      cursor: 1,
    });
  });
});

describe('applyKey: Enter as newline', () => {
  test('inserts \\n at cursor position', () => {
    const next = applyKey(
      state('ab', 1),
      '',
      key({
        return: true,
      }),
    );
    expect(next).toEqual({
      value: 'a\nb',
      cursor: 2,
    });
  });

  test('appending newline at end produces a trailing line', () => {
    const next = applyKey(
      state('ab', 2),
      '',
      key({
        return: true,
      }),
    );
    expect(next).toEqual({
      value: 'ab\n',
      cursor: 3,
    });
  });
});

describe('applyKey: backspace', () => {
  test('removes char before cursor', () => {
    const next = applyKey(
      state('abc', 2),
      '',
      key({
        backspace: true,
      }),
    );
    expect(next).toEqual({
      value: 'ac',
      cursor: 1,
    });
  });

  test('is a no-op at start of buffer', () => {
    const next = applyKey(
      state('abc', 0),
      '',
      key({
        backspace: true,
      }),
    );
    expect(next).toEqual({
      value: 'abc',
      cursor: 0,
    });
  });

  test('removes a newline boundary, joining lines', () => {
    const next = applyKey(
      state('a\nb', 2),
      '',
      key({
        backspace: true,
      }),
    );
    expect(next).toEqual({
      value: 'ab',
      cursor: 1,
    });
  });
});

describe('applyKey: delete (forward)', () => {
  test('removes char at cursor', () => {
    const next = applyKey(
      state('abc', 1),
      '',
      key({
        delete: true,
      }),
    );
    expect(next).toEqual({
      value: 'ac',
      cursor: 1,
    });
  });

  test('is a no-op at end of buffer', () => {
    const next = applyKey(
      state('abc', 3),
      '',
      key({
        delete: true,
      }),
    );
    expect(next).toEqual({
      value: 'abc',
      cursor: 3,
    });
  });
});

describe('applyKey: horizontal navigation', () => {
  test('left arrow decrements cursor', () => {
    const next = applyKey(
      state('abc', 2),
      '',
      key({
        leftArrow: true,
      }),
    );
    expect(next.cursor).toBe(1);
  });

  test('left arrow clamps at 0', () => {
    const next = applyKey(
      state('abc', 0),
      '',
      key({
        leftArrow: true,
      }),
    );
    expect(next.cursor).toBe(0);
  });

  test('right arrow increments cursor', () => {
    const next = applyKey(
      state('abc', 1),
      '',
      key({
        rightArrow: true,
      }),
    );
    expect(next.cursor).toBe(2);
  });

  test('right arrow clamps at value.length', () => {
    const next = applyKey(
      state('abc', 3),
      '',
      key({
        rightArrow: true,
      }),
    );
    expect(next.cursor).toBe(3);
  });

  test('home moves to current line start', () => {
    const next = applyKey(
      state('abc\ndef', 5),
      '',
      key({
        home: true,
      }),
    );
    expect(next.cursor).toBe(4);
  });

  test('end moves to current line end', () => {
    const next = applyKey(
      state('abc\ndef', 5),
      '',
      key({
        end: true,
      }),
    );
    expect(next.cursor).toBe(7);
  });
});

describe('applyKey: vertical navigation', () => {
  test('up arrow keeps the same column on the previous line', () => {
    // Cursor at column 2 of "ghi" (index 8): `abc\ndef\ngHi`
    const next = applyKey(
      state('abc\ndef\nghi', 10),
      '',
      key({
        upArrow: true,
      }),
    );
    // Should land on column 2 of "def" -> index 6 ('f').
    expect(next.cursor).toBe(6);
  });

  test('up arrow clamps to shorter line length', () => {
    // Cursor at column 4 of "world" (index 10): "hi\nworld"
    const next = applyKey(
      state('hi\nworld', 7),
      '',
      key({
        upArrow: true,
      }),
    );
    // Previous line "hi" only has length 2, so cursor clamps to column 2 -> index 2.
    expect(next.cursor).toBe(2);
  });

  test('up arrow at top line is a no-op', () => {
    const next = applyKey(
      state('abc', 1),
      '',
      key({
        upArrow: true,
      }),
    );
    expect(next.cursor).toBe(1);
  });

  test('down arrow keeps the same column on the next line', () => {
    // Cursor at column 2 of "abc" (index 2): `abC\ndef`
    const next = applyKey(
      state('abc\ndef', 2),
      '',
      key({
        downArrow: true,
      }),
    );
    // Should land on column 2 of "def" -> index 6.
    expect(next.cursor).toBe(6);
  });

  test('down arrow clamps to shorter line length', () => {
    // Cursor at column 4 of "world" (index 4): "world\nhi"
    const next = applyKey(
      state('world\nhi', 4),
      '',
      key({
        downArrow: true,
      }),
    );
    // Next line "hi" length 2, clamp to column 2 -> index 6+2 = 8.
    expect(next.cursor).toBe(8);
  });

  test('down arrow at last line is a no-op', () => {
    const next = applyKey(
      state('abc\ndef', 5),
      '',
      key({
        downArrow: true,
      }),
    );
    expect(next.cursor).toBe(5);
  });
});

describe('applyKey: parent-owned keys', () => {
  test('tab is a no-op so the parent can cycle focus', () => {
    const before = state('abc', 1);
    expect(
      applyKey(
        before,
        '',
        key({
          tab: true,
        }),
      ),
    ).toEqual(before);
  });

  test('escape is a no-op so the parent can cancel', () => {
    const before = state('abc', 1);
    expect(
      applyKey(
        before,
        '',
        key({
          escape: true,
        }),
      ),
    ).toEqual(before);
  });

  test('shift-tab is a no-op even with a printable input payload', () => {
    const before = state('abc', 1);
    expect(
      applyKey(
        before,
        '\t',
        key({
          tab: true,
          shift: true,
        }),
      ),
    ).toEqual(before);
  });
});
