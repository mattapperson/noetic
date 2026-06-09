import { describe, expect, test } from 'bun:test';
import {
  createPromptHistoryState,
  navigatePromptHistoryDown,
  navigatePromptHistoryUp,
  recordPromptHistoryEntry,
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
