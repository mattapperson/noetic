import { describe, expect, test } from 'bun:test';
import {
  countWrappedLines,
  estimateEntryHeight,
} from '../src/tui/grouping/estimate-entry-height.js';
import type { CollapsedReadGroup, DisplayEntry } from '../src/tui/grouping/types.js';

// Wide enough that no wrap kicks in for the small test fixtures below.
const WIDE = 200;

describe('countWrappedLines', () => {
  test('charges every \\n-split line at least one row', () => {
    expect(countWrappedLines('', WIDE)).toBe(0);
    expect(countWrappedLines('a', WIDE)).toBe(1);
    expect(countWrappedLines('a\nb', WIDE)).toBe(2);
    expect(countWrappedLines('a\nb\nc', WIDE)).toBe(3);
  });

  test('charges trailing newline as a final blank row', () => {
    expect(countWrappedLines('a\n', WIDE)).toBe(2);
    expect(countWrappedLines('a\nb\n', WIDE)).toBe(3);
  });

  test('charges ceil(len / cols) for each line that exceeds the width', () => {
    // 1000 chars, 80 cols → 13 wrapped rows.
    expect(countWrappedLines('a'.repeat(1000), 80)).toBe(Math.ceil(1000 / 80));
    // Wrap interacts with newlines per-line, not as one big blob.
    // "long\nshort" at width 3 → ceil(4/3) + ceil(5/3) = 2 + 2 = 4.
    expect(countWrappedLines('long\nshort', 3)).toBe(4);
  });

  test('width of 0 or non-finite degrades to a newline-only count', () => {
    expect(countWrappedLines('a'.repeat(1000), 0)).toBe(1);
    expect(countWrappedLines('a\nb', Number.NaN)).toBe(2);
  });
});

describe('estimateEntryHeight', () => {
  test('counts newlines plus margin for a user entry', () => {
    const single: DisplayEntry = {
      role: 'user',
      content: 'one line',
    };
    const triple: DisplayEntry = {
      role: 'user',
      content: 'first\nsecond\nthird',
    };
    expect(estimateEntryHeight(single, 0, WIDE)).toBe(2); // 1 line + 1 margin
    expect(estimateEntryHeight(triple, 0, WIDE)).toBe(4); // 3 lines + 1 margin
  });

  test('counts newlines for a system info entry (no extra margin)', () => {
    const oneLine: DisplayEntry = {
      role: 'system',
      type: 'info',
      content: 'note',
    };
    const threeLines: DisplayEntry = {
      role: 'system',
      type: 'info',
      content: 'l1\nl2\nl3',
    };
    expect(estimateEntryHeight(oneLine, 0, WIDE)).toBe(1);
    expect(estimateEntryHeight(threeLines, 0, WIDE)).toBe(3);
  });

  test('counts newlines plus margin for an error entry', () => {
    const err: DisplayEntry = {
      role: 'system',
      type: 'error',
      content: 'boom',
    };
    expect(estimateEntryHeight(err, 0, WIDE)).toBe(1);
  });

  test('an assistant message: content lines + header + trailing blank', () => {
    const entry: DisplayEntry = {
      id: 'm1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: 'line one\nline two\nline three',
          annotations: [],
        },
      ],
    };
    // 3 content lines + 2 (header + trailing) = 5.
    expect(estimateEntryHeight(entry, 0, WIDE)).toBe(5);
  });

  test('a long no-newline assistant message wraps to many lines (the regression case)', () => {
    const entry: DisplayEntry = {
      id: 'm-long',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          // 1000 chars no newlines → wrap at 80 cols → 13 rows.
          text: 'x'.repeat(1000),
          annotations: [],
        },
      ],
    };
    // 13 wrapped + 2 overhead = 15. Must be ≫ 1 — that was the bug.
    expect(estimateEntryHeight(entry, 0, 80)).toBe(15);
  });

  test('a function_call_output: counts newlines in the output', () => {
    const entry: DisplayEntry = {
      id: 'o1',
      type: 'function_call_output',
      callId: 'c1',
      status: 'completed',
      output: 'l1\nl2\nl3\nl4',
    };
    expect(estimateEntryHeight(entry, 0, WIDE)).toBe(4);
  });

  test('a tool call is roughly two lines (name row + args preview)', () => {
    const entry: DisplayEntry = {
      id: 'fc1',
      type: 'function_call',
      callId: 'c1',
      status: 'completed',
      name: 'Read',
      arguments: '{"path":"x"}',
    };
    expect(estimateEntryHeight(entry, 0, WIDE)).toBe(2);
  });

  test('a collapsed read group with multiple ops takes 3 lines', () => {
    const group: CollapsedReadGroup = {
      kind: 'collapsed-read-group',
      id: 'g1',
      readPaths: [
        'a',
        'b',
      ],
      listPaths: [
        'c',
      ],
      searchPatterns: [],
      latestHint: 'a',
    };
    expect(estimateEntryHeight(group, 0, WIDE)).toBe(3);
  });

  test('a single-op collapsed group takes 2 lines', () => {
    const group: CollapsedReadGroup = {
      kind: 'collapsed-read-group',
      id: 'g1',
      readPaths: [
        'a',
      ],
      listPaths: [],
      searchPatterns: [],
      latestHint: 'a',
    };
    expect(estimateEntryHeight(group, 0, WIDE)).toBe(2);
  });
});
