import { describe, expect, test } from 'bun:test';
import type { KeyBinding, KeyEvent } from '../../src/tui/keybindings/match-binding.js';
import { matchBinding } from '../../src/tui/keybindings/match-binding.js';

const PLAIN: KeyEvent = {
  input: '',
  escape: false,
  ctrl: false,
  shift: false,
  meta: false,
  return: false,
  tab: false,
  backspace: false,
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  delete: false,
};

function event(overrides: Partial<KeyEvent>): KeyEvent {
  return {
    ...PLAIN,
    ...overrides,
  };
}

describe('matchBinding', () => {
  test('plain escape matches escape binding', () => {
    const binding: KeyBinding = {
      key: 'escape',
    };
    expect(
      matchBinding(
        event({
          escape: true,
        }),
        binding,
      ),
    ).toBe(true);
  });

  test('Ctrl+C matches { key: "c", ctrl: true }', () => {
    const binding: KeyBinding = {
      key: 'c',
      ctrl: true,
    };
    expect(
      matchBinding(
        event({
          input: 'c',
          ctrl: true,
        }),
        binding,
      ),
    ).toBe(true);
  });

  test('plain c does NOT match { key: "c", ctrl: true }', () => {
    const binding: KeyBinding = {
      key: 'c',
      ctrl: true,
    };
    expect(
      matchBinding(
        event({
          input: 'c',
        }),
        binding,
      ),
    ).toBe(false);
  });

  test('Ctrl+C does NOT match { key: "c" } (no modifier expected)', () => {
    const binding: KeyBinding = {
      key: 'c',
    };
    expect(
      matchBinding(
        event({
          input: 'c',
          ctrl: true,
        }),
        binding,
      ),
    ).toBe(false);
  });

  test('Ctrl+Shift+X matches { key: "x", ctrl: true, shift: true }', () => {
    const binding: KeyBinding = {
      key: 'x',
      ctrl: true,
      shift: true,
    };
    expect(
      matchBinding(
        event({
          input: 'x',
          ctrl: true,
          shift: true,
        }),
        binding,
      ),
    ).toBe(true);
  });

  test('Ctrl+X does NOT match { key: "x", ctrl: true, shift: true }', () => {
    const binding: KeyBinding = {
      key: 'x',
      ctrl: true,
      shift: true,
    };
    expect(
      matchBinding(
        event({
          input: 'x',
          ctrl: true,
        }),
        binding,
      ),
    ).toBe(false);
  });

  test('Tab matches { key: "tab" }', () => {
    expect(
      matchBinding(
        event({
          tab: true,
        }),
        {
          key: 'tab',
        },
      ),
    ).toBe(true);
  });

  test('Shift+Tab matches { key: "tab", shift: true }', () => {
    expect(
      matchBinding(
        event({
          tab: true,
          shift: true,
        }),
        {
          key: 'tab',
          shift: true,
        },
      ),
    ).toBe(true);
  });

  test('arrow keys match named bindings', () => {
    expect(
      matchBinding(
        event({
          upArrow: true,
        }),
        {
          key: 'up',
        },
      ),
    ).toBe(true);
    expect(
      matchBinding(
        event({
          downArrow: true,
        }),
        {
          key: 'down',
        },
      ),
    ).toBe(true);
    expect(
      matchBinding(
        event({
          leftArrow: true,
        }),
        {
          key: 'left',
        },
      ),
    ).toBe(true);
    expect(
      matchBinding(
        event({
          rightArrow: true,
        }),
        {
          key: 'right',
        },
      ),
    ).toBe(true);
  });

  test('return matches enter binding', () => {
    expect(
      matchBinding(
        event({
          return: true,
        }),
        {
          key: 'enter',
        },
      ),
    ).toBe(true);
  });

  test('backspace matches { key: "backspace" }', () => {
    expect(
      matchBinding(
        event({
          backspace: true,
        }),
        {
          key: 'backspace',
        },
      ),
    ).toBe(true);
  });

  test('plain letter matches case-insensitively when no modifiers required', () => {
    expect(
      matchBinding(
        event({
          input: 'A',
        }),
        {
          key: 'a',
        },
      ),
    ).toBe(true);
    expect(
      matchBinding(
        event({
          input: 'a',
        }),
        {
          key: 'A',
        },
      ),
    ).toBe(true);
  });

  test('ctrl: false explicitly rejects ctrl press', () => {
    const binding: KeyBinding = {
      key: 'c',
      ctrl: false,
    };
    expect(
      matchBinding(
        event({
          input: 'c',
          ctrl: true,
        }),
        binding,
      ),
    ).toBe(false);
    expect(
      matchBinding(
        event({
          input: 'c',
        }),
        binding,
      ),
    ).toBe(true);
  });
});
