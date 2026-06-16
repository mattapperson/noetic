import { describe, expect, test } from 'bun:test';
import { buildTitleBar } from '../src/tui/layout/title-bar.js';

describe('buildTitleBar', () => {
  test('focused bar carries the ► glyph and pads with horizontal rule chars', () => {
    const bar = buildTitleBar(20, true, 'chat');
    expect(bar).toBe('─ ► chat ───────────');
    expect(bar).toHaveLength(20);
  });

  test('unfocused bar uses two leading spaces in place of the glyph', () => {
    const bar = buildTitleBar(20, false, 'chat');
    expect(bar).toBe('─   chat ───────────');
    expect(bar).toHaveLength(20);
  });

  test('rule character is the same in focused and unfocused (chrome does not redraw on focus swap)', () => {
    const focused = buildTitleBar(40, true, 'Context');
    const unfocused = buildTitleBar(40, false, 'Context');
    // The dashes that fill the tail half should match position-by-position.
    expect(focused.slice(-20)).toBe(unfocused.slice(-20));
  });

  test('returns exactly `width` columns even when the title is wider than the bar', () => {
    const bar = buildTitleBar(8, true, 'LongerTitle');
    expect(bar).toHaveLength(8);
  });

  test('width of 0 returns the empty string', () => {
    expect(buildTitleBar(0, true, 'chat')).toBe('');
  });

  test('truncates from the right when width is smaller than the lead', () => {
    const bar = buildTitleBar(4, true, 'chat');
    expect(bar).toHaveLength(4);
    expect(bar.startsWith('─ ►')).toBe(true);
  });
});
