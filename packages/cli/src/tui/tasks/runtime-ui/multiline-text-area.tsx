/**
 * Minimal multiline text input for Ink. Treats Enter as a newline insertion
 * (not as submit) so the surrounding form can own its own submit affordance.
 *
 * The cursor/text state machine is exposed as a pure `applyKey` reducer so
 * it can be unit-tested without rendering. Tab and Esc are deliberately
 * pass-through — they bubble up so the parent form can still cycle focus
 * and cancel.
 */

import type { Key } from 'ink';
import { Box, Text, useInput } from 'ink';
import type React from 'react';
import { useState } from 'react';

import { useTheme } from '../../components/theme.js';

//#region Types

export interface MultilineTextAreaProps {
  value: string;
  onChange: (next: string) => void;
  focus: boolean;
  placeholder?: string;
}

export interface EditorState {
  value: string;
  cursor: number;
}

interface LineBounds {
  lineStart: number;
  lineEnd: number;
  column: number;
}

//#endregion

//#region Pure helpers

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function lineBounds(value: string, cursor: number): LineBounds {
  const lineStart = value.lastIndexOf('\n', cursor - 1) + 1;
  const nextNewline = value.indexOf('\n', cursor);
  const lineEnd = nextNewline === -1 ? value.length : nextNewline;
  return {
    lineStart,
    lineEnd,
    column: cursor - lineStart,
  };
}

function moveVertical(value: string, cursor: number, direction: -1 | 1): number {
  const { lineStart, lineEnd, column } = lineBounds(value, cursor);
  if (direction === -1) {
    if (lineStart === 0) {
      return cursor;
    }
    const prevEnd = lineStart - 1;
    const prevStart = value.lastIndexOf('\n', prevEnd - 1) + 1;
    const prevColumn = clamp(column, 0, prevEnd - prevStart);
    return prevStart + prevColumn;
  }
  if (lineEnd === value.length) {
    return cursor;
  }
  const nextStart = lineEnd + 1;
  const followingNewline = value.indexOf('\n', nextStart);
  const nextEnd = followingNewline === -1 ? value.length : followingNewline;
  const nextColumn = clamp(column, 0, nextEnd - nextStart);
  return nextStart + nextColumn;
}

function insert(state: EditorState, str: string): EditorState {
  const before = state.value.slice(0, state.cursor);
  const after = state.value.slice(state.cursor);
  return {
    value: before + str + after,
    cursor: state.cursor + str.length,
  };
}

//#endregion

//#region Reducer

/**
 * Compute the next editor state from the current one and an Ink key event.
 * Returns the input state unchanged for keys the parent owns (Tab, Esc) and
 * for modifier-augmented inputs (Ctrl/Meta/Super shortcuts).
 */
export function applyKey(state: EditorState, input: string, key: Key): EditorState {
  if (key.tab || key.escape) {
    return state;
  }
  if (key.ctrl || key.meta || key.super) {
    return state;
  }
  if (key.return) {
    return insert(state, '\n');
  }
  if (key.backspace) {
    if (state.cursor === 0) {
      return state;
    }
    const before = state.value.slice(0, state.cursor - 1);
    const after = state.value.slice(state.cursor);
    return {
      value: before + after,
      cursor: state.cursor - 1,
    };
  }
  if (key.delete) {
    if (state.cursor === state.value.length) {
      return state;
    }
    const before = state.value.slice(0, state.cursor);
    const after = state.value.slice(state.cursor + 1);
    return {
      value: before + after,
      cursor: state.cursor,
    };
  }
  if (key.leftArrow) {
    return {
      value: state.value,
      cursor: clamp(state.cursor - 1, 0, state.value.length),
    };
  }
  if (key.rightArrow) {
    return {
      value: state.value,
      cursor: clamp(state.cursor + 1, 0, state.value.length),
    };
  }
  if (key.upArrow) {
    return {
      value: state.value,
      cursor: moveVertical(state.value, state.cursor, -1),
    };
  }
  if (key.downArrow) {
    return {
      value: state.value,
      cursor: moveVertical(state.value, state.cursor, 1),
    };
  }
  if (key.home) {
    const { lineStart } = lineBounds(state.value, state.cursor);
    return {
      value: state.value,
      cursor: lineStart,
    };
  }
  if (key.end) {
    const { lineEnd } = lineBounds(state.value, state.cursor);
    return {
      value: state.value,
      cursor: lineEnd,
    };
  }
  if (input.length === 0) {
    return state;
  }
  return insert(state, input);
}

//#endregion

//#region Component

interface LineRowProps {
  line: string;
  cursorColumn: number | null;
}

function LineRow(props: LineRowProps): React.ReactElement {
  if (props.cursorColumn === null) {
    return <Text>{props.line.length === 0 ? ' ' : props.line}</Text>;
  }
  const before = props.line.slice(0, props.cursorColumn);
  const at = props.line.slice(props.cursorColumn, props.cursorColumn + 1);
  const after = props.line.slice(props.cursorColumn + 1);
  const cursorChar = at.length === 0 ? ' ' : at;
  return (
    <Text>
      {before}
      <Text inverse>{cursorChar}</Text>
      {after}
    </Text>
  );
}

export function MultilineTextArea(props: MultilineTextAreaProps): React.ReactElement {
  const theme = useTheme();
  const [cursor, setCursor] = useState<number>(props.value.length);

  const safeCursor = clamp(cursor, 0, props.value.length);

  useInput(
    (input, key) => {
      const next = applyKey(
        {
          value: props.value,
          cursor: safeCursor,
        },
        input,
        key,
      );
      if (next.value !== props.value) {
        props.onChange(next.value);
      }
      if (next.cursor !== safeCursor) {
        setCursor(next.cursor);
      }
    },
    {
      isActive: props.focus,
    },
  );

  if (props.value.length === 0 && !props.focus && props.placeholder !== undefined) {
    return (
      <Box flexDirection="column">
        <Text color={theme.placeholder}>{props.placeholder}</Text>
      </Box>
    );
  }

  // Empty + focused: render a single inverse-space cursor row.
  if (props.value.length === 0) {
    return (
      <Box flexDirection="column">
        <LineRow line="" cursorColumn={0} />
      </Box>
    );
  }

  const lines = props.value.split('\n');
  let runningIndex = 0;
  const rows = lines.map((line) => {
    const lineStart = runningIndex;
    const lineEnd = lineStart + line.length;
    runningIndex = lineEnd + 1;
    const cursorOnLine = props.focus && safeCursor >= lineStart && safeCursor <= lineEnd;
    return {
      key: `offset-${lineStart}`,
      line,
      cursorColumn: cursorOnLine ? safeCursor - lineStart : null,
    };
  });
  return (
    <Box flexDirection="column">
      {rows.map((row) => (
        <LineRow key={row.key} line={row.line} cursorColumn={row.cursorColumn} />
      ))}
    </Box>
  );
}

//#endregion
