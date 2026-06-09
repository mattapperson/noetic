/**
 * Unit tests for /context helpers. Rendering-level tests are deferred to
 * pilotty-driven e2e since ink-testing-library isn't a dep.
 */

import { describe, expect, test } from 'bun:test';
import type { Item, LastLayerUsage } from '@noetic-tools/core';
import {
  buildBar,
  buildRows,
  formatTokens,
  getModelContextLimit,
  summarizeItem,
} from '../src/tui/commands/context.js';

//#region Fixtures

function makeUsage(partial: Partial<LastLayerUsage> = {}): LastLayerUsage {
  return {
    executionId: 'exec-1',
    modelId: 'test-model',
    layers: [],
    systemPromptTokens: 0,
    toolsTokens: 0,
    historyTokens: 0,
    totalUsedTokens: 0,
    ...partial,
  };
}

function makeMessage(role: 'user' | 'assistant', text: string): Item {
  if (role === 'user') {
    return {
      id: 'msg-1',
      type: 'message',
      status: 'completed',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text,
        },
      ],
    };
  }
  return {
    id: 'msg-1',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text,
        annotations: [],
      },
    ],
  };
}

//#endregion

describe('formatTokens', () => {
  test('formats sub-1k as integer', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });
  test('formats ≥1k with one decimal and k suffix', () => {
    expect(formatTokens(1e3)).toBe('1.0k');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(10_250)).toBe('10.3k');
  });
});

describe('buildBar', () => {
  test('fills proportionally to percent', () => {
    const empty = buildBar(0);
    const full = buildBar(1e2);
    const half = buildBar(50);
    expect(empty).toBe('░'.repeat(24));
    expect(full).toBe('█'.repeat(24));
    expect(half.split('').filter((c) => c === '█').length).toBe(12);
  });

  test('bar width is constant regardless of input percent', () => {
    expect(buildBar(0).length).toBe(24);
    expect(buildBar(37.4).length).toBe(24);
    expect(buildBar(1e2).length).toBe(24);
  });
});

describe('buildRows', () => {
  test('omits zero-token components', () => {
    const rows = buildRows(makeUsage());
    expect(rows).toEqual([]);
  });

  test('emits System prompt / Tools / per-layer / Messages in order', () => {
    const rows = buildRows(
      makeUsage({
        systemPromptTokens: 100,
        toolsTokens: 50,
        historyTokens: 25,
        layers: [
          {
            layerId: 'planMemory',
            tokenCount: 10,
            items: [],
          },
          {
            layerId: 'workingMemory',
            tokenCount: 5,
            items: [],
          },
        ],
      }),
    );
    expect(rows.map((r) => r.label)).toEqual([
      'System prompt',
      'Tools',
      'planMemory',
      'workingMemory',
      'Messages',
    ]);
    expect(rows.map((r) => r.color)).toEqual([
      'magenta',
      'blue',
      'cyan',
      'cyan',
      'green',
    ]);
  });
});

describe('summarizeItem', () => {
  test('renders user message with role tag and preview', () => {
    const s = summarizeItem(makeMessage('user', 'Hello world'));
    expect(s).toBe('[user] Hello world');
  });

  test('truncates long message content with ellipsis', () => {
    const long = 'x'.repeat(200);
    const s = summarizeItem(makeMessage('assistant', long));
    expect(s.startsWith('[assistant] ')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s.length).toBeLessThanOrEqual('[assistant] '.length + 81);
  });

  test('collapses whitespace in message previews', () => {
    const s = summarizeItem(makeMessage('user', 'foo\n\n  bar\tbaz'));
    expect(s).toBe('[user] foo bar baz');
  });

  test('labels function calls with name and truncated args', () => {
    const item: Item = {
      id: 'c1',
      type: 'function_call',
      status: 'completed',
      callId: 'c1',
      name: 'bash',
      arguments: JSON.stringify({
        cmd: 'ls -la',
      }),
    };
    const s = summarizeItem(item);
    expect(s.startsWith('[call] bash(')).toBe(true);
  });

  test('labels function_call_output with truncated output', () => {
    const item: Item = {
      id: 'o1',
      type: 'function_call_output',
      status: 'completed',
      callId: 'c1',
      output: 'x'.repeat(200),
    };
    const s = summarizeItem(item);
    expect(s.startsWith('[output] ')).toBe(true);
    expect(s.length).toBe('[output] '.length + 80);
  });

  test('summarizes message with mixed output_text parts joined', () => {
    const item: Item = {
      id: 'mix-1',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: 'first',
          annotations: [],
        },
        {
          type: 'output_text',
          text: ' second',
          annotations: [],
        },
      ],
    };
    expect(summarizeItem(item)).toBe('[assistant] first second');
  });

  test('labels unknown item types with their type name', () => {
    const item: Item = {
      id: 'r1',
      type: 'reasoning',
      status: 'completed',
      content: [],
      summary: [],
    };
    expect(summarizeItem(item)).toBe('[reasoning]');
  });
});

describe('getModelContextLimit', () => {
  test('returns 200k for Claude Sonnet 4 family', () => {
    expect(getModelContextLimit('anthropic/claude-sonnet-4')).toBe(2e5);
    expect(getModelContextLimit('anthropic/claude-sonnet-4-6')).toBe(2e5);
    expect(getModelContextLimit('claude-sonnet-4')).toBe(2e5);
  });

  test('returns 1M when the [1m] suffix is present', () => {
    expect(getModelContextLimit('claude-opus-4-6[1m]')).toBe(1e6);
    expect(getModelContextLimit('anthropic/claude-sonnet-4-6[1m]')).toBe(1e6);
  });

  test('returns 128k for gpt-4o family', () => {
    expect(getModelContextLimit('openai/gpt-4o')).toBe(128e3);
    expect(getModelContextLimit('openai/gpt-4o-mini')).toBe(128e3);
  });

  test('returns 400k for gpt-5', () => {
    expect(getModelContextLimit('openai/gpt-5')).toBe(4e5);
  });

  test('falls back to 200k default for unknown models', () => {
    expect(getModelContextLimit('some/unknown-model')).toBe(2e5);
    expect(getModelContextLimit('weird-string')).toBe(2e5);
  });
});
