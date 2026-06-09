/**
 * Bottom strip showing comment count + overall comment preview, and the
 * inline editor when the user has opened the overall-comment composer.
 */

import { Box, Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { useTheme } from '../../components/theme.js';

//#region Strip

export interface CommentsStripProps {
  commentCount: number;
  overallComment: string;
}

export function CommentsStrip({ commentCount, overallComment }: CommentsStripProps): ReactNode {
  const theme = useTheme();
  const overallPreview = overallComment.trim().slice(0, 60) || '(none)';
  return (
    <Box paddingX={1}>
      <Text color={theme.warning}>comments({commentCount})</Text>
      <Text dimColor>
        {'  '}overall: {overallPreview}
      </Text>
    </Box>
  );
}

//#endregion

//#region Editor modal

export interface OverallCommentEditorProps {
  initial: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function OverallCommentEditor({
  initial,
  onSubmit,
  onCancel,
}: OverallCommentEditorProps): ReactNode {
  const theme = useTheme();
  const [body, setBody] = useState(initial);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
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

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.primary}
      paddingX={1}
      paddingY={0}
    >
      <Text bold color={theme.primary}>
        Overall comment
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
