import type { CallModel } from '@noetic-tools/cli';
import { Box, Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useCallback, useReducer } from 'react';

import { generateMoreOptions } from '../generate/more-options.js';
import type { WriteResult } from '../snapshot.js';
import { writeSnapshot } from '../snapshot.js';
import type { Deck, DeckOption, DeckSelections } from '../types.js';
import { ShortcutsHint } from './shortcuts-hint.js';
import { SlideView } from './slide-view.js';

//#region State

interface DeckState {
  deck: Deck;
  slideIndex: number;
  focusIndex: number;
  selections: DeckSelections;
  generating: boolean;
  error: string | null;
  confirmingCancel: boolean;
  lastSnapshot: WriteResult | null;
}

type DeckAction =
  | {
      type: 'focus-prev';
    }
  | {
      type: 'focus-next';
    }
  | {
      type: 'slide-prev';
    }
  | {
      type: 'slide-next';
    }
  | {
      type: 'select';
      label: string;
    }
  | {
      type: 'select-by-number';
      n: number;
    }
  | {
      type: 'generating-start';
    }
  | {
      type: 'generating-end';
      newOptions: DeckOption[];
    }
  | {
      type: 'generating-error';
      message: string;
    }
  | {
      type: 'clear-error';
    }
  | {
      type: 'confirm-cancel-enter';
    }
  | {
      type: 'confirm-cancel-exit';
    }
  | {
      type: 'snapshot-written';
      result: WriteResult;
    };

function reducer(state: DeckState, action: DeckAction): DeckState {
  if (action.type === 'focus-prev') {
    const slide = state.deck.slides[state.slideIndex];
    if (!slide) {
      return state;
    }
    const next = (state.focusIndex - 1 + slide.options.length) % slide.options.length;
    return {
      ...state,
      focusIndex: next,
    };
  }
  if (action.type === 'focus-next') {
    const slide = state.deck.slides[state.slideIndex];
    if (!slide) {
      return state;
    }
    const next = (state.focusIndex + 1) % slide.options.length;
    return {
      ...state,
      focusIndex: next,
    };
  }
  if (action.type === 'slide-prev') {
    const idx = Math.max(0, state.slideIndex - 1);
    return {
      ...state,
      slideIndex: idx,
      focusIndex: 0,
    };
  }
  if (action.type === 'slide-next') {
    const idx = Math.min(state.deck.slides.length - 1, state.slideIndex + 1);
    return {
      ...state,
      slideIndex: idx,
      focusIndex: 0,
    };
  }
  if (action.type === 'select') {
    const slide = state.deck.slides[state.slideIndex];
    if (!slide) {
      return state;
    }
    const selections = {
      ...state.selections,
    };
    if (selections[slide.id] === action.label) {
      delete selections[slide.id];
    } else {
      selections[slide.id] = action.label;
    }
    return {
      ...state,
      selections,
    };
  }
  if (action.type === 'select-by-number') {
    const slide = state.deck.slides[state.slideIndex];
    if (!slide) {
      return state;
    }
    const option = slide.options[action.n];
    if (!option) {
      return state;
    }
    return {
      ...state,
      focusIndex: action.n,
      selections: {
        ...state.selections,
        [slide.id]: option.label,
      },
    };
  }
  if (action.type === 'generating-start') {
    return {
      ...state,
      generating: true,
      error: null,
    };
  }
  if (action.type === 'generating-end') {
    const slide = state.deck.slides[state.slideIndex];
    if (!slide) {
      return {
        ...state,
        generating: false,
      };
    }
    const updatedSlide = {
      ...slide,
      options: [
        ...slide.options,
        ...action.newOptions,
      ],
    };
    const slides = state.deck.slides.map((s, i) => (i === state.slideIndex ? updatedSlide : s));
    return {
      ...state,
      generating: false,
      deck: {
        ...state.deck,
        slides,
      },
    };
  }
  if (action.type === 'generating-error') {
    return {
      ...state,
      generating: false,
      error: action.message,
    };
  }
  if (action.type === 'clear-error') {
    return {
      ...state,
      error: null,
    };
  }
  if (action.type === 'confirm-cancel-enter') {
    return {
      ...state,
      confirmingCancel: true,
    };
  }
  if (action.type === 'confirm-cancel-exit') {
    return {
      ...state,
      confirmingCancel: false,
    };
  }
  if (action.type === 'snapshot-written') {
    return {
      ...state,
      lastSnapshot: action.result,
    };
  }
  return state;
}

//#endregion

//#region Component

export interface DeckModalProps {
  deck: Deck;
  callModel: CallModel;
  dataDir: string;
  generateModel?: string;
  generateCount: number;
  maxOptionsPerSlide: number;
  autoSaveOnSubmit: boolean;
  autoSaveOnCancel: boolean;
  onDone: (summary: string) => void;
}

export function DeckModal(props: DeckModalProps): ReactNode {
  const [state, dispatch] = useReducer(reducer, {
    deck: props.deck,
    slideIndex: 0,
    focusIndex: 0,
    selections: {},
    generating: false,
    error: null,
    confirmingCancel: false,
    lastSnapshot: null,
  });

  const currentSlide = state.deck.slides[state.slideIndex];

  const doSubmit = useCallback(() => {
    let result: WriteResult | null = null;
    if (props.autoSaveOnSubmit) {
      result = writeSnapshot({
        dataDir: props.dataDir,
        deck: state.deck,
        selections: state.selections,
        status: 'submitted',
      });
      dispatch({
        type: 'snapshot-written',
        result,
      });
    }
    props.onDone(buildSubmitSummary(state.deck, state.selections, result));
  }, [
    props,
    state.deck,
    state.selections,
  ]);

  const doCancel = useCallback(() => {
    let result: WriteResult | null = null;
    if (props.autoSaveOnCancel && Object.keys(state.selections).length > 0) {
      result = writeSnapshot({
        dataDir: props.dataDir,
        deck: state.deck,
        selections: state.selections,
        status: 'cancelled',
      });
    }
    props.onDone(buildCancelSummary(state.deck, state.selections, result));
  }, [
    props,
    state.deck,
    state.selections,
  ]);

  const doGenerate = useCallback(async (): Promise<void> => {
    if (!currentSlide) {
      return;
    }
    const remaining = props.maxOptionsPerSlide - currentSlide.options.length;
    if (remaining <= 0) {
      dispatch({
        type: 'generating-error',
        message: `Slide already at max (${props.maxOptionsPerSlide}) options.`,
      });
      return;
    }
    const count = Math.min(props.generateCount, remaining);
    dispatch({
      type: 'generating-start',
    });
    try {
      const newOptions = await generateMoreOptions({
        callModel: props.callModel,
        slide: currentSlide,
        count,
        model: props.generateModel,
      });
      dispatch({
        type: 'generating-end',
        newOptions,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      dispatch({
        type: 'generating-error',
        message,
      });
    }
  }, [
    currentSlide,
    props.callModel,
    props.generateCount,
    props.generateModel,
    props.maxOptionsPerSlide,
  ]);

  useInput((input, key) => {
    if (state.confirmingCancel) {
      if (input === 'y' || input === 'Y') {
        doCancel();
        return;
      }
      if (input === 'n' || input === 'N' || key.escape) {
        dispatch({
          type: 'confirm-cancel-exit',
        });
        return;
      }
      return;
    }
    if (state.generating) {
      return;
    }
    if (key.leftArrow) {
      dispatch({
        type: 'slide-prev',
      });
      return;
    }
    if (key.rightArrow) {
      dispatch({
        type: 'slide-next',
      });
      return;
    }
    if (key.upArrow) {
      dispatch({
        type: 'focus-prev',
      });
      return;
    }
    if (key.downArrow) {
      dispatch({
        type: 'focus-next',
      });
      return;
    }
    if (/^[1-9]$/.test(input)) {
      dispatch({
        type: 'select-by-number',
        n: Number(input) - 1,
      });
      return;
    }
    if (input === ' ') {
      if (currentSlide) {
        const option = currentSlide.options[state.focusIndex];
        if (option) {
          dispatch({
            type: 'select',
            label: option.label,
          });
        }
      }
      return;
    }
    if (input === 'g' || input === 'G') {
      void doGenerate();
      return;
    }
    if (input === 's' || input === 'S') {
      const result = writeSnapshot({
        dataDir: props.dataDir,
        deck: state.deck,
        selections: state.selections,
        status: 'submitted',
      });
      dispatch({
        type: 'snapshot-written',
        result,
      });
      return;
    }
    if (key.return) {
      doSubmit();
      return;
    }
    if (key.escape) {
      if (Object.keys(state.selections).length > 0) {
        dispatch({
          type: 'confirm-cancel-enter',
        });
        return;
      }
      doCancel();
    }
  });

  const slideCount = state.deck.slides.length;
  const header = `Deck: ${state.deck.title}   Slide ${state.slideIndex + 1} of ${slideCount}`;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>{header}</Text>
        <Text dimColor>
          {Object.keys(state.selections).length} / {slideCount} selected
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column" flexGrow={1}>
        {currentSlide ? (
          <>
            <Text bold color="cyan">
              {currentSlide.title}
            </Text>
            <Box marginTop={1}>
              <SlideView
                slide={currentSlide}
                focusIndex={state.focusIndex}
                selections={state.selections}
                generating={state.generating}
              />
            </Box>
          </>
        ) : (
          <Text>Empty deck.</Text>
        )}
      </Box>
      {state.error ? (
        <Box marginTop={1}>
          <Text color="red">Error: {state.error}</Text>
        </Box>
      ) : null}
      {state.lastSnapshot ? (
        <Box marginTop={1}>
          <Text dimColor>Saved: {state.lastSnapshot.dir}</Text>
        </Box>
      ) : null}
      {state.confirmingCancel ? (
        <Box marginTop={1}>
          <Text color="yellow">Cancel deck? (y / n)</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <ShortcutsHint />
        </Box>
      )}
    </Box>
  );
}

//#endregion

//#region Summary builders

function buildSubmitSummary(
  deck: Deck,
  selections: DeckSelections,
  snapshot: WriteResult | null,
): string {
  const lines: string[] = [];
  lines.push(`Design deck "${deck.title}" submitted with selections:`);
  lines.push('```json');
  lines.push(JSON.stringify(selections, null, 2));
  lines.push('```');
  for (const slide of deck.slides) {
    const chosen = selections[slide.id];
    lines.push(`- ${slide.title}: ${chosen ?? '(none)'}`);
  }
  if (snapshot) {
    lines.push(`Snapshot: ${snapshot.dir}`);
  }
  return lines.join('\n');
}

function buildCancelSummary(
  deck: Deck,
  selections: DeckSelections,
  snapshot: WriteResult | null,
): string {
  const count = Object.keys(selections).length;
  const lines: string[] = [
    `Design deck "${deck.title}" cancelled${count > 0 ? ` with ${count} partial selection(s)` : ''}.`,
  ];
  if (snapshot) {
    lines.push(`Partial snapshot: ${snapshot.dir}`);
  }
  return lines.join('\n');
}

//#endregion
