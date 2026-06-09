/**
 * PreviewQuestionView — side-by-side layout when a single-select question has
 * at least one option with `preview` content. Left: option list; right:
 * rendered preview of the focused option.
 *
 * Ported from ~/Desktop/claude-code-main/src/components/permissions/AskUserQuestionPermissionRequest/PreviewQuestionView.tsx.
 */

import type { AskUserQuestion } from '@noetic-tools/core';
import { Box, Text, useInput } from 'ink';
import { useCallback, useState } from 'react';
import type { Option } from '../custom-select/index.js';
import { Select } from '../custom-select/index.js';
import { useTheme } from '../theme.js';
import { PreviewBox } from './preview-box.js';
import type { MultipleChoiceState } from './use-multiple-choice-state.js';

//#region Props

const OTHER_VALUE = '__other__';

export interface PreviewQuestionViewProps {
  readonly question: AskUserQuestion;
  readonly state: MultipleChoiceState;
  readonly onAnswer: (answer: string, preview?: string) => void;
  readonly onCancel: () => void;
  readonly onTabNext: () => void;
  readonly onTabPrev: () => void;
  /** Max preview lines; derived by the parent from terminal height. */
  readonly previewMaxLines: number;
}

//#endregion

//#region Helpers

function buildOptions(
  question: AskUserQuestion,
  setTextInputValue: (value: string) => void,
): ReadonlyArray<Option<string>> {
  const options: Array<Option<string>> = question.options.map((opt) => ({
    label: opt.label,
    description: opt.description,
    value: opt.label,
  }));
  options.push({
    type: 'input',
    label: 'Other',
    value: OTHER_VALUE,
    description: 'Free-text answer.',
    placeholder: 'Type your answer…',
    onChange: setTextInputValue,
  });
  return options;
}

//#endregion

//#region Component

export function PreviewQuestionView({
  question,
  state,
  onAnswer,
  onCancel,
  onTabNext,
  onTabPrev,
  previewMaxLines,
}: PreviewQuestionViewProps) {
  const theme = useTheme();
  const qState = state.questionStates[question.question];
  const [focusedLabel, setFocusedLabel] = useState<string>(
    typeof qState?.selectedValue === 'string'
      ? qState.selectedValue
      : (question.options[0]?.label ?? ''),
  );

  const focusedOption = question.options.find((opt) => opt.label === focusedLabel);
  const previewContent = focusedOption?.preview ?? '';

  useInput(
    (_input, key) => {
      if (state.isInTextInput) {
        return;
      }
      if (key.shift && key.tab) {
        onTabPrev();
        return;
      }
      if (key.tab) {
        onTabNext();
        return;
      }
      if (key.escape) {
        onCancel();
      }
    },
    {
      isActive: true,
    },
  );

  const options = buildOptions(question, (value) => {
    state.updateQuestionState(
      question.question,
      {
        textInputValue: value,
      },
      false,
    );
  });

  // Stable callbacks defend against the Select's focus-effect spuriously
  // re-firing on parent re-renders. The Select also has a fire-on-change ref
  // guard, but this is cheaper and clearer than relying on that alone.
  const handleSelectFocus = useCallback((value: string): void => {
    if (value !== OTHER_VALUE) {
      setFocusedLabel(value);
    }
  }, []);
  const handleSelectChange = useCallback(
    (value: string): void => {
      if (value === OTHER_VALUE) {
        const textValue = qState?.textInputValue ?? '';
        if (!textValue) {
          state.setTextInputMode(true);
          return;
        }
        onAnswer(textValue);
        return;
      }
      state.updateQuestionState(
        question.question,
        {
          selectedValue: value,
        },
        false,
      );
      const preview = question.options.find((opt) => opt.label === value)?.preview;
      onAnswer(value, preview);
    },
    [
      onAnswer,
      question,
      qState?.textInputValue,
      state,
    ],
  );

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color={theme.primary}>
          {question.header}
        </Text>
        <Text> </Text>
        <Text color={theme.foreground}>{question.question}</Text>
      </Box>

      <Box flexDirection="row">
        <Box flexDirection="column" width="40%" marginRight={2}>
          <Select
            options={options}
            defaultValue={
              typeof qState?.selectedValue === 'string' ? qState.selectedValue : undefined
            }
            isInTextInput={state.isInTextInput}
            onInputModeToggle={() => state.setTextInputMode(!state.isInTextInput)}
            onFocus={handleSelectFocus}
            onChange={handleSelectChange}
            onCancel={onCancel}
          />
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {previewContent ? (
            <PreviewBox content={previewContent} maxLines={previewMaxLines} />
          ) : (
            <Box borderStyle="single" borderColor={theme.muted} paddingX={1} flexDirection="column">
              <Text color={theme.muted}>(No preview for this option)</Text>
            </Box>
          )}
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.muted}>
          [↑/↓] navigate &nbsp; [Enter] select &nbsp; [Tab] next question &nbsp; [Esc] cancel
        </Text>
      </Box>
    </Box>
  );
}

//#endregion
