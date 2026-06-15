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
    renderedValue = value.length > 0 ? '' : chalk.inverse(' ');
    let i = 0;
    for (const char of value) {
      renderedValue +=
        i >= cursorOffset - cursorActualWidth && i <= cursorOffset ? chalk.inverse(char) : char;
      i++;
    }
    if (value.length > 0 && cursorOffset === value.length) {
      renderedValue += chalk.inverse(' ');
    }
  }

  useInput(
    (input, key) => {
      // Upstream ignores arrows, Tab, and Ctrl+C. We add the entire
      // Ctrl+<single char> family — none of those are ever typed text in a
      // chat prompt, and at least one (Ctrl+W) is bound as an app-level chord
      // we must not double-handle.
      if (key.upArrow || key.downArrow || key.tab || (key.shift && key.tab)) {
        return;
      }
      if (key.ctrl) {
        return;
      }

      if (key.return) {
        if (onSubmit) {
          onSubmit(originalValue);
        }
        return;
      }

      let nextCursorOffset = cursorOffset;
      let nextValue = originalValue;
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

      if (cursorOffset < 0) {
        nextCursorOffset = 0;
      }
      if (cursorOffset > originalValue.length) {
        nextCursorOffset = originalValue.length;
      }

      setState({
        cursorOffset: nextCursorOffset,
        cursorWidth: nextCursorWidth,
      });

      if (nextValue !== originalValue) {
        onChange(nextValue);
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
