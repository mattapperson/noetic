/**
 * QuestionView — renders a single question with its options, an automatic
 * "Other" free-text option, and multi-select support. Used when no option has
 * `preview` content — the preview-aware variant lives in
 * `preview-question-view.tsx`.
 *
 * Ported from ~/Desktop/claude-code-main/src/components/permissions/AskUserQuestionPermissionRequest/QuestionView.tsx.
 */

import { Box, Text, useInput } from 'ink';
import type { AskUserOption, AskUserQuestion } from '../../../tools/ask-user-types.js';
import type { Option } from '../custom-select/index.js';
import { Select, SelectMulti } from '../custom-select/index.js';
import { useTheme } from '../theme.js';
import type { MultipleChoiceState } from './use-multiple-choice-state.js';

//#region Props

const OTHER_VALUE = '__other__';

export interface QuestionViewProps {
  readonly question: AskUserQuestion;
  readonly state: MultipleChoiceState;
  readonly onAnswer: (answer: string, preview?: string) => void;
  readonly onCancel: () => void;
  readonly onTabNext: () => void;
  readonly onTabPrev: () => void;
}

//#endregion

//#region Helpers

interface BuiltOptions {
  readonly options: ReadonlyArray<Option<string>>;
  readonly indexByLabel: ReadonlyMap<string, number>;
}

function buildOptions(
  question: AskUserQuestion,
  setTextInputValue: (value: string) => void,
): BuiltOptions {
  const options: Array<Option<string>> = question.options.map(
    (opt: AskUserOption): Option<string> => ({
      label: opt.label,
      description: opt.description,
      value: opt.label,
    }),
  );
  options.push({
    type: 'input',
    label: 'Other',
    value: OTHER_VALUE,
    description: 'Enter a custom free-text answer.',
    placeholder: 'Type your answer, then press Enter…',
    onChange: setTextInputValue,
  });
  const indexByLabel = new Map<string, number>();
  for (const [index, opt] of options.entries()) {
    indexByLabel.set(String(opt.value), index);
  }
  return {
    options,
    indexByLabel,
  };
}

function findPreview(question: AskUserQuestion, label: string): string | undefined {
  return question.options.find((opt) => opt.label === label)?.preview;
}

//#endregion

//#region Component

export function QuestionView({
  question,
  state,
  onAnswer,
  onCancel,
  onTabNext,
  onTabPrev,
}: QuestionViewProps) {
  const theme = useTheme();
  const qState = state.questionStates[question.question];
  const rawSelected = qState?.selectedValue;
  const storedMulti: ReadonlyArray<string> = Array.isArray(rawSelected) ? rawSelected : [];

  const { options } = buildOptions(question, (value) => {
    state.updateQuestionState(
      question.question,
      {
        textInputValue: value,
      },
      question.multiSelect,
    );
  });

  // Tab/Shift-Tab move between questions at the top level when not inside the
  // Other input. Escape cancels the whole flow.
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

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color={theme.primary}>
          {question.header}
        </Text>
        <Text> </Text>
        <Text color={theme.foreground}>{question.question}</Text>
      </Box>

      {question.multiSelect ? (
        <SelectMulti
          options={options}
          defaultValue={storedMulti}
          onChange={(values) => {
            state.updateQuestionState(
              question.question,
              {
                selectedValue: values,
              },
              true,
            );
          }}
          onSubmit={(values) => {
            // Compose the answer from non-Other selections, then append the
            // Other slot last (free-text if provided, else literal "Other"
            // so the user's explicit toggle never silently disappears).
            const parts = values.filter((v) => v !== OTHER_VALUE);
            if (values.includes(OTHER_VALUE)) {
              const text = qState?.textInputValue?.trim() ?? '';
              parts.push(text.length > 0 ? text : 'Other');
            }
            onAnswer(parts.join(', '));
          }}
          onCancel={onCancel}
        />
      ) : (
        <Select
          options={options}
          defaultValue={
            typeof qState?.selectedValue === 'string' ? qState.selectedValue : undefined
          }
          isInTextInput={state.isInTextInput}
          onInputModeToggle={() => state.setTextInputMode(!state.isInTextInput)}
          onChange={(value) => {
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
            onAnswer(value, findPreview(question, value));
          }}
          onCancel={onCancel}
        />
      )}

      <Box marginTop={1}>
        <Text color={theme.muted}>
          {question.multiSelect
            ? '[Space] toggle  [Enter] submit  [Tab] next question  [Esc] cancel'
            : '[↑/↓] navigate  [Enter] select  [Tab] next question  [Esc] cancel'}
        </Text>
      </Box>
    </Box>
  );
}

//#endregion
