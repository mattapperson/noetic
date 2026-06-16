//#region Types

export interface PromptHistoryState {
  readonly entries: ReadonlyArray<string>;
  readonly index: number;
  readonly draft: string;
}

export interface PromptHistoryNavigationResult {
  readonly state: PromptHistoryState;
  readonly value: string;
}

//#endregion

//#region Public API

/**
 * Predicate: should an Up/Down arrow keystroke dispatch a history-navigation
 * step? Extracted from the keyboard handler so the bash-style "Down at the
 * newest entry lands on the empty draft" contract is testable without ink.
 *
 *   - Up always navigates as long as there are entries to recall.
 *   - Down navigates when the user is somewhere inside history
 *     (`index >= 0`). At `index === 0` (newest entry) the next Down lands
 *     at the saved draft — usually empty — restoring the pre-navigation
 *     state. Down with `index === -1` is a no-op so a fresh prompt with no
 *     history navigation in flight ignores Down entirely.
 */
export function shouldNavigateHistory(
  direction: 'up' | 'down',
  state: PromptHistoryState,
): boolean {
  if (direction === 'up') {
    return state.entries.length > 0;
  }
  return state.index >= 0;
}

export function createPromptHistoryState(entries: ReadonlyArray<string>): PromptHistoryState {
  return {
    entries: [
      ...entries,
    ],
    index: -1,
    draft: '',
  };
}

export function recordPromptHistoryEntry(
  state: PromptHistoryState,
  entry: string,
): PromptHistoryState {
  const trimmed = entry.trim();
  if (trimmed.length === 0) {
    return resetPromptHistoryNavigation(state);
  }
  const previous = state.entries[0];
  const entries =
    previous === trimmed
      ? state.entries
      : [
          trimmed,
          ...state.entries,
        ];
  return {
    entries,
    index: -1,
    draft: '',
  };
}

export function resetPromptHistoryNavigation(state: PromptHistoryState): PromptHistoryState {
  return {
    entries: state.entries,
    index: -1,
    draft: '',
  };
}

export function navigatePromptHistoryUp(
  state: PromptHistoryState,
  currentValue: string,
): PromptHistoryNavigationResult {
  if (state.entries.length === 0) {
    return {
      state,
      value: currentValue,
    };
  }
  const isStarting = state.index < 0;
  const nextIndex = Math.min(state.entries.length - 1, state.index + 1);
  const nextState: PromptHistoryState = {
    entries: state.entries,
    index: nextIndex,
    draft: isStarting ? currentValue : state.draft,
  };
  return {
    state: nextState,
    value: state.entries[nextIndex] ?? currentValue,
  };
}

export function navigatePromptHistoryDown(
  state: PromptHistoryState,
): PromptHistoryNavigationResult {
  if (state.index < 0) {
    return {
      state,
      value: state.draft,
    };
  }
  if (state.index === 0) {
    const nextState = resetPromptHistoryNavigation(state);
    return {
      state: nextState,
      value: state.draft,
    };
  }
  const nextIndex = state.index - 1;
  const nextState: PromptHistoryState = {
    entries: state.entries,
    index: nextIndex,
    draft: state.draft,
  };
  return {
    state: nextState,
    value: state.entries[nextIndex] ?? state.draft,
  };
}

//#endregion
