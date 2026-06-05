import { describe, expect, it } from 'bun:test';
import { frameworkCast } from '@noetic-tools/types';

describe('frameworkCast', () => {
  it('returns the value unchanged for primitives', () => {
    expect(frameworkCast<string>('hello')).toBe('hello');
    expect(frameworkCast<number>(42)).toBe(42);
    expect(frameworkCast<boolean>(true)).toBe(true);
  });

  it('returns the value unchanged for objects', () => {
    const obj = {
      a: 1,
      b: 'two',
    };
    expect(frameworkCast<typeof obj>(obj)).toBe(obj);
  });

  it('returns the value unchanged for arrays', () => {
    const arr = [
      1,
      2,
      3,
    ];
    expect(frameworkCast<number[]>(arr)).toBe(arr);
  });

  it('passes through null and undefined', () => {
    expect(frameworkCast<null>(null)).toBeNull();
    expect(frameworkCast<undefined>(undefined)).toBeUndefined();
  });
});
