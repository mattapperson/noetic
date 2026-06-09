import { describe, expect, it } from 'bun:test';

import { formatRelativeTimeAgo, truncateFirstPrompt } from '../src/tui/components/resume/format.js';

const NOW = new Date('2026-05-01T12:00:00.000Z');

describe('formatRelativeTimeAgo', () => {
  it('returns "just now" within the 10-second window', () => {
    const then = new Date(NOW.getTime() - 5_000);
    expect(formatRelativeTimeAgo(then, NOW)).toBe('just now');
  });

  it('rounds seconds', () => {
    const then = new Date(NOW.getTime() - 35_000);
    expect(formatRelativeTimeAgo(then, NOW)).toBe('35s ago');
  });

  it('rounds minutes', () => {
    const then = new Date(NOW.getTime() - 5 * 60_000);
    expect(formatRelativeTimeAgo(then, NOW)).toBe('5m ago');
  });

  it('rounds hours', () => {
    const then = new Date(NOW.getTime() - 3 * 60 * 60_000);
    expect(formatRelativeTimeAgo(then, NOW)).toBe('3h ago');
  });

  it('rounds days below a week', () => {
    const then = new Date(NOW.getTime() - 4 * 24 * 60 * 60_000);
    expect(formatRelativeTimeAgo(then, NOW)).toBe('4d ago');
  });

  it('uses month + day within the same year beyond a week', () => {
    const then = new Date(2026, 1, 14, 12, 0, 0); // Feb 14, 2026 noon local
    const now = new Date(2026, 4, 1, 12, 0, 0); // May 1, 2026 noon local
    expect(formatRelativeTimeAgo(then, now)).toBe('Feb 14');
  });

  it('includes the year when different', () => {
    const then = new Date(2024, 11, 25, 12, 0, 0); // Dec 25, 2024 noon local
    const now = new Date(2026, 4, 1, 12, 0, 0); // May 1, 2026 noon local
    expect(formatRelativeTimeAgo(then, now)).toBe('Dec 25, 2024');
  });

  it('falls back to "just now" on future dates', () => {
    const then = new Date(NOW.getTime() + 60_000);
    expect(formatRelativeTimeAgo(then, NOW)).toBe('just now');
  });
});

describe('truncateFirstPrompt', () => {
  it('collapses whitespace', () => {
    expect(truncateFirstPrompt('a   b\nc')).toBe('a b c');
  });

  it('leaves short strings alone', () => {
    expect(truncateFirstPrompt('short')).toBe('short');
  });

  it('truncates with ellipsis over the limit', () => {
    const input = 'x'.repeat(200);
    const result = truncateFirstPrompt(input, 50);
    expect(result.length).toBe(50);
    expect(result.endsWith('…')).toBe(true);
  });
});
