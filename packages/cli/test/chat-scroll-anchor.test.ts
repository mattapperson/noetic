import { describe, expect, test } from 'bun:test';
import {
  anchoredOffsetAfterDelta,
  WHEEL_LINES,
  wheelDownClamp,
  wheelUpClamp,
} from '../src/tui/components/chat-scroll-anchor.js';

describe('anchoredOffsetAfterDelta', () => {
  test('stuck-to-bottom (prev=0) stays stuck regardless of content growth', () => {
    expect(
      anchoredOffsetAfterDelta({
        prev: 0,
        delta: 10,
        totalLines: 200,
        viewportLines: 24,
      }),
    ).toBe(0);
    expect(
      anchoredOffsetAfterDelta({
        prev: 0,
        delta: 0,
        totalLines: 50,
        viewportLines: 24,
      }),
    ).toBe(0);
  });

  test('detached + content grew: offset advances by delta (same content rows stay visible)', () => {
    // viewport=24, prev offset=20 → user was looking at content rows
    // [H-44, H-20). totalLines was 100, grew by 5 → now 105. To keep the
    // SAME rows visible the offset must move to 25 so the bottom 25 are
    // hidden, leaving rows [H-44, H-20) i.e. [61, 85) of the new H=105
    // visible.
    expect(
      anchoredOffsetAfterDelta({
        prev: 20,
        delta: 5,
        totalLines: 105,
        viewportLines: 24,
      }),
    ).toBe(25);
  });

  test('detached + content unchanged: offset is unchanged', () => {
    expect(
      anchoredOffsetAfterDelta({
        prev: 12,
        delta: 0,
        totalLines: 100,
        viewportLines: 24,
      }),
    ).toBe(12);
  });

  test('detached + content shrank: clamp to new ceiling (anchor model does not apply)', () => {
    // Transcript shrunk (clear / truncation) — old offset 30 is past the
    // new max of max(0, 40 - 24) = 16.
    expect(
      anchoredOffsetAfterDelta({
        prev: 30,
        delta: -60,
        totalLines: 40,
        viewportLines: 24,
      }),
    ).toBe(16);
  });

  test('detached + transcript empties: offset collapses to 0', () => {
    expect(
      anchoredOffsetAfterDelta({
        prev: 5,
        delta: -100,
        totalLines: 0,
        viewportLines: 24,
      }),
    ).toBe(0);
  });

  test('detached at the top: anchor preserves the "(top)" state across growth', () => {
    // prev=80 was the max for totalLines=104. After +5 growth, the new
    // max is 85; anchored offset 85 keeps the user pinned at the top of
    // content as new entries arrive.
    expect(
      anchoredOffsetAfterDelta({
        prev: 80,
        delta: 5,
        totalLines: 109,
        viewportLines: 24,
      }),
    ).toBe(85);
  });

  test('negative result is defensively clamped to 0', () => {
    expect(
      anchoredOffsetAfterDelta({
        prev: -5,
        delta: 0,
        totalLines: 100,
        viewportLines: 24,
      }),
    ).toBe(0);
  });
});

describe('wheelUpClamp', () => {
  test('advances by WHEEL_LINES on each notch', () => {
    expect(
      wheelUpClamp({
        prev: 0,
        totalLines: 200,
        viewportLines: 24,
      }),
    ).toBe(WHEEL_LINES);
    expect(
      wheelUpClamp({
        prev: WHEEL_LINES,
        totalLines: 200,
        viewportLines: 24,
      }),
    ).toBe(WHEEL_LINES * 2);
  });

  test('clamps at maxOffset so the wheel cannot scroll past the top', () => {
    // maxOffset(30, 24) = 6. 5 + 3 = 8 but clamps to 6.
    expect(
      wheelUpClamp({
        prev: 5,
        totalLines: 30,
        viewportLines: 24,
      }),
    ).toBe(6);
  });

  test('no-op when content fits the viewport (maxOffset === 0)', () => {
    expect(
      wheelUpClamp({
        prev: 0,
        totalLines: 5,
        viewportLines: 24,
      }),
    ).toBe(0);
  });
});

describe('wheelDownClamp', () => {
  test('retreats by WHEEL_LINES on each notch', () => {
    expect(wheelDownClamp(20)).toBe(20 - WHEEL_LINES);
    expect(wheelDownClamp(WHEEL_LINES)).toBe(0);
  });

  test('cannot go negative', () => {
    expect(wheelDownClamp(2)).toBe(0);
    expect(wheelDownClamp(0)).toBe(0);
  });
});

describe('WHEEL_LINES contract', () => {
  test('is 3 — the conventional wheel-notch multiplier (pin so a future tweak surfaces)', () => {
    expect(WHEEL_LINES).toBe(3);
  });
});
