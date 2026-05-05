/**
 * Summary / submit screen — shown after the final question is answered. Lists
 * each question with its recorded answer and offers Submit, Cancel, or jump
 * back to a specific question for editing.
 *
 * Ported from ~/Desktop/claude-code-main/src/components/permissions/AskUserQuestionPermissionRequest/SubmitQuestionsView.tsx.
 */

import type { AskUserInput } from '@noetic/core';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../theme.js';
import type { MultipleChoiceState } from './use-multiple-choice-state.js';

//#region Props

export interface SubmitQuestionsViewProps {
  readonly input: AskUserInput;
  readonly state: MultipleChoiceState;
  readonly isPlanMode: boolean;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
  readonly onEdit: (questionIndex: number) => void;
  readonly onFinishPlanInterview: () => void;
  /**
   * Optional warning surfaced under the action row — e.g. when the user
   * presses Submit while one or more answers are still missing.
   */
  readonly hint?: string;
}

//#endregion

//#region Component

export function SubmitQuestionsView({
  input,
  state,
  isPlanMode,
  onSubmit,
  onCancel,
  onEdit,
  onFinishPlanInterview,
  hint,
}: SubmitQuestionsViewProps) {
  const theme = useTheme();

  useInput((input_, key) => {
    if (key.return || input_ === 'y' || input_ === 'Y') {
      onSubmit();
      return;
    }
    if (key.escape || input_ === 'n' || input_ === 'N') {
      onCancel();
      return;
    }
    // F is only meaningful in plan mode. Outside plan mode, ignore quietly so
    // a stray keystroke doesn't appear to do something invisible.
    if ((input_ === 'f' || input_ === 'F') && isPlanMode) {
      onFinishPlanInterview();
      return;
    }
    if (/^[1-9]$/.test(input_)) {
      const idx = Number.parseInt(input_, 10) - 1;
      if (idx >= 0 && idx < input.questions.length) {
        onEdit(idx);
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color={theme.primary}>
          Review your answers
        </Text>
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        {input.questions.map((q, index) => {
          const answer = state.answers[q.question] ?? '';
          const answered = answer.length > 0;
          return (
            <Box key={q.question} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={theme.muted}>{index + 1}. </Text>
                <Text bold color={theme.secondary}>
                  {q.header}
                </Text>
                <Text color={theme.foreground}> — {q.question}</Text>
              </Box>
              <Box paddingLeft={3}>
                <Text color={answered ? theme.success : theme.error}>
                  {answered ? answer : '(unanswered)'}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>

      <Box>
        <Text color={theme.success}>[Y/Enter] Submit</Text>
        <Text>{'  '}</Text>
        <Text color={theme.error}>[N/Esc] Cancel</Text>
        <Text>{'  '}</Text>
        <Text color={theme.muted}>[1–{input.questions.length}] Edit</Text>
        {isPlanMode ? (
          <>
            <Text>{'  '}</Text>
            <Text color={theme.accent}>[F] Finish interview</Text>
          </>
        ) : null}
      </Box>

      {hint ? (
        <Box marginTop={1}>
          <Text color={theme.warning}>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

//#endregion
