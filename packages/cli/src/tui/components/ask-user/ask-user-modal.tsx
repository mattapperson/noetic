/**
 * AskUserModal — root wrapper for the ask-user tool UI.
 *
 * Owns the multi-question state reducer and dispatches to `QuestionView` /
 * `PreviewQuestionView` for each question, then `SubmitQuestionsView` for the
 * review step. Resolves the parent's promise via `onSubmit` / `onCancel`.
 *
 * Ported from ~/Desktop/claude-code-main/src/components/permissions/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.tsx.
 */

import type {
  AskUserAnnotation,
  AskUserInput,
  AskUserOutput,
  AskUserQuestion,
} from '@noetic-tools/core';
import { Box, Text, useStdout } from 'ink';
import { useMemo, useState } from 'react';
import { useTheme } from '../theme.js';
import { PreviewQuestionView } from './preview-question-view.js';
import { QuestionNavigationBar } from './question-navigation-bar.js';
import { QuestionView } from './question-view.js';
import { SubmitQuestionsView } from './submit-questions-view.js';
import { useMultipleChoiceState } from './use-multiple-choice-state.js';

//#region Props

export interface AskUserModalProps {
  readonly input: AskUserInput;
  readonly isPlanMode: boolean;
  readonly onSubmit: (output: AskUserOutput) => void;
  readonly onCancel: (reason: string) => void;
  readonly onFinishPlanInterview: () => void;
}

//#endregion

//#region Helpers

function questionNeedsPreview(q: AskUserQuestion): boolean {
  if (q.multiSelect) {
    return false;
  }
  return q.options.some((opt) => opt.preview !== undefined && opt.preview.length > 0);
}

function buildOutput(
  input: AskUserInput,
  answers: Readonly<Record<string, string>>,
  annotations: Readonly<
    Record<
      string,
      {
        preview?: string;
        notes?: string;
      }
    >
  >,
): AskUserOutput {
  const collected: Record<string, string> = {};
  const annotationOut: Record<string, AskUserAnnotation> = {};
  for (const q of input.questions) {
    collected[q.question] = answers[q.question] ?? '';
    const ann = annotations[q.question];
    if (ann && (ann.preview !== undefined || ann.notes !== undefined)) {
      annotationOut[q.question] = ann;
    }
  }
  const hasAnnotations = Object.keys(annotationOut).length > 0;
  return {
    answers: collected,
    ...(hasAnnotations
      ? {
          annotations: annotationOut,
        }
      : {}),
  };
}

//#endregion

//#region Component

export function AskUserModal({
  input,
  isPlanMode,
  onSubmit,
  onCancel,
  onFinishPlanInterview,
}: AskUserModalProps) {
  const theme = useTheme();
  const state = useMultipleChoiceState();
  const { stdout } = useStdout();

  const totalQuestions = input.questions.length;
  const showSubmit = state.currentQuestionIndex >= totalQuestions;

  const tabs = useMemo(
    () =>
      input.questions.map((q) => ({
        header: q.header,
        answered: (state.answers[q.question] ?? '').length > 0,
      })),
    [
      input.questions,
      state.answers,
    ],
  );

  const currentQuestion = input.questions[state.currentQuestionIndex];
  const previewMaxLines = Math.max(6, Math.min(24, (stdout?.rows ?? 24) - 12));

  const handleAnswer = (answer: string, preview?: string): void => {
    if (!currentQuestion) {
      return;
    }
    state.setAnswer(currentQuestion.question, answer, {
      preview,
      shouldAdvance: true,
    });
  };

  const handleCancel = (): void => {
    onCancel('user cancelled the ask-user dialog');
  };

  const [submitHint, setSubmitHint] = useState<string | undefined>(undefined);

  const handleSubmit = (): void => {
    const firstUnanswered = input.questions.findIndex(
      (q) => (state.answers[q.question] ?? '').length === 0,
    );
    if (firstUnanswered !== -1) {
      const target = input.questions[firstUnanswered];
      // Surface a visible warning AND jump back to the offending question
      // so the user isn't left wondering why Submit silently no-op'd.
      setSubmitHint(
        `Question ${firstUnanswered + 1} (${target?.header ?? ''}) is unanswered — jumping back.`,
      );
      state.jumpToQuestion(firstUnanswered);
      return;
    }
    setSubmitHint(undefined);
    onSubmit(buildOutput(input, state.answers, state.annotations));
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.primary} padding={1}>
      <QuestionNavigationBar
        tabs={tabs}
        currentIndex={Math.min(state.currentQuestionIndex, totalQuestions - 1)}
      />

      <Box marginY={1}>
        <Text color={theme.muted}>────────────────────────────────────────────</Text>
      </Box>

      {showSubmit || !currentQuestion ? (
        <SubmitQuestionsView
          input={input}
          state={state}
          isPlanMode={isPlanMode}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          onEdit={(index) => state.jumpToQuestion(index)}
          onFinishPlanInterview={onFinishPlanInterview}
          hint={submitHint}
        />
      ) : questionNeedsPreview(currentQuestion) ? (
        <PreviewQuestionView
          question={currentQuestion}
          state={state}
          onAnswer={handleAnswer}
          onCancel={handleCancel}
          onTabNext={state.nextQuestion}
          onTabPrev={state.prevQuestion}
          previewMaxLines={previewMaxLines}
        />
      ) : (
        <QuestionView
          question={currentQuestion}
          state={state}
          onAnswer={handleAnswer}
          onCancel={handleCancel}
          onTabNext={state.nextQuestion}
          onTabPrev={state.prevQuestion}
        />
      )}
    </Box>
  );
}

//#endregion
