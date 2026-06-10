import { describe, expect, it } from 'bun:test';
import { isNoeticError, NoeticErrorImpl } from '../src/errors/noetic-error';

describe('isNoeticError', () => {
  it('returns true for a real NoeticErrorImpl instance (regression)', () => {
    const err = new NoeticErrorImpl({
      kind: 'cancelled',
      reason: 'test',
    });
    expect(isNoeticError(err)).toBe(true);
  });

  it('returns true for a duck-typed Error with a valid noeticError shape', () => {
    const err = Object.assign(new Error('Cancelled: cross-realm'), {
      noeticError: {
        kind: 'cancelled',
        reason: 'cross-realm',
      },
    });
    expect(isNoeticError(err)).toBe(true);
  });

  it('returns true for an unknown future kind (forward compatibility)', () => {
    const err = Object.assign(new Error('future'), {
      noeticError: {
        kind: 'some_future_kind',
      },
    });
    expect(isNoeticError(err)).toBe(true);
  });

  it('returns false for a plain object with the right shape (not an Error)', () => {
    const notAnError = {
      noeticError: {
        kind: 'cancelled',
      },
    };
    expect(isNoeticError(notAnError)).toBe(false);
  });

  it('returns false when noeticError.kind is not a string', () => {
    const err = Object.assign(new Error('bad kind'), {
      noeticError: {
        kind: 42,
      },
    });
    expect(isNoeticError(err)).toBe(false);
  });

  it('returns false when noeticError is null', () => {
    const err = Object.assign(new Error('null inner'), {
      noeticError: null,
    });
    expect(isNoeticError(err)).toBe(false);
  });

  it('returns false for an Error without a noeticError property', () => {
    expect(isNoeticError(new Error('plain'))).toBe(false);
  });

  it('returns false for null and undefined', () => {
    expect(isNoeticError(null)).toBe(false);
    expect(isNoeticError(undefined)).toBe(false);
  });
});
