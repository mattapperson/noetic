/**
 * Pure-helper coverage for `task-detail.tsx`. The Ink component is
 * exercised end-to-end by manual smoke tests; here we verify the
 * formatting and tail-truncation helpers behave correctly across
 * boundary conditions.
 */

import { describe, expect, test } from 'bun:test';

import type { LogEntry } from '../../../src/commands/builtins/tasks/schemas.js';
import {
  formatLogLine,
  logEntryKey,
  truncateLogTail,
} from '../../../src/commands/builtins/tasks/ui/task-detail.js';

//#region Fixtures

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    kind: 'log',
    ts: '2026-04-30T12:34:56.000Z',
    message: 'hello',
    ...overrides,
  };
}

//#endregion

describe('formatLogLine', () => {
  test('extracts the time portion of an ISO timestamp', () => {
    const formatted = formatLogLine(makeEntry());
    expect(formatted).toContain('12:34:56');
  });

  test('falls back to the raw ts when shorter than ISO', () => {
    const formatted = formatLogLine(
      makeEntry({
        ts: 'short',
      }),
    );
    expect(formatted.startsWith('short')).toBe(true);
  });

  test('embeds the kind tag and message', () => {
    const formatted = formatLogLine(
      makeEntry({
        kind: 'comment',
        message: 'hi',
      }),
    );
    expect(formatted).toContain('[comment]');
    expect(formatted).toContain('hi');
  });
});

describe('truncateLogTail', () => {
  test('returns the input unchanged when length <= n', () => {
    const e1 = makeEntry({
      message: 'a',
    });
    const e2 = makeEntry({
      message: 'b',
    });
    expect(
      truncateLogTail(
        [
          e1,
          e2,
        ],
        5,
      ),
    ).toEqual([
      e1,
      e2,
    ]);
  });

  test('keeps only the trailing n entries', () => {
    const entries = Array.from(
      {
        length: 5,
      },
      (_unused, i) =>
        makeEntry({
          message: `m${i}`,
        }),
    );
    const tail = truncateLogTail(entries, 2);
    expect(tail.map((e) => e.message)).toEqual([
      'm3',
      'm4',
    ]);
  });

  test('boundary: n=1 returns just the last entry', () => {
    const entries = [
      makeEntry({
        message: 'old',
      }),
      makeEntry({
        message: 'new',
      }),
    ];
    const tail = truncateLogTail(entries, 1);
    expect(tail).toHaveLength(1);
    expect(tail[0]?.message).toBe('new');
  });

  test('boundary: n=0 returns []', () => {
    const entries = [
      makeEntry({
        message: 'a',
      }),
    ];
    expect(truncateLogTail(entries, 0)).toHaveLength(0);
  });
});

describe('logEntryKey', () => {
  test('combines ts + chunk + head of message + index', () => {
    const key = logEntryKey(
      makeEntry({
        ts: '2026-04-30T12:34:56.000Z',
        message: 'abcdef',
        chunk: 2,
      }),
      0,
    );
    expect(key).toContain('2026-04-30T12:34:56.000Z');
    expect(key).toContain('#2#');
    expect(key).toContain('abcdef');
    expect(key.endsWith('#0')).toBe(true);
  });

  test('treats missing chunk as 0', () => {
    const key = logEntryKey(
      makeEntry({
        message: 'x',
      }),
      0,
    );
    expect(key).toContain('#0#');
  });

  test('produces distinct keys for entries with the same ts but different messages', () => {
    const a = makeEntry({
      message: 'first',
    });
    const b = makeEntry({
      message: 'second',
    });
    expect(logEntryKey(a, 0)).not.toBe(logEntryKey(b, 1));
  });

  test('regression: two unchunked entries with identical ts + message get distinct keys', () => {
    // Matches the real-world collision: two `system` entries both with
    // `ts=2026-04-30T00:00:00.000Z` and `message="spawned"` were yielding
    // the same React key.
    const entry = makeEntry({
      kind: 'system',
      ts: '2026-04-30T00:00:00.000Z',
      message: 'spawned',
    });
    expect(logEntryKey(entry, 0)).not.toBe(logEntryKey(entry, 1));
  });
});
