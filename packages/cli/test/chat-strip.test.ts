import { describe, expect, test } from 'bun:test';
import { buildPreviewLines } from '../src/tui/components/chat-strip.js';

describe('buildPreviewLines', () => {
  test('returns the last 3 lines from longer text', () => {
    const text = [
      'one',
      'two',
      'three',
      'four',
      'five',
    ].join('\n');
    expect(buildPreviewLines(text, 40)).toEqual([
      'three',
      'four',
      'five',
    ]);
  });

  test('drops empty lines so the preview never shows a blank slot', () => {
    const text = 'one\n\n\n  \n\nfive';
    // Blank-only and empty lines are filtered. The remaining ['one', '  ',
    // 'five'] yields the last three after filtering for length > 0.
    const lines = buildPreviewLines(text, 40);
    expect(lines).not.toContain('');
    expect(lines[lines.length - 1]).toBe('five');
  });

  test('truncates lines that exceed lineWidth with an ellipsis', () => {
    const long = 'a'.repeat(80);
    const lines = buildPreviewLines(long, 10);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(10);
    expect(lines[0]?.endsWith('…')).toBe(true);
  });

  test('returns an empty array when the text has no usable content', () => {
    expect(buildPreviewLines('', 40)).toEqual([]);
    expect(buildPreviewLines('\n\n\n', 40)).toEqual([]);
  });

  test('lineWidth of 0 still returns the tail lines but as empty strings', () => {
    const lines = buildPreviewLines('a\nb\nc', 0);
    // Even at width 0 we still yield the same number of slots — the caller
    // decides whether to render them. The contract is "ignore lines you can't
    // fit", but a width of 0 means *nothing* fits, so each line becomes empty.
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toBe('');
    }
  });
});
