import { describe, expect, test } from 'bun:test';
import { resolvePromptEscapeAction } from '../src/tui/utils/prompt-escape.js';

describe('prompt escape behavior', () => {
  test('clears non-empty input before stopping the agent', () => {
    const action = resolvePromptEscapeAction({
      value: 'draft',
      status: 'streaming',
      suggestionCount: 0,
      isModalOpen: false,
      hasModalClose: false,
      hasStop: true,
    });

    expect(action).toBe('clear-input');
  });

  test('stops the agent when input is empty and a turn is running', () => {
    const action = resolvePromptEscapeAction({
      value: '',
      status: 'streaming',
      suggestionCount: 0,
      isModalOpen: false,
      hasModalClose: false,
      hasStop: true,
    });

    expect(action).toBe('stop');
  });

  test('closes modal before clearing input', () => {
    const action = resolvePromptEscapeAction({
      value: 'draft',
      status: 'streaming',
      suggestionCount: 1,
      isModalOpen: true,
      hasModalClose: true,
      hasStop: true,
    });

    expect(action).toBe('close-modal');
  });

  test('dismisses suggestions before stopping an empty prompt', () => {
    const action = resolvePromptEscapeAction({
      value: '',
      status: 'streaming',
      suggestionCount: 1,
      isModalOpen: false,
      hasModalClose: false,
      hasStop: true,
    });

    expect(action).toBe('dismiss-suggestions');
  });
});
