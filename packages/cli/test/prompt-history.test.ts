import { describe, expect, test } from 'bun:test';
import {
  createPromptHistoryState,
  navigatePromptHistoryDown,
  navigatePromptHistoryUp,
  recordPromptHistoryEntry,
  shouldNavigateHistory,
} from '../src/tui/utils/prompt-history.js';

describe('prompt history navigation', () => {
  test('up recalls newest prompt and repeated up walks older prompts', () => {
    const state = createPromptHistoryState([
      'newest',
      'older',
    ]);

    let result = navigatePromptHistoryUp(state, 'draft text');
    expect(result.value).toBe('newest');
    expect(result.state.draft).toBe('draft text');

    result = navigatePromptHistoryUp(result.state, result.value);
    expect(result.value).toBe('older');

    result = navigatePromptHistoryUp(result.state, result.value);
    expect(result.value).toBe('older');
  });

  test('down restores newer entries and then the original draft', () => {
    const state = createPromptHistoryState([
      'newest',
      'older',
    ]);

    let result = navigatePromptHistoryUp(state, 'draft text');
    result = navigatePromptHistoryUp(result.state, result.value);
    result = navigatePromptHistoryDown(result.state);
    expect(result.value).toBe('newest');

    result = navigatePromptHistoryDown(result.state);
    expect(result.value).toBe('draft text');
    expect(result.state.index).toBe(-1);
  });

  test('records newest first and dedupes adjacent duplicate entries', () => {
    let state = createPromptHistoryState([]);
    state = recordPromptHistoryEntry(state, 'first');
    state = recordPromptHistoryEntry(state, 'second');
    state = recordPromptHistoryEntry(state, 'second');

    expect(state.entries).toEqual([
      'second',
      'first',
    ]);
    expect(state.index).toBe(-1);
  });
});

describe('shouldNavigateHistory', () => {
  // The keyboard handler delegates Up/Down arrow gating to this predicate.
  // Buggy versions (`index > 0` instead of `index >= 0`) trapped the user
  // on the most-recent entry — repeated Down at index 0 was a silent no-op
  // when the readline-style expectation is to land on the empty draft.

  test('up always navigates when there are entries to recall', () => {
    const populated = createPromptHistoryState([
      'a',
      'b',
    ]);
    expect(shouldNavigateHistory('up', populated)).toBe(true);
  });

  test('up is a no-op when history is empty', () => {
    expect(shouldNavigateHistory('up', createPromptHistoryState([]))).toBe(false);
  });

  test('down at the newest entry (index 0) still fires — lands on the draft', () => {
    // Simulate a single Up press from a populated history: index moves
    // from -1 to 0 and the user now sees the newest entry. The next Down
    // MUST return true so the handler can dispatch the navigation that
    // restores the draft.
    const state = createPromptHistoryState([
      'newest',
      'older',
    ]);
    const upResult = navigatePromptHistoryUp(state, 'draft');
    expect(upResult.state.index).toBe(0);
    expect(shouldNavigateHistory('down', upResult.state)).toBe(true);
  });

  test('down anywhere inside history navigates', () => {
    const state = createPromptHistoryState([
      'a',
      'b',
      'c',
    ]);
    const r = navigatePromptHistoryUp(navigatePromptHistoryUp(state, '').state, '');
    // r.state.index should be 1 (two ups, started at -1).
    expect(r.state.index).toBe(1);
    expect(shouldNavigateHistory('down', r.state)).toBe(true);
  });

  test('down at the draft (index === -1) is a no-op', () => {
    // Fresh prompt, no history navigation in flight: Down should be ignored
    // rather than producing some surprising behaviour.
    const fresh = createPromptHistoryState([
      'a',
      'b',
    ]);
    expect(fresh.index).toBe(-1);
    expect(shouldNavigateHistory('down', fresh)).toBe(false);
  });

  test('down with empty history is a no-op', () => {
    expect(shouldNavigateHistory('down', createPromptHistoryState([]))).toBe(false);
  });
});
