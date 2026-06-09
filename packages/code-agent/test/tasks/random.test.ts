import { describe, expect, it } from 'bun:test';

import { randomBase64Url, randomHex } from '../../src/tasks/random';

describe('randomHex', () => {
  it('returns 2 hex chars per byte', () => {
    expect(randomHex(6)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('returns an empty string for n=0', () => {
    expect(randomHex(0)).toBe('');
  });

  it('produces different values across calls (with very high probability)', () => {
    expect(randomHex(16)).not.toBe(randomHex(16));
  });
});

describe('randomBase64Url', () => {
  it('uses the URL-safe alphabet with no padding', () => {
    const value = randomBase64Url(12);
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(value).not.toContain('=');
    expect(value).not.toContain('+');
    expect(value).not.toContain('/');
  });

  it('returns an empty string for n=0', () => {
    expect(randomBase64Url(0)).toBe('');
  });

  it('produces different values across calls (with very high probability)', () => {
    expect(randomBase64Url(16)).not.toBe(randomBase64Url(16));
  });
});
