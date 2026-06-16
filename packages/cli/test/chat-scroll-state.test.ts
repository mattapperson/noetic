/**
 * Tests for the pure ChatScroll scroll-state reducer.
 *
 * State is `linesFromBottom` — terminal lines, not entries. Boundaries that
 * matter: never go negative; never exceed `max(0, totalLines - viewportLines)`;
 * empty / fits-in-viewport transcripts clamp to 0; and `pageSizeFor` produces
 * a sane minimum (1) even for tiny terminals.
 */

import { describe, expect, test } from 'bun:test';
import type { ScrollContext } from '../src/tui/components/chat-scroll-state.js';
import {
  applyScrollAction,
  maxOffset,
  pageSizeFor,
} from '../src/tui/components/chat-scroll-state.js';

const ctx = (totalLines: number, viewportLines = 20, pageSize = 10): ScrollContext => ({
  totalLines,
  viewportLines,
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
  test('is `totalLines - viewportLines` when content exceeds the viewport', () => {
    expect(maxOffset(100, 20)).toBe(80);
    expect(maxOffset(21, 20)).toBe(1);
  });

  test('is 0 when content fits in the viewport', () => {
    expect(maxOffset(20, 20)).toBe(0);
    expect(maxOffset(5, 20)).toBe(0);
  });

  test('is 0 for an empty transcript', () => {
    expect(maxOffset(0, 20)).toBe(0);
  });

  test('never goes negative even for absurd viewports', () => {
    expect(maxOffset(10, 1000)).toBe(0);
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
          ctx(200, 20, 10),
        ),
      ).toBe(10);
    });

    test('clamps to maxOffset (totalLines - viewportLines)', () => {
      // current 175 + 10 = 185, but max is 200 - 20 = 180.
      expect(
        applyScrollAction(
          175,
          {
            kind: 'page-up',
          },
          ctx(200, 20, 10),
        ),
      ).toBe(180);
    });

    test('no-op when already at the top', () => {
      expect(
        applyScrollAction(
          80,
          {
            kind: 'page-up',
          },
          ctx(100, 20, 10),
        ),
      ).toBe(80);
    });

    test('no-op when content fits in the viewport', () => {
      expect(
        applyScrollAction(
          0,
          {
            kind: 'page-up',
          },
          ctx(15, 20, 10),
        ),
      ).toBe(0);
    });

    test('no-op on empty transcript', () => {
      expect(
        applyScrollAction(
          0,
          {
            kind: 'page-up',
          },
          ctx(0, 20, 10),
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
          ctx(100, 20, 10),
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
          ctx(100, 20, 10),
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
          ctx(100, 20, 10),
        ),
      ).toBe(0);
    });
  });

  describe('line-up / line-down', () => {
    test('move by exactly one line', () => {
      expect(
        applyScrollAction(
          0,
          {
            kind: 'line-up',
          },
          ctx(100, 20, 10),
        ),
      ).toBe(1);
      expect(
        applyScrollAction(
          5,
          {
            kind: 'line-up',
          },
          ctx(100, 20, 10),
        ),
      ).toBe(6);
      expect(
        applyScrollAction(
          5,
          {
            kind: 'line-down',
          },
          ctx(100, 20, 10),
        ),
      ).toBe(4);
    });

    test('boundary at the top: cannot exceed maxOffset', () => {
      // totalLines=30, viewportLines=20 → maxOffset=10.
      expect(
        applyScrollAction(
          10,
          {
            kind: 'line-up',
          },
          ctx(30, 20, 10),
        ),
      ).toBe(10);
    });

    test('boundary at the bottom: cannot go negative', () => {
      expect(
        applyScrollAction(
          0,
          {
            kind: 'line-down',
          },
          ctx(100, 20, 10),
        ),
      ).toBe(0);
    });

    test('boundary at maxOffset N-1, N, N+1 (line-up)', () => {
      // totalLines=25, viewportLines=20 → maxOffset=5.
      expect(
        applyScrollAction(
          4,
          {
            kind: 'line-up',
          },
          ctx(25, 20, 10),
        ),
      ).toBe(5);
      expect(
        applyScrollAction(
          5,
          {
            kind: 'line-up',
          },
          ctx(25, 20, 10),
        ),
      ).toBe(5);
      // Pre-clamped offset past max clamps on the way through.
      expect(
        applyScrollAction(
          6,
          {
            kind: 'line-up',
          },
          ctx(25, 20, 10),
        ),
      ).toBe(5);
    });
  });

  describe('home', () => {
    test('jumps to maxOffset (top of content)', () => {
      // totalLines=200, viewportLines=20 → maxOffset=180.
      expect(
        applyScrollAction(
          0,
          {
            kind: 'home',
          },
          ctx(200, 20, 10),
        ),
      ).toBe(180);
      expect(
        applyScrollAction(
          50,
          {
            kind: 'home',
          },
          ctx(200, 20, 10),
        ),
      ).toBe(180);
    });

    test('stays at 0 for an empty transcript', () => {
      expect(
        applyScrollAction(
          0,
          {
            kind: 'home',
          },
          ctx(0, 20, 10),
        ),
      ).toBe(0);
    });

    test('stays at 0 when content fits in the viewport', () => {
      expect(
        applyScrollAction(
          0,
          {
            kind: 'home',
          },
          ctx(10, 20, 10),
        ),
      ).toBe(0);
    });
  });

  describe('end', () => {
    test('jumps to the bottom (offset 0)', () => {
      expect(
        applyScrollAction(
          120,
          {
            kind: 'end',
          },
          ctx(200, 20, 10),
        ),
      ).toBe(0);
      expect(
        applyScrollAction(
          0,
          {
            kind: 'end',
          },
          ctx(200, 20, 10),
        ),
      ).toBe(0);
    });

    test('jumps to 0 even if the current offset was over-max (stale)', () => {
      // A stale offset from a longer transcript still resolves to 0.
      expect(
        applyScrollAction(
          500,
          {
            kind: 'end',
          },
          ctx(50, 20, 10),
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
          ctx(100, 20, 10),
        ),
      ).toBe(5);
    });

    test('pulls an over-max offset down to the new ceiling', () => {
      // Transcript shrank → totalLines=30, viewportLines=20 → maxOffset=10.
      // Stale offset 30 must clamp to 10.
      expect(
        applyScrollAction(
          30,
          {
            kind: 'clamp',
          },
          ctx(30, 20, 10),
        ),
      ).toBe(10);
    });

    test('pulls a negative offset (defensive) up to 0', () => {
      expect(
        applyScrollAction(
          -5,
          {
            kind: 'clamp',
          },
          ctx(100, 20, 10),
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
          ctx(0, 20, 10),
        ),
      ).toBe(0);
    });

    test('collapses to 0 when the viewport now contains all content', () => {
      // User resized terminal larger; content now fits without scroll.
      expect(
        applyScrollAction(
          7,
          {
            kind: 'clamp',
          },
          ctx(10, 20, 10),
        ),
      ).toBe(0);
    });
  });
});
