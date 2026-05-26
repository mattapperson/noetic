/**
 * Reducer hook driving the multi-question UX.
 *
 * Ported verbatim from ~/Desktop/claude-code-main/src/components/permissions/AskUserQuestionPermissionRequest/use-multiple-choice-state.ts
 * — state shape, action names, and semantics preserved.
 */

import { useCallback, useReducer } from 'react';

//#region Types

export type AnswerValue = string;

export interface QuestionState {
  selectedValue?: string | ReadonlyArray<string>;
  textInputValue: string;
}

interface State {
  currentQuestionIndex: number;
  answers: Record<string, AnswerValue>;
  annotations: Record<
    string,
    {
      preview?: string;
      notes?: string;
    }
  >;
  questionStates: Record<string, QuestionState>;
  isInTextInput: boolean;
}

type Action =
  | {
      type: 'next-question';
    }
  | {
      type: 'prev-question';
    }
  | {
      type: 'jump-to-question';
      index: number;
    }
  | {
      type: 'update-question-state';
      questionText: string;
      updates: Partial<QuestionState>;
      isMultiSelect: boolean;
    }
  | {
      type: 'set-answer';
      questionText: string;
      answer: string;
      preview?: string;
      shouldAdvance: boolean;
    }
  | {
      type: 'set-text-input-mode';
      isInInput: boolean;
    };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'next-question':
      return {
        ...state,
        currentQuestionIndex: state.currentQuestionIndex + 1,
        isInTextInput: false,
      };
    case 'prev-question':
      return {
        ...state,
        currentQuestionIndex: Math.max(0, state.currentQuestionIndex - 1),
        isInTextInput: false,
      };
    case 'jump-to-question':
      return {
        ...state,
        currentQuestionIndex: Math.max(0, action.index),
        isInTextInput: false,
      };
    case 'update-question-state': {
      const existing = state.questionStates[action.questionText];
      const next: QuestionState = {
        selectedValue:
          action.updates.selectedValue ??
          existing?.selectedValue ??
          (action.isMultiSelect ? [] : undefined),
        textInputValue: action.updates.textInputValue ?? existing?.textInputValue ?? '',
      };
      return {
        ...state,
        questionStates: {
          ...state.questionStates,
          [action.questionText]: next,
        },
      };
    }
    case 'set-answer': {
      const nextState: State = {
        ...state,
        answers: {
          ...state.answers,
          [action.questionText]: action.answer,
        },
        annotations:
          action.preview === undefined
            ? state.annotations
            : {
                ...state.annotations,
                [action.questionText]: {
                  preview: action.preview,
                },
              },
      };
      if (!action.shouldAdvance) {
        return nextState;
      }
      return {
        ...nextState,
        currentQuestionIndex: nextState.currentQuestionIndex + 1,
        isInTextInput: false,
      };
    }
    case 'set-text-input-mode':
      return {
        ...state,
        isInTextInput: action.isInInput,
      };
  }
}

const INITIAL_STATE: State = {
  currentQuestionIndex: 0,
  answers: {},
  annotations: {},
  questionStates: {},
  isInTextInput: false,
};

//#endregion

//#region Hook

export interface MultipleChoiceState {
  readonly currentQuestionIndex: number;
  readonly answers: Readonly<Record<string, AnswerValue>>;
  readonly annotations: Readonly<
    Record<
      string,
      {
        preview?: string;
        notes?: string;
      }
    >
  >;
  readonly questionStates: Readonly<Record<string, QuestionState>>;
  readonly isInTextInput: boolean;
  nextQuestion(): void;
  prevQuestion(): void;
  jumpToQuestion(index: number): void;
  updateQuestionState(
    questionText: string,
    updates: Partial<QuestionState>,
    isMultiSelect: boolean,
  ): void;
  setAnswer(
    questionText: string,
    answer: string,
    opts?: {
      preview?: string;
      shouldAdvance?: boolean;
    },
  ): void;
  setTextInputMode(isInInput: boolean): void;
}

export function useMultipleChoiceState(): MultipleChoiceState {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  const nextQuestion = useCallback(
    () =>
      dispatch({
        type: 'next-question',
      }),
    [],
  );
  const prevQuestion = useCallback(
    () =>
      dispatch({
        type: 'prev-question',
      }),
    [],
  );
  const jumpToQuestion = useCallback(
    (index: number) =>
      dispatch({
        type: 'jump-to-question',
        index,
      }),
    [],
  );
  const updateQuestionState = useCallback(
    (questionText: string, updates: Partial<QuestionState>, isMultiSelect: boolean) => {
      dispatch({
        type: 'update-question-state',
        questionText,
        updates,
        isMultiSelect,
      });
    },
    [],
  );
  const setAnswer = useCallback(
    (
      questionText: string,
      answer: string,
      opts?: {
        preview?: string;
        shouldAdvance?: boolean;
      },
    ) => {
      dispatch({
        type: 'set-answer',
        questionText,
        answer,
        preview: opts?.preview,
        shouldAdvance: opts?.shouldAdvance ?? true,
      });
    },
    [],
  );
  const setTextInputMode = useCallback(
    (isInInput: boolean) =>
      dispatch({
        type: 'set-text-input-mode',
        isInInput,
      }),
    [],
  );

  return {
    currentQuestionIndex: state.currentQuestionIndex,
    answers: state.answers,
    annotations: state.annotations,
    questionStates: state.questionStates,
    isInTextInput: state.isInTextInput,
    nextQuestion,
    prevQuestion,
    jumpToQuestion,
    updateQuestionState,
    setAnswer,
    setTextInputMode,
  };
}

//#endregion
