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

/**
 * Subset of ink's `Key` shape that the chord-safe input cares about. Exported
 * so the predicate / reducer pure helpers below are testable in isolation
 * (the upstream `Key` carries fields we never read).
 */
export interface ChordSafeKey {
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
 * Matches the body of a single SGR mouse-event escape (the ESC prefix has
 * already been stripped by ink's parseKeypress by the time we see this).
 * Form: `[<Cb;Cx;Cy(M|m)`. Allow the rest of the chunk to contain anything
 * — repeated mouse events arrive concatenated under fast scrolling.
 */
const SGR_MOUSE_REMNANT_RE = /^\[<\d+;\d+;\d+[Mm]/;

/**
 * Some inputs are not typed text and must never reach the buffer even though
 * ink's parseKeypress happily passes them through:
 *
 *  - Ctrl/Alt-modified single chars (handled by `isIgnoredKey` via `key.ctrl`)
 *  - SGR mouse-event remnants. Mouse reporting is on for the chat viewport
 *    (see `interrupt-safety-net.ts`); ink can't parse SGR mouse and falls
 *    through with `input` set to the bare CSI body. Under a real mouse this
 *    would flood the prompt with `[<64;…M` strings (see issue thread).
 *
 * Kept as a single helper so the predicate is testable and the call site in
 * the useInput callback stays trivial.
 */
export function isNonTypedInput(input: string): boolean {
  return SGR_MOUSE_REMNANT_RE.test(input);
}

/**
 * Returns `true` for every keystroke the chord-safe input ignores entirely.
 * Anything that returns `true` must not advance the cursor or mutate the
 * value. Upstream ink-text-input ignores arrows/Tab/Ctrl+C; we add the whole
 * Ctrl+<single char> family — none of those are typed text, and at least one
 * (Ctrl+W) is bound as an app-level chord.
 */
export function isIgnoredKey(key: ChordSafeKey): boolean {
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

export interface ChordSafeNextStateArgs {
  input: string;
  key: ChordSafeKey;
  originalValue: string;
  cursorOffset: number;
  showCursor: boolean;
}

export interface ChordSafeNextStateResult {
  nextValue: string;
  nextCursorOffset: number;
  nextCursorWidth: number;
}

/** Cursor-only mutation: arrow keys move the caret if `showCursor` is on. */
function applyCursorMove(key: ChordSafeKey, cursorOffset: number, showCursor: boolean): number {
  if (!showCursor) {
    return cursorOffset;
  }
  if (key.leftArrow) {
    return cursorOffset - 1;
  }
  if (key.rightArrow) {
    return cursorOffset + 1;
  }
  return cursorOffset;
}

/** Buffer + cursor mutation for backspace / delete (treated identically,
 *  matching upstream ink-text-input). */
function applyBackspace(
  originalValue: string,
  cursorOffset: number,
): {
  nextValue: string;
  nextCursorOffset: number;
} {
  if (cursorOffset <= 0) {
    return {
      nextValue: originalValue,
      nextCursorOffset: cursorOffset,
    };
  }
  return {
    nextValue:
      originalValue.slice(0, cursorOffset - 1) +
      originalValue.slice(cursorOffset, originalValue.length),
    nextCursorOffset: cursorOffset - 1,
  };
}

/** Buffer + cursor mutation for an insert (typed text, paste). Returns the
 *  paste-highlight width so the caller can flag multi-char inserts. */
function applyInsert(
  originalValue: string,
  input: string,
  cursorOffset: number,
): {
  nextValue: string;
  nextCursorOffset: number;
  nextCursorWidth: number;
} {
  const nextValue =
    originalValue.slice(0, cursorOffset) +
    input +
    originalValue.slice(cursorOffset, originalValue.length);
  return {
    nextValue,
    nextCursorOffset: cursorOffset + input.length,
    nextCursorWidth: input.length > 1 ? input.length : 0,
  };
}

function clampCursor(offset: number, valueLength: number): number {
  if (offset < 0) {
    return 0;
  }
  if (offset > valueLength) {
    return valueLength;
  }
  return offset;
}

/**
 * Pure cursor / buffer reducer. Returns the next value, cursor offset, and
 * paste-highlight width given a non-ignored key. The result is clamped to
 * `[0, originalValue.length]` so the caller doesn't have to.
 */
export function computeNextState(args: ChordSafeNextStateArgs): ChordSafeNextStateResult {
  const { input, key, originalValue, cursorOffset, showCursor } = args;
  if (key.leftArrow || key.rightArrow) {
    const nextCursorOffset = clampCursor(
      applyCursorMove(key, cursorOffset, showCursor),
      originalValue.length,
    );
    return {
      nextValue: originalValue,
      nextCursorOffset,
      nextCursorWidth: 0,
    };
  }
  if (key.backspace || key.delete) {
    const { nextValue, nextCursorOffset } = applyBackspace(originalValue, cursorOffset);
    return {
      nextValue,
      nextCursorOffset: clampCursor(nextCursorOffset, nextValue.length),
      nextCursorWidth: 0,
    };
  }
  const inserted = applyInsert(originalValue, input, cursorOffset);
  return {
    nextValue: inserted.nextValue,
    nextCursorOffset: clampCursor(inserted.nextCursorOffset, inserted.nextValue.length),
    nextCursorWidth: inserted.nextCursorWidth,
  };
}

/**
 * Renders a single line of text with the cursor (and any paste-highlight
 * range) inverted. Returns the rendered string; the caller wraps it in
 * `<Text>`.
 *
 * Implemented as three slices + one `chalk.inverse` call so the cost is
 * O(1) in `value.length` (string slicing is a memcpy under the hood, not
 * a per-character walk). The previous loop allocated a new string and
 * called `chalk.inverse` per character — a measurable per-keystroke
 * regression once buffers got past a few dozen chars.
 *
 * Caveat: this indexes by UTF-16 code units. `cursorOffset` already
 * counts code units (it's incremented by `input.length`), so for ASCII
 * and any composed-codepoint text we match the previous behaviour. A
 * cursor that lands on a surrogate-pair boundary will look mid-grapheme,
 * which is the same edge case the upstream `ink-text-input` ships with.
 */
function renderWithCursor(value: string, cursorOffset: number, cursorActualWidth: number): string {
  if (value.length === 0) {
    return chalk.inverse(' ');
  }
  // Cursor at end-of-buffer: render the buffer verbatim and tack on an
  // inverted space.
  if (cursorOffset >= value.length) {
    return value + chalk.inverse(' ');
  }
  // Mid-buffer cursor: slice into [before][highlight][after] and inverse
  // just the highlight range. For typed input `cursorActualWidth === 0`
  // so the range is a single character.
  const rangeStart = Math.max(0, cursorOffset - cursorActualWidth);
  const rangeEnd = cursorOffset + 1;
  const before = value.slice(0, rangeStart);
  const highlight = value.slice(rangeStart, rangeEnd);
  const after = value.slice(rangeEnd);
  return before + chalk.inverse(highlight) + after;
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
      if (isIgnoredKey(key) || isNonTypedInput(input)) {
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
