import { describe, expect, test } from 'bun:test';
import { estimateEntryHeight } from '../src/tui/grouping/estimate-entry-height.js';
import type { CollapsedReadGroup, DisplayEntry } from '../src/tui/grouping/types.js';

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
    expect(estimateEntryHeight(single)).toBe(2); // 1 line + 1 margin
    expect(estimateEntryHeight(triple)).toBe(4); // 3 lines + 1 margin
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
    expect(estimateEntryHeight(oneLine)).toBe(1);
    expect(estimateEntryHeight(threeLines)).toBe(3);
  });

  test('counts newlines plus margin for an error entry', () => {
    const err: DisplayEntry = {
      role: 'system',
      type: 'error',
      content: 'boom',
    };
    expect(estimateEntryHeight(err)).toBe(1);
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
    expect(estimateEntryHeight(entry)).toBe(5);
  });

  test('a function_call_output: counts newlines in the output', () => {
    const entry: DisplayEntry = {
      id: 'o1',
      type: 'function_call_output',
      callId: 'c1',
      status: 'completed',
      output: 'l1\nl2\nl3\nl4',
    };
    expect(estimateEntryHeight(entry)).toBe(4);
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
    expect(estimateEntryHeight(entry)).toBe(2);
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
    expect(estimateEntryHeight(group)).toBe(3);
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
    expect(estimateEntryHeight(group)).toBe(2);
  });
});
