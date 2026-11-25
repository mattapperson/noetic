import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { ZodError, z } from 'zod';
import { failureCause, isNoeticError, NoeticErrorImpl } from '../src/errors/noetic-error';

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

describe('spawn_summary_failed', () => {
  it('carries the child output and names the step and cause in the message', () => {
    const err = new NoeticErrorImpl({
      kind: 'spawn_summary_failed',
      stepId: 'research',
      childOutput: 'raw findings',
      summaryCause: new Error('summarizer timed out'),
    });
    assert(err.noeticError.kind === 'spawn_summary_failed');
    expect(err.noeticError.childOutput).toBe('raw findings');
    expect(err.message).toBe("Spawn 'research' summary failed: summarizer timed out");
  });
});

describe('NoeticErrorImpl cause (#140)', () => {
  class TypedFailure extends Error {
    constructor(readonly code: string) {
      super(code);
      this.name = 'TypedFailure';
    }
  }

  it('sets the standard Error.cause to a step_failed error’s cause', () => {
    const original = new TypedFailure('http_500');
    const err = new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: 'inner',
      cause: original,
      retriesExhausted: false,
    });
    expect(err.cause).toBe(original);
    expect(err.noeticError.kind).toBe('step_failed');
  });

  it('sets Error.cause to a spawn_summary_failed error’s summaryCause', () => {
    const original = new Error('summary broke');
    const err = new NoeticErrorImpl({
      kind: 'spawn_summary_failed',
      stepId: 's',
      childOutput: null,
      summaryCause: original,
    });
    expect(err.cause).toBe(original);
  });

  it('leaves Error.cause unset for a kind that carries no cause', () => {
    const err = new NoeticErrorImpl({
      kind: 'cancelled',
    });
    expect('cause' in err).toBe(false);
  });
});

describe('failureCause', () => {
  it('returns the error at the bottom of nested step_failed wrappers', () => {
    const original = new RangeError('deep');
    const inner = new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: 'inner',
      cause: original,
      retriesExhausted: false,
    });
    const outer = new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: 'outer',
      cause: inner,
      retriesExhausted: false,
    });
    expect(failureCause(outer)).toBe(original);
  });

  it('returns a NoeticError without a cause as is', () => {
    const cancelled = new NoeticErrorImpl({
      kind: 'cancelled',
    });
    expect(failureCause(cancelled)).toBe(cancelled);
  });

  it('returns a plain error or a non-error value as is', () => {
    const plain = new Error('plain');
    expect(failureCause(plain)).toBe(plain);
    expect(failureCause('text')).toBe('text');
    expect(failureCause(undefined)).toBeUndefined();
  });

  it('stops at a plain Error even when that error has its own cause', () => {
    const root = new Error('root');
    const plain = new Error('plain', {
      cause: root,
    });
    const wrapped = new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: 's',
      cause: plain,
      retriesExhausted: false,
    });
    expect(failureCause(wrapped)).toBe(plain);
  });

  it('stops after a bounded depth on a cyclic chain', () => {
    const a = new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: 'a',
      cause: new Error('placeholder'),
      retriesExhausted: false,
    });
    Object.defineProperty(a, 'cause', {
      value: a,
    });
    expect(failureCause(a)).toBe(a);
  });
});
