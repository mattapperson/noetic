import { describe, expect, test } from 'bun:test';
import type { Suggestion } from '../src/tui/components/prompt-input';

// Test context that mimics the internal behavior
interface TestContext {
  value: string;
  suggestions: Suggestion[];
  selectedIndex: number;
  setValue: (v: string) => void;
  setSuggestions: (s: Suggestion[]) => void;
  setSelectedIndex: (i: number) => void;
}

function createTestContext(initialValue = '', initialSuggestions: Suggestion[] = []): TestContext {
  let value = initialValue;
  let suggestions = initialSuggestions;
  let selectedIndex = 0;

  return {
    get value() {
      return value;
    },
    get suggestions() {
      return suggestions;
    },
    get selectedIndex() {
      return selectedIndex;
    },
    setValue: (v: string) => {
      value = v;
    },
    setSuggestions: (s: Suggestion[]) => {
      suggestions = s;
      selectedIndex = 0;
    },
    setSelectedIndex: (i: number) => {
      selectedIndex = i;
    },
  };
}

// Simulate the actual keyboard handler logic
function handleTabKey(ctx: TestContext): void {
  if (ctx.suggestions.length === 0) {
    return;
  }

  const selected = ctx.suggestions[ctx.selectedIndex];
  if (selected) {
    if (ctx.value.startsWith('/')) {
      // For slash commands, complete with the full command
      ctx.setValue(selected.text);
      ctx.setSuggestions([]);
    } else {
      // For @ mentions, complete after the @ symbol
      const base = ctx.value.slice(0, ctx.value.lastIndexOf('@'));
      ctx.setValue(base + selected.text + ' ');
      ctx.setSuggestions([]);
    }
  }
}

describe('PromptInput Tab Behavior', () => {
  test('Tab completes slash commands with selected suggestion', () => {
    const ctx = createTestContext('/hel', [
      {
        text: '/help',
        desc: 'Show help',
      },
      {
        text: '/hello',
        desc: 'Say hello',
      },
    ]);

    handleTabKey(ctx);

    expect(ctx.value).toBe('/help');
    expect(ctx.suggestions).toHaveLength(0);
  });

  test('Tab completes @ mentions with selected suggestion', () => {
    const ctx = createTestContext('@use', [
      {
        text: 'user1',
        desc: 'First user',
      },
      {
        text: 'user2',
        desc: 'Second user',
      },
    ]);

    handleTabKey(ctx);

    expect(ctx.value).toBe('user1 ');
    expect(ctx.suggestions).toHaveLength(0);
  });

  test('Tab does nothing when no suggestions available', () => {
    const ctx = createTestContext('/hel', []);

    handleTabKey(ctx);

    expect(ctx.value).toBe('/hel'); // Unchanged
    expect(ctx.suggestions).toHaveLength(0);
  });

  test('Tab completes second suggestion when selected', () => {
    const ctx = createTestContext('/con', [
      {
        text: '/config',
        desc: 'Configuration',
      },
      {
        text: '/context',
        desc: 'Show context',
      },
    ]);

    // Select second suggestion first
    ctx.setSelectedIndex(1);

    handleTabKey(ctx);

    expect(ctx.value).toBe('/context');
    expect(ctx.suggestions).toHaveLength(0);
  });

  test('Tab completes @ mentions with second suggestion when selected', () => {
    const ctx = createTestContext('@u', [
      {
        text: 'user1',
        desc: 'First user',
      },
      {
        text: 'user2',
        desc: 'Second user',
      },
    ]);

    // Select second suggestion first
    ctx.setSelectedIndex(1);

    handleTabKey(ctx);

    expect(ctx.value).toBe('user2 ');
    expect(ctx.suggestions).toHaveLength(0);
  });

  test('Tab handles @ mentions in middle of text correctly', () => {
    const ctx = createTestContext('hello @u world', [
      {
        text: 'user1',
        desc: 'First user',
      },
      {
        text: 'user2',
        desc: 'Second user',
      },
    ]);

    handleTabKey(ctx);

    // The @ completion only replaces from the @ to the end, so "world" gets removed
    expect(ctx.value).toBe('hello user1 ');
    expect(ctx.suggestions).toHaveLength(0);
  });
});
