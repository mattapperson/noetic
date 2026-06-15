/**
 * Unit tests for the Context Split View layout primitives.
 * See specs/28-context-split-view.md.
 */

import { describe, expect, test } from 'bun:test';
import { CHAT_MIN_WIDTH, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from '../src/tui/layout/constants.js';
import { decideLayoutMode } from '../src/tui/layout/decide-layout-mode.js';
import { nextFocus } from '../src/tui/layout/next-focus.js';
import { resolvePanelWidth } from '../src/tui/layout/resolve-panel-width.js';

describe('decideLayoutMode', () => {
  test('returns wide when cols >= panelWidth + CHAT_MIN_WIDTH', () => {
    expect(decideLayoutMode(PANEL_MIN_WIDTH + CHAT_MIN_WIDTH, PANEL_MIN_WIDTH)).toBe('wide');
  });

  test('returns wide when cols is much larger', () => {
    expect(decideLayoutMode(200, 40)).toBe('wide');
  });

  test('returns narrow when cols < panelWidth + CHAT_MIN_WIDTH', () => {
    expect(decideLayoutMode(PANEL_MIN_WIDTH + CHAT_MIN_WIDTH - 1, PANEL_MIN_WIDTH)).toBe('narrow');
  });

  test('boundary: exact threshold is wide (>= not >)', () => {
    const panel = 32;
    expect(decideLayoutMode(panel + CHAT_MIN_WIDTH, panel)).toBe('wide');
    expect(decideLayoutMode(panel + CHAT_MIN_WIDTH - 1, panel)).toBe('narrow');
  });

  test('tiny terminals are narrow', () => {
    expect(decideLayoutMode(40, PANEL_MIN_WIDTH)).toBe('narrow');
  });
});

describe('resolvePanelWidth — responsive', () => {
  test('floors 40 percent of cols within clamp range', () => {
    // 40% of 140 = 56 — between MIN (49) and MAX (56).
    expect(resolvePanelWidth(140, 'responsive')).toBe(56);
  });

  test('clamps to PANEL_MIN_WIDTH when the terminal is narrow', () => {
    // 40% of 100 = 40 → clamped up to PANEL_MIN_WIDTH (49).
    expect(resolvePanelWidth(100, 'responsive')).toBe(PANEL_MIN_WIDTH);
  });

  test('clamps to PANEL_MAX_WIDTH when the terminal is huge', () => {
    // 40% of 300 = 120 → clamped down to PANEL_MAX_WIDTH (56).
    expect(resolvePanelWidth(300, 'responsive')).toBe(PANEL_MAX_WIDTH);
  });

  test('returns PANEL_MIN_WIDTH on a tiny terminal', () => {
    expect(resolvePanelWidth(10, 'responsive')).toBe(PANEL_MIN_WIDTH);
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
});

describe('nextFocus', () => {
  test('chat → context', () => {
    expect(nextFocus('chat')).toBe('context');
  });

  test('context → chat', () => {
    expect(nextFocus('context')).toBe('chat');
  });
});
