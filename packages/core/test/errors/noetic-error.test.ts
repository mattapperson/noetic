import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { NoeticError } from '@noetic-tools/types';
import { isNoeticError, NoeticErrorImpl } from '@noetic-tools/types';
import { ZodError, z } from 'zod';

describe('NoeticError', () => {
  describe('constructors for each kind', () => {
    it('step_failed', () => {
      const e = new NoeticErrorImpl({
        kind: 'step_failed',
        stepId: 'test',
        cause: new Error('boom'),
        retriesExhausted: true,
      });
      expect(e.noeticError.kind).toBe('step_failed');
      expect(e.message).toContain("Step 'test' failed");
      expect(e.message).toContain('boom');
    });

    it('llm_refused', () => {
      const e = new NoeticErrorImpl({
        kind: 'llm_refused',
        stepId: 'llm-1',
        refusal: 'I cannot help with that',
      });
      expect(e.noeticError.kind).toBe('llm_refused');
      expect(e.message).toContain('refused');
    });

    it('llm_parse_error', () => {
      const schema = z.object({
        x: z.number(),
      });
      const zodError = new ZodError([
        {
          code: 'custom',
          message: 'invalid',
          path: [],
        },
      ]);
      const e = new NoeticErrorImpl({
        kind: 'llm_parse_error',
        stepId: 'p',
        raw: 'bad',
        schema,
        zodError,
      });
      expect(e.noeticError.kind).toBe('llm_parse_error');
      expect(e.message).toContain('parse error');
    });

    it('llm_rate_limit', () => {
      const e = new NoeticErrorImpl({
        kind: 'llm_rate_limit',
        stepId: 'rl',
        retryAfter: 5e3,
      });
      expect(e.noeticError.kind).toBe('llm_rate_limit');
      expect(e.message).toContain('rate limited');
    });

    it('fork_partial', () => {
      const e = new NoeticErrorImpl({
        kind: 'fork_partial',
        stepId: 'fork-1',
        succeeded: [
          {
            stepId: 'a',
            value: 'ok',
          },
        ],
        failed: [
          {
            stepId: 'b',
            error: {
              kind: 'cancelled',
            } satisfies NoeticError,
          },
        ],
      });
      expect(e.noeticError.kind).toBe('fork_partial');
      expect(e.message).toContain('1 succeeded');
      expect(e.message).toContain('1 failed');
    });

    it('channel_timeout', () => {
      const e = new NoeticErrorImpl({
        kind: 'channel_timeout',
        channelName: 'ch1',
        timeout: 3e4,
      });
      expect(e.noeticError.kind).toBe('channel_timeout');
      expect(e.message).toContain('30000ms');
    });

    it('channel_closed', () => {
      const e = new NoeticErrorImpl({
        kind: 'channel_closed',
        channelName: 'ch1',
      });
      expect(e.noeticError.kind).toBe('channel_closed');
      expect(e.message).toContain('closed');
    });

    it('cancelled', () => {
      const e = new NoeticErrorImpl({
        kind: 'cancelled',
        reason: 'user abort',
      });
      expect(e.noeticError.kind).toBe('cancelled');
      expect(e.message).toContain('user abort');
    });

    it('cancelled without reason', () => {
      const e = new NoeticErrorImpl({
        kind: 'cancelled',
      });
      expect(e.message).toContain('Cancelled');
    });

    it('budget_exceeded', () => {
      const e = new NoeticErrorImpl({
        kind: 'budget_exceeded',
        field: 'cost',
        limit: 1.0,
        actual: 1.5,
      });
      expect(e.noeticError.kind).toBe('budget_exceeded');
      expect(e.message).toContain('cost');
    });
  });

  describe('formatMessage default branch', () => {
    it('unknown kind produces fallback message', () => {
      const e = new NoeticErrorImpl({
        // @ts-expect-error — intentionally passing invalid kind to test runtime fallback branch
        kind: 'totally_unknown',
      });
      expect(e.message).toContain('NoeticError');
      expect(e.message).toContain('unknown kind');
    });
  });

  describe('isNoeticError guard', () => {
    it('returns true for NoeticErrorImpl', () => {
      const e = new NoeticErrorImpl({
        kind: 'cancelled',
      });
      expect(isNoeticError(e)).toBe(true);
    });

    it('returns false for regular Error', () => {
      expect(isNoeticError(new Error('nope'))).toBe(false);
    });

    it('returns false for non-errors', () => {
      expect(isNoeticError('string')).toBe(false);
      expect(isNoeticError(null)).toBe(false);
      expect(isNoeticError(undefined)).toBe(false);
    });
  });

  describe('serializable', () => {
    it('noeticError is serializable to JSON', () => {
      const e = new NoeticErrorImpl({
        kind: 'step_failed',
        stepId: 'test',
        cause: new Error('boom'),
        retriesExhausted: true,
      });
      const serialized = JSON.parse(
        JSON.stringify(e.noeticError, (_key, value) => {
          if (value instanceof Error) {
            return {
              message: value.message,
              name: value.name,
            };
          }
          return value;
        }),
      );
      expect(serialized.kind).toBe('step_failed');
      expect(serialized.stepId).toBe('test');
    });
  });

  describe('extends Error', () => {
    it('is instanceof Error', () => {
      const e = new NoeticErrorImpl({
        kind: 'cancelled',
      });
      expect(e instanceof Error).toBe(true);
    });

    it('has name NoeticError', () => {
      const e = new NoeticErrorImpl({
        kind: 'cancelled',
      });
      expect(e.name).toBe('NoeticError');
    });

    it('can be caught in try/catch', () => {
      try {
        throw new NoeticErrorImpl({
          kind: 'cancelled',
        });
      } catch (e) {
        assert(isNoeticError(e));
      }
    });
  });
});
