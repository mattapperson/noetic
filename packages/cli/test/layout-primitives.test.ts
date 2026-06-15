/**
 * Unit tests for the Context Split View layout primitives.
 * See specs/28-context-split-view.md.
 */

import { describe, expect, test } from 'bun:test';
import { CHAT_MIN_WIDTH, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from '../src/tui/layout/constants.js';
import { decideLayoutMode } from '../src/tui/layout/decide-layout-mode.js';
import { nextFocus } from '../src/tui/layout/next-focus.js';
import { resolvePanelWidth } from '../src/tui/layout/resolve-panel-width.js';
import { PANEL_CONFIG_MAX, PANEL_CONFIG_MIN } from '../src/types/config.js';

describe('decideLayoutMode', () => {
  // Thresholds below are intentionally hard-coded (not derived from
  // CHAT_MIN_WIDTH / PANEL_MIN_WIDTH) so a future tweak to those constants
  // can't silently slide these boundary tests along with it.
  test('109 cols with a 49-col panel is wide (exact threshold, 49+60)', () => {
    expect(decideLayoutMode(109, 49)).toBe('wide');
  });

  test('108 cols with a 49-col panel is narrow (one below threshold)', () => {
    expect(decideLayoutMode(108, 49)).toBe('narrow');
  });

  test('returns wide when cols is much larger', () => {
    expect(decideLayoutMode(200, 40)).toBe('wide');
  });

  test('tiny terminals are narrow', () => {
    expect(decideLayoutMode(40, PANEL_MIN_WIDTH)).toBe('narrow');
  });

  test('CHAT_MIN_WIDTH constant invariants are still met', () => {
    // Sanity tie-in so a future bump to CHAT_MIN_WIDTH that *should* break
    // the hard-coded tests above is at least visible here.
    expect(CHAT_MIN_WIDTH).toBe(60);
    expect(PANEL_MIN_WIDTH).toBe(49);
  });
});

describe('width-bound invariants', () => {
  // The user-facing fixed-config floor must never fall below the layout
  // render floor — otherwise a pinned value would silently clamp up at
  // render time. Bounds live in two files (types/config.ts owns the Zod
  // schema; layout/constants.ts owns the layout floor) because of sentrux
  // layering; this test guards the alignment.
  test('PANEL_CONFIG_MIN ≥ PANEL_MIN_WIDTH', () => {
    expect(PANEL_CONFIG_MIN).toBeGreaterThanOrEqual(PANEL_MIN_WIDTH);
  });

  test('PANEL_CONFIG_MAX is wider than the responsive ceiling', () => {
    // Users on extreme-width terminals should be able to pin a panel
    // wider than the responsive formula would ever pick.
    expect(PANEL_CONFIG_MAX).toBeGreaterThan(PANEL_MAX_WIDTH);
  });
});

describe('resolvePanelWidth — responsive', () => {
  test('floors 40 percent of cols within clamp range', () => {
    // 40% of 160 = 64 — between MIN (49) and MAX (72).
    expect(resolvePanelWidth(160, 'responsive')).toBe(64);
  });

  test('clamps to PANEL_MIN_WIDTH when the terminal is narrow', () => {
    // 40% of 100 = 40 → clamped up to PANEL_MIN_WIDTH (49).
    expect(resolvePanelWidth(100, 'responsive')).toBe(PANEL_MIN_WIDTH);
  });

  test('clamps to PANEL_MAX_WIDTH when the terminal is huge', () => {
    // 40% of 300 = 120 → clamped down to PANEL_MAX_WIDTH (72).
    expect(resolvePanelWidth(300, 'responsive')).toBe(PANEL_MAX_WIDTH);
  });

  test('caps at cols so a tiny terminal never gets a panel wider than the screen', () => {
    // PANEL_MIN_WIDTH is 49, but on a 10-col terminal we cap at the
    // terminal width itself — anything else would render broken borders.
    expect(resolvePanelWidth(10, 'responsive')).toBe(10);
  });

  test('responsive transitions at the 180-col threshold (40% × 180 = 72 = PANEL_MAX_WIDTH)', () => {
    expect(resolvePanelWidth(179, 'responsive')).toBe(71);
    expect(resolvePanelWidth(180, 'responsive')).toBe(PANEL_MAX_WIDTH);
    expect(resolvePanelWidth(181, 'responsive')).toBe(PANEL_MAX_WIDTH);
  });
});

describe('resolvePanelWidth — fixed numeric', () => {
  test('honors the requested fixed width when room allows', () => {
    expect(resolvePanelWidth(200, 60)).toBe(60);
  });

  test('clamps the requested width down so chat can keep CHAT_MIN_WIDTH', () => {
    // cols=120, request=80 → chat would be 40 < CHAT_MIN_WIDTH(60). Clamp
    // panel down to 120 - 60 = 60.
    expect(resolvePanelWidth(120, 80)).toBe(60);
  });

  test('does not crowd below PANEL_MIN_WIDTH — leaves request alone (narrow mode will pick stack)', () => {
    // Terminal too small to fit both at any reasonable size — leave the
    // requested value, decideLayoutMode picks narrow.
    expect(resolvePanelWidth(80, 60)).toBe(60);
  });

  test('respects PANEL_MIN_WIDTH floor even for small numeric requests', () => {
    expect(resolvePanelWidth(200, 20)).toBe(PANEL_MIN_WIDTH);
  });

  test('caps fixed config at cols so a tiny terminal never overflows the screen', () => {
    // Request 60 but terminal is only 50 cols. Must NOT return 60 (would
    // overflow the screen and break borders). The narrow stack handles the
    // tight fit at render time.
    expect(resolvePanelWidth(50, 60)).toBe(50);
  });
});

describe('nextFocus', () => {
  test('chat → context', () => {
    expect(nextFocus('chat')).toBe('context');
  });

  test('context → chat', () => {
    expect(nextFocus('context')).toBe('chat');
  });
});
