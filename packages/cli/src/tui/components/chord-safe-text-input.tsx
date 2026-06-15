/**
 * Chord-safe drop-in replacement for `ink-text-input`.
 *
 * Why this exists: `ink-text-input`'s own `useInput` registers deeper in the
 * tree than any of our app-level chord handlers (Ctrl+W, Ctrl+O, Ctrl+R), so
 * it fires FIRST on every keystroke. Its filter list only ignores arrows,
 * Tab, and Ctrl+C — every other Ctrl+<letter> chord is written to the buffer
 * as the bare letter. That means pressing Ctrl+W to swap focus also leaves a
 * stray `w` in the prompt before our handler ever runs. No amount of `focus`
 * gating fixes this, because the value is committed before React can
 * re-render with the gate disabled.
 *
 * The behaviour we want is simple and uncontroversial: a chord like
 * `Ctrl+<letter>` is never a typed character — drop it entirely. We
 * re-implement just enough of ink-text-input's cursor/keystroke logic to do
 * that. Everything else (cursor rendering, placeholder, mask, onSubmit) is
 * identical to the upstream component.
 */

import chalk from 'chalk';
import { Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

//#region Types

export interface ChordSafeTextInputProps {
  value: string;
  placeholder?: string;
  focus?: boolean;
  mask?: string;
  showCursor?: boolean;
  highlightPastedText?: boolean;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
}

//#endregion

//#region Helpers

interface KeyState {
  ctrl?: boolean;
  shift?: boolean;
  return?: boolean;
  tab?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

/**
 * Returns `true` for every keystroke the chord-safe input ignores entirely.
 * Anything that returns `true` must not advance the cursor or mutate the
 * value. Upstream ink-text-input ignores arrows/Tab/Ctrl+C; we add the whole
 * Ctrl+<single char> family — none of those are typed text, and at least one
 * (Ctrl+W) is bound as an app-level chord.
 */
function isIgnoredKey(key: KeyState): boolean {
  if (key.upArrow || key.downArrow || key.tab) {
    return true;
  }
  if (key.shift && key.tab) {
    return true;
  }
  if (key.ctrl) {
    return true;
  }
  return false;
}

interface NextStateArgs {
  input: string;
  key: KeyState;
  originalValue: string;
  cursorOffset: number;
  showCursor: boolean;
}

interface NextStateResult {
  nextValue: string;
  nextCursorOffset: number;
  nextCursorWidth: number;
}

/**
 * Pure cursor / buffer reducer. Returns the next value, cursor offset, and
 * paste-highlight width given a non-ignored key. The result is clamped to
 * `[0, originalValue.length]` so the caller doesn't have to.
 */
function computeNextState(args: NextStateArgs): NextStateResult {
  const { input, key, originalValue, cursorOffset, showCursor } = args;
  let nextValue = originalValue;
  let nextCursorOffset = cursorOffset;
  let nextCursorWidth = 0;

  if (key.leftArrow) {
    if (showCursor) {
      nextCursorOffset--;
    }
  } else if (key.rightArrow) {
    if (showCursor) {
      nextCursorOffset++;
    }
  } else if (key.backspace || key.delete) {
    if (cursorOffset > 0) {
      nextValue =
        originalValue.slice(0, cursorOffset - 1) +
        originalValue.slice(cursorOffset, originalValue.length);
      nextCursorOffset--;
    }
  } else {
    nextValue =
      originalValue.slice(0, cursorOffset) +
      input +
      originalValue.slice(cursorOffset, originalValue.length);
    nextCursorOffset += input.length;
    if (input.length > 1) {
      nextCursorWidth = input.length;
    }
  }

  if (nextCursorOffset < 0) {
    nextCursorOffset = 0;
  }
  if (nextCursorOffset > nextValue.length) {
    nextCursorOffset = nextValue.length;
  }

  return {
    nextValue,
    nextCursorOffset,
    nextCursorWidth,
  };
}

/**
 * Renders a single line of text with the cursor (and any paste-highlight
 * range) inverted. Returns the rendered string; the caller wraps it in
 * `<Text>`.
 */
function renderWithCursor(value: string, cursorOffset: number, cursorActualWidth: number): string {
  if (value.length === 0) {
    return chalk.inverse(' ');
  }
  let out = '';
  let i = 0;
  for (const char of value) {
    out += i >= cursorOffset - cursorActualWidth && i <= cursorOffset ? chalk.inverse(char) : char;
    i++;
  }
  if (cursorOffset === value.length) {
    out += chalk.inverse(' ');
  }
  return out;
}

//#endregion

//#region Component

export function ChordSafeTextInput(props: ChordSafeTextInputProps): ReactNode {
  const {
    value: originalValue,
    placeholder = '',
    focus = true,
    mask,
    showCursor = true,
    highlightPastedText = false,
    onChange,
    onSubmit,
  } = props;

  const [state, setState] = useState({
    cursorOffset: (originalValue || '').length,
    cursorWidth: 0,
  });
  const { cursorOffset, cursorWidth } = state;

  useEffect(() => {
    setState((prev) => {
      if (!focus || !showCursor) {
        return prev;
      }
      const v = originalValue || '';
      if (prev.cursorOffset > v.length - 1) {
        return {
          cursorOffset: v.length,
          cursorWidth: 0,
        };
      }
      return prev;
    });
  }, [
    originalValue,
    focus,
    showCursor,
  ]);

  const cursorActualWidth = highlightPastedText ? cursorWidth : 0;
  const value = mask ? mask.repeat(originalValue.length) : originalValue;
  let renderedValue = value;
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;

  if (showCursor && focus) {
    renderedPlaceholder =
      placeholder.length > 0
        ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
        : chalk.inverse(' ');
    renderedValue = renderWithCursor(value, cursorOffset, cursorActualWidth);
  }

  useInput(
    (input, key) => {
      if (isIgnoredKey(key)) {
        return;
      }
      if (key.return) {
        if (onSubmit) {
          onSubmit(originalValue);
        }
        return;
      }
      const result = computeNextState({
        input,
        key,
        originalValue,
        cursorOffset,
        showCursor,
      });
      setState({
        cursorOffset: result.nextCursorOffset,
        cursorWidth: result.nextCursorWidth,
      });
      if (result.nextValue !== originalValue) {
        onChange(result.nextValue);
      }
    },
    {
      isActive: focus,
    },
  );

  return (
    <Text>
      {placeholder ? (value.length > 0 ? renderedValue : renderedPlaceholder) : renderedValue}
    </Text>
  );
}

//#endregion
