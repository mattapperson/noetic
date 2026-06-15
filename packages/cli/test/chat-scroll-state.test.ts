/**
 * Tests for the pure ChatScroll scroll-state reducer.
 *
 * Boundaries that matter: never go negative, never exceed `entriesLen - 1`,
 * empty transcript clamps to 0, and `pageSizeFor` produces a sane minimum
 * (1) even for tiny terminals.
 */

import { describe, expect, test } from 'bun:test';
import type { ScrollContext } from '../src/tui/components/chat-scroll-state.js';
import {
  applyScrollAction,
  maxOffset,
  pageSizeFor,
} from '../src/tui/components/chat-scroll-state.js';

const ctx = (entriesLen: number, pageSize = 5): ScrollContext => ({
  entriesLen,
  pageSize,
});

describe('pageSizeFor', () => {
  test('returns floor(rows / 2)', () => {
    expect(pageSizeFor(24)).toBe(12);
    expect(pageSizeFor(40)).toBe(20);
    expect(pageSizeFor(7)).toBe(3);
  });

  test('clamps to a minimum of 1 for tiny terminals', () => {
    expect(pageSizeFor(0)).toBe(1);
    expect(pageSizeFor(1)).toBe(1);
    expect(pageSizeFor(2)).toBe(1);
  });

  test('handles negative rows defensively', () => {
    expect(pageSizeFor(-10)).toBe(1);
  });
});

describe('maxOffset', () => {
  test('is entriesLen - 1 for non-empty transcripts', () => {
    expect(maxOffset(10)).toBe(9);
    expect(maxOffset(1)).toBe(0);
  });

  test('is 0 for an empty transcript (no negative)', () => {
    expect(maxOffset(0)).toBe(0);
  });
});

describe('applyScrollAction', () => {
  describe('page-up', () => {
    test('advances by pageSize', () => {
      expect(
        applyScrollAction(
          0,
          {
            kind: 'page-up',
          },
          ctx(100, 10),
        ),
      ).toBe(10);
    });

    test('clamps to maxOffset (entriesLen - 1)', () => {
      // 95 + 10 = 105, but max is 99.
      expect(
        applyScrollAction(
          95,
          {
            kind: 'page-up',
          },
          ctx(100, 10),
        ),
      ).toBe(99);
    });

    test('no-op when already at the top', () => {
      expect(
        applyScrollAction(
          9,
          {
            kind: 'page-up',
          },
          ctx(10, 10),
        ),
      ).toBe(9);
    });

    test('no-op on empty transcript', () => {
      expect(
        applyScrollAction(
          0,
          {
            kind: 'page-up',
          },
          ctx(0, 10),
        ),
      ).toBe(0);
    });
  });

  describe('page-down', () => {
    test('retreats by pageSize', () => {
      expect(
        applyScrollAction(
          20,
          {
            kind: 'page-down',
          },
          ctx(100, 10),
        ),
      ).toBe(10);
    });

    test('clamps to 0 (no negative offset)', () => {
      expect(
        applyScrollAction(
          3,
          {
            kind: 'page-down',
          },
          ctx(100, 10),
        ),
      ).toBe(0);
    });

    test('no-op when already stuck to the bottom', () => {
      expect(
        applyScrollAction(
          0,
          {
            kind: 'page-down',
          },
          ctx(100, 10),
        ),
      ).toBe(0);
    });
  });

  describe('line-up / line-down', () => {
    test('move by exactly one entry', () => {
      expect(
        applyScrollAction(
          0,
          {
            kind: 'line-up',
          },
          ctx(10),
        ),
      ).toBe(1);
      expect(
        applyScrollAction(
          5,
          {
            kind: 'line-up',
          },
          ctx(10),
        ),
      ).toBe(6);
      expect(
        applyScrollAction(
          5,
          {
            kind: 'line-down',
          },
          ctx(10),
        ),
      ).toBe(4);
    });

    test('boundary at the top: cannot exceed entriesLen - 1', () => {
      expect(
        applyScrollAction(
          9,
          {
            kind: 'line-up',
          },
          ctx(10),
        ),
      ).toBe(9);
    });

    test('boundary at the bottom: cannot go negative', () => {
      expect(
        applyScrollAction(
          0,
          {
            kind: 'line-down',
          },
          ctx(10),
        ),
      ).toBe(0);
    });

    test('boundary at maxOffset N-1, N, N+1 (line-up)', () => {
      // entriesLen=5 → maxOffset=4.
      expect(
        applyScrollAction(
          3,
          {
            kind: 'line-up',
          },
          ctx(5),
        ),
      ).toBe(4);
      expect(
        applyScrollAction(
          4,
          {
            kind: 'line-up',
          },
          ctx(5),
        ),
      ).toBe(4);
      // Pre-clamped offset of 5 (over max) should clamp on the way through.
      expect(
        applyScrollAction(
          5,
          {
            kind: 'line-up',
          },
          ctx(5),
        ),
      ).toBe(4);
    });
  });

  describe('home', () => {
    test('jumps to the top (maxOffset = entriesLen - 1)', () => {
      expect(
        applyScrollAction(
          0,
          {
            kind: 'home',
          },
          ctx(50),
        ),
      ).toBe(49);
      expect(
        applyScrollAction(
          20,
          {
            kind: 'home',
          },
          ctx(50),
        ),
      ).toBe(49);
    });

    test('stays at 0 for an empty transcript', () => {
      expect(
        applyScrollAction(
          0,
          {
            kind: 'home',
          },
          ctx(0),
        ),
      ).toBe(0);
    });

    test('stays at 0 for a single-entry transcript (cannot scroll past the only entry)', () => {
      expect(
        applyScrollAction(
          0,
          {
            kind: 'home',
          },
          ctx(1),
        ),
      ).toBe(0);
    });
  });

  describe('end', () => {
    test('jumps to the bottom (offset 0)', () => {
      expect(
        applyScrollAction(
          20,
          {
            kind: 'end',
          },
          ctx(50),
        ),
      ).toBe(0);
      expect(
        applyScrollAction(
          0,
          {
            kind: 'end',
          },
          ctx(50),
        ),
      ).toBe(0);
    });

    test('jumps to 0 even if the current offset was over-max', () => {
      // A stale offset from a longer transcript still resolves to 0.
      expect(
        applyScrollAction(
          99,
          {
            kind: 'end',
          },
          ctx(10),
        ),
      ).toBe(0);
    });
  });

  describe('clamp', () => {
    test('leaves a valid offset untouched', () => {
      expect(
        applyScrollAction(
          5,
          {
            kind: 'clamp',
          },
          ctx(20),
        ),
      ).toBe(5);
    });

    test('pulls an over-max offset down to the new ceiling', () => {
      // Transcript shrank from 50 entries to 10; offset 30 must become 9.
      expect(
        applyScrollAction(
          30,
          {
            kind: 'clamp',
          },
          ctx(10),
        ),
      ).toBe(9);
    });

    test('pulls a negative offset (defensive) up to 0', () => {
      expect(
        applyScrollAction(
          -5,
          {
            kind: 'clamp',
          },
          ctx(10),
        ),
      ).toBe(0);
    });

    test('collapses to 0 when the transcript empties', () => {
      expect(
        applyScrollAction(
          7,
          {
            kind: 'clamp',
          },
          ctx(0),
        ),
      ).toBe(0);
    });
  });
});
