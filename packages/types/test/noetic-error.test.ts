import { describe, expect, it } from 'bun:test';
import { ZodError, z } from 'zod';
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

describe('model_* error kinds', () => {
  it('model_refused carries the kind and a Model-prefixed message', () => {
    const err = new NoeticErrorImpl({
      kind: 'model_refused',
      stepId: 's1',
      refusal: 'no',
    });
    expect(err.noeticError.kind).toBe('model_refused');
    expect(err.message).toContain("Model refused at step 's1'");
  });

  it('model_parse_error carries the kind and a Model-prefixed message', () => {
    const err = new NoeticErrorImpl({
      kind: 'model_parse_error',
      stepId: 's2',
      raw: '{',
      schema: z.object({}),
      zodError: new ZodError([]),
    });
    expect(err.noeticError.kind).toBe('model_parse_error');
    expect(err.message).toContain("Model parse error at step 's2'");
  });

  it('model_rate_limit carries the kind and a Model-prefixed message', () => {
    const err = new NoeticErrorImpl({
      kind: 'model_rate_limit',
      stepId: 's3',
      retryAfter: 250,
    });
    expect(err.noeticError.kind).toBe('model_rate_limit');
    expect(err.message).toContain("Model rate limited at step 's3'");
    expect(err.message).toContain('retry after 250ms');
  });
});
