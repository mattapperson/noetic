import { describe, it, expect } from 'bun:test';
import { OrchidErrorImpl, isOrchidError } from '../../src/errors/orchid-error';
import type { OrchidError } from '../../src/types/error';
import { z, ZodError } from 'zod';

describe('OrchidError', () => {
  describe('constructors for each kind', () => {
    it('step_failed', () => {
      const e = new OrchidErrorImpl({ kind: 'step_failed', stepId: 'test', cause: new Error('boom'), retriesExhausted: true });
      expect(e.orchidError.kind).toBe('step_failed');
      expect(e.message).toContain("Step 'test' failed");
      expect(e.message).toContain('boom');
    });

    it('llm_refused', () => {
      const e = new OrchidErrorImpl({ kind: 'llm_refused', stepId: 'llm-1', refusal: 'I cannot help with that' });
      expect(e.orchidError.kind).toBe('llm_refused');
      expect(e.message).toContain('refused');
    });

    it('llm_parse_error', () => {
      const schema = z.object({ x: z.number() });
      const zodError = new ZodError([{ code: 'custom', message: 'invalid', path: [] }]);
      const e = new OrchidErrorImpl({ kind: 'llm_parse_error', stepId: 'p', raw: 'bad', schema, zodError });
      expect(e.orchidError.kind).toBe('llm_parse_error');
      expect(e.message).toContain('parse error');
    });

    it('llm_rate_limit', () => {
      const e = new OrchidErrorImpl({ kind: 'llm_rate_limit', stepId: 'rl', retryAfter: 5000 });
      expect(e.orchidError.kind).toBe('llm_rate_limit');
      expect(e.message).toContain('rate limited');
    });

    it('fork_partial', () => {
      const e = new OrchidErrorImpl({
        kind: 'fork_partial', stepId: 'fork-1',
        succeeded: [{ stepId: 'a', value: 'ok' }],
        failed: [{ stepId: 'b', error: { kind: 'cancelled' } as OrchidError }],
      });
      expect(e.orchidError.kind).toBe('fork_partial');
      expect(e.message).toContain('1 succeeded');
      expect(e.message).toContain('1 failed');
    });

    it('spawn_summary_failed', () => {
      const e = new OrchidErrorImpl({ kind: 'spawn_summary_failed', stepId: 's', childOutput: 'data', summaryCause: new Error('LLM down') });
      expect(e.orchidError.kind).toBe('spawn_summary_failed');
      if (e.orchidError.kind === 'spawn_summary_failed') {
        expect(e.orchidError.childOutput).toBe('data');
      }
    });

    it('channel_timeout', () => {
      const e = new OrchidErrorImpl({ kind: 'channel_timeout', channelName: 'ch1', timeout: 30000 });
      expect(e.orchidError.kind).toBe('channel_timeout');
      expect(e.message).toContain('30000ms');
    });

    it('channel_closed', () => {
      const e = new OrchidErrorImpl({ kind: 'channel_closed', channelName: 'ch1' });
      expect(e.orchidError.kind).toBe('channel_closed');
      expect(e.message).toContain('closed');
    });

    it('cancelled', () => {
      const e = new OrchidErrorImpl({ kind: 'cancelled', reason: 'user abort' });
      expect(e.orchidError.kind).toBe('cancelled');
      expect(e.message).toContain('user abort');
    });

    it('cancelled without reason', () => {
      const e = new OrchidErrorImpl({ kind: 'cancelled' });
      expect(e.message).toContain('Cancelled');
    });

    it('budget_exceeded', () => {
      const e = new OrchidErrorImpl({ kind: 'budget_exceeded', field: 'cost', limit: 1.0, actual: 1.5 });
      expect(e.orchidError.kind).toBe('budget_exceeded');
      expect(e.message).toContain('cost');
    });
  });

  describe('isOrchidError guard', () => {
    it('returns true for OrchidErrorImpl', () => {
      const e = new OrchidErrorImpl({ kind: 'cancelled' });
      expect(isOrchidError(e)).toBe(true);
    });

    it('returns false for regular Error', () => {
      expect(isOrchidError(new Error('nope'))).toBe(false);
    });

    it('returns false for non-errors', () => {
      expect(isOrchidError('string')).toBe(false);
      expect(isOrchidError(null)).toBe(false);
      expect(isOrchidError(undefined)).toBe(false);
    });
  });

  describe('serializable', () => {
    it('orchidError is serializable to JSON', () => {
      const e = new OrchidErrorImpl({
        kind: 'step_failed', stepId: 'test',
        cause: new Error('boom'), retriesExhausted: true,
      });
      const serialized = JSON.parse(JSON.stringify(e.orchidError, (key, value) => {
        if (value instanceof Error) return { message: value.message, name: value.name };
        return value;
      }));
      expect(serialized.kind).toBe('step_failed');
      expect(serialized.stepId).toBe('test');
    });
  });

  describe('extends Error', () => {
    it('is instanceof Error', () => {
      const e = new OrchidErrorImpl({ kind: 'cancelled' });
      expect(e instanceof Error).toBe(true);
    });

    it('has name OrchidError', () => {
      const e = new OrchidErrorImpl({ kind: 'cancelled' });
      expect(e.name).toBe('OrchidError');
    });

    it('can be caught in try/catch', () => {
      try {
        throw new OrchidErrorImpl({ kind: 'cancelled' });
      } catch (e) {
        expect(isOrchidError(e)).toBe(true);
      }
    });
  });
});
