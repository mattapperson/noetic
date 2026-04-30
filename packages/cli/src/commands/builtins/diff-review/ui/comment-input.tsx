/**
 * Modal: capture a comment body for the active line/range/file.
 *
 * Single-line entry with newline-on-Shift+Enter via `\n` insertion. Enter on a
 * non-empty body submits; Esc cancels.
 */

import { Box, Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { useTheme } from '../../../../tui/components/theme.js';
import type { ReviewFile } from '../types.js';
import { CommentSide } from '../types.js';
import type { PendingComment } from './state.js';

//#region Props

export interface CommentInputProps {
  pending: PendingComment;
  file: ReviewFile;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}

//#endregion

//#region Helpers

function formatRange(pending: PendingComment): string {
  if (pending.side === CommentSide.File || pending.startLine === null) {
    return 'file-level comment';
  }
  if (pending.endLine !== null && pending.endLine !== pending.startLine) {
    return `lines ${pending.startLine}-${pending.endLine}`;
  }
  return `line ${pending.startLine}`;
}

function sideLabel(pending: PendingComment): string {
  if (pending.side === CommentSide.Original) {
    return ' (old)';
  }
  if (pending.side === CommentSide.Modified) {
    return ' (new)';
  }
  return '';
}

//#endregion

//#region Component

export function CommentInput({ pending, file, onSubmit, onCancel }: CommentInputProps): ReactNode {
  const theme = useTheme();
  const [body, setBody] = useState('');

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      const trimmed = body.trim();
      if (trimmed.length === 0) {
        return;
      }
      onSubmit(body);
      return;
    }
    if (key.backspace || key.delete) {
      setBody((prev) => prev.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta) {
      return;
    }
    if (input.length > 0) {
      setBody((prev) => prev + input);
    }
  });

  const filePath = file.gitDiff?.displayPath ?? file.path;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.primary}
      paddingX={1}
      paddingY={0}
    >
      <Text bold color={theme.primary}>
        Add comment
      </Text>
      <Text dimColor>
        {filePath} — {formatRange(pending)}
        {sideLabel(pending)}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.foreground}>{body || ' '}</Text>
        <Text color={theme.muted}>█</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Enter to save · Esc to cancel</Text>
      </Box>
    </Box>
  );
}

//#endregion
