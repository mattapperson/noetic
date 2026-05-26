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
