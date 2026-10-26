import { describe, expect, it } from 'bun:test';
import type { Snapshot, Until } from '@noetic-tools/types';
import { all, any } from '../../src/until/combinators';
import { until } from '../../src/until/predicates';
import { makeStorage, mockEmbed } from '../_helpers';

function makeSnap(overrides?: Partial<Snapshot>): Snapshot {
  return {
    stepCount: 0,
    tokens: {
      input: 0,
      output: 0,
      total: 0,
    },
    elapsed: 0,
    cost: 0,
    lastOutput: null,
    lastText: '',
    history: [],
    depth: 0,
    ...overrides,
  };
}

describe('until predicates', () => {
  describe('maxSteps', () => {
    it('does not stop below threshold', async () => {
      const pred = until.maxSteps(3);
      const verdict = await pred(
        makeSnap({
          stepCount: 2,
        }),
      );
      expect(verdict.stop).toBe(false);
      expect(verdict.reason).toBeUndefined();
    });

    it('stops when step count reached', async () => {
      const pred = until.maxSteps(3);
      const verdict = await pred(
        makeSnap({
          stepCount: 3,
        }),
      );
      expect(verdict.stop).toBe(true);
      expect(verdict.reason).toBe('Reached max steps (3)');
    });

    it('stops when step count exceeded', async () => {
      const pred = until.maxSteps(3);
      const verdict = await pred(
        makeSnap({
          stepCount: 5,
        }),
      );
      expect(verdict.stop).toBe(true);
    });
  });

  describe('maxCost', () => {
    it('does not stop one cent below budget', async () => {
      const pred = until.maxCost(1.0);
      const verdict = await pred(
        makeSnap({
          cost: 0.99,
        }),
      );
      expect(verdict.stop).toBe(false);
      expect(verdict.reason).toBeUndefined();
    });

    it('stops at budget', async () => {
      const pred = until.maxCost(1.0);
      const verdict = await pred(
        makeSnap({
          cost: 1.0,
        }),
      );
      expect(verdict.stop).toBe(true);
      expect(verdict.reason).toBe('Cost $1.00 exceeded budget $1.00');
    });

    it('stops one cent above budget and reports the actual cost', async () => {
      const pred = until.maxCost(1.0);
      const verdict = await pred(
        makeSnap({
          cost: 1.01,
        }),
      );
      expect(verdict.stop).toBe(true);
      expect(verdict.reason).toBe('Cost $1.01 exceeded budget $1.00');
    });
    it('counts held spend: one cent below budget does not stop', async () => {
      const verdict = await until.maxCost(1.0)(
        makeSnap({
          cost: 0.59,
          heldCost: 0.4,
        }),
      );
      expect(verdict.stop).toBe(false);
    });

    it('counts held spend: reaching budget with the hold stops', async () => {
      const verdict = await until.maxCost(1.0)(
        makeSnap({
          cost: 0.6,
          heldCost: 0.4,
        }),
      );
      expect(verdict.stop).toBe(true);
      expect(verdict.reason).toBe('Cost $1.00 exceeded budget $1.00');
    });

    it('counts held spend: one cent over budget with the hold stops', async () => {
      const verdict = await until.maxCost(1.0)(
        makeSnap({
          cost: 0.61,
          heldCost: 0.4,
        }),
      );
      expect(verdict.stop).toBe(true);
    });
  });

  describe('maxDuration', () => {
    it('does not stop below threshold', async () => {
      const pred = until.maxDuration(5_000);
      const verdict = await pred(
        makeSnap({
          elapsed: 3_000,
        }),
      );
      expect(verdict.stop).toBe(false);
    });

    it('stops when duration reached', async () => {
      const pred = until.maxDuration(5_000);
      const verdict = await pred(
        makeSnap({
          elapsed: 5_000,
        }),
      );
      expect(verdict.stop).toBe(true);
      expect(verdict.reason).toContain('max duration');
    });
  });

  describe('noToolCalls', () => {
    it('does not stop on first step', async () => {
      const pred = until.noToolCalls();
      const snap = makeSnap({
        stepCount: 0,
      });
      const verdict = await pred(snap);
      expect(verdict.stop).toBe(false);
    });

    it('stops when no tool calls in last step', async () => {
      const pred = until.noToolCalls();
      const snap = {
        ...makeSnap({
          stepCount: 2,
        }),
        lastStepMeta: {
          toolCalls: undefined,
        },
      };
      const verdict = await pred(snap);
      expect(verdict.stop).toBe(true);
    });

    it('stops when tool calls array is empty', async () => {
      const pred = until.noToolCalls();
      const snap = {
        ...makeSnap({
          stepCount: 2,
        }),
        lastStepMeta: {
          toolCalls: [],
        },
      };
      const verdict = await pred(snap);
      expect(verdict.stop).toBe(true);
    });

    it('does not stop when tool calls present', async () => {
      const pred = until.noToolCalls();
      const snap = {
        ...makeSnap({
          stepCount: 2,
        }),
        lastStepMeta: {
          toolCalls: [
            {
              id: '1',
              status: 'completed' as const,
              type: 'function_call' as const,
              callId: 'c1',
              name: 'search',
              arguments: '{}',
            },
          ],
        },
      };
      const verdict = await pred(snap);
      expect(verdict.stop).toBe(false);
    });
  });

  describe('verified', () => {
    it('stops when verification passes', async () => {
      const pred = until.verified(async (output) => ({
        pass: output === 'correct',
      }));
      const snap = makeSnap({
        lastOutput: 'correct',
      });
      const verdict = await pred(snap);
      expect(verdict.stop).toBe(true);
      expect(verdict.reason).toBe('Verification passed');
    });

    it('does not stop when verification fails', async () => {
      const pred = until.verified(async () => ({
        pass: false,
        feedback: 'Try again',
      }));
      const snap = makeSnap({
        lastOutput: 'wrong',
      });
      const verdict = await pred(snap);
      expect(verdict.stop).toBe(false);
      expect(verdict.feedback).toBe('Try again');
    });

    it('reports failure as the reason', async () => {
      const pred = until.verified(async () => ({
        pass: false,
      }));
      const verdict = await pred(makeSnap());
      expect(verdict.reason).toBe('Verification failed');
    });
  });

  describe('converged', () => {
    it('does not stop on first call', async () => {
      const pred = until.converged({
        threshold: 0.9,
      });
      const verdict = await pred(
        makeSnap({
          lastText: 'hello',
        }),
      );
      expect(verdict.stop).toBe(false);
    });

    it('stops when output is identical', async () => {
      const pred = until.converged({
        threshold: 0.9,
      });
      await pred(
        makeSnap({
          lastText: 'hello',
        }),
      );
      const verdict = await pred(
        makeSnap({
          lastText: 'hello',
        }),
      );
      expect(verdict.stop).toBe(true);
      expect(verdict.reason).toContain('converged');
    });

    it('does not stop when output changes', async () => {
      const pred = until.converged({
        threshold: 0.9,
      });
      await pred(
        makeSnap({
          lastText: 'hello',
        }),
      );
      const verdict = await pred(
        makeSnap({
          lastText: 'world',
        }),
      );
      expect(verdict.stop).toBe(false);
    });

    it('tracks across multiple calls', async () => {
      const pred = until.converged({
        threshold: 0.9,
      });
      await pred(
        makeSnap({
          lastText: 'a',
        }),
      );
      await pred(
        makeSnap({
          lastText: 'b',
        }),
      );
      await pred(
        makeSnap({
          lastText: 'c',
        }),
      );
      const verdict = await pred(
        makeSnap({
          lastText: 'c',
        }),
      );
      expect(verdict.stop).toBe(true);
    });
  });

  describe('outputContains', () => {
    it('does not stop when marker absent', async () => {
      const pred = until.outputContains('DONE');
      const verdict = await pred(
        makeSnap({
          lastText: 'still working',
        }),
      );
      expect(verdict.stop).toBe(false);
    });

    it('stops when marker found', async () => {
      const pred = until.outputContains('DONE');
      const verdict = await pred(
        makeSnap({
          lastText: 'task DONE!',
        }),
      );
      expect(verdict.stop).toBe(true);
      expect(verdict.reason).toContain('DONE');
    });
  });

  describe('custom', () => {
    it('wraps a custom function', async () => {
      const pred = until.custom((snap) => ({
        stop: snap.depth > 2,
      }));
      expect(
        (
          await pred(
            makeSnap({
              depth: 1,
            }),
          )
        ).stop,
      ).toBe(false);
      expect(
        (
          await pred(
            makeSnap({
              depth: 3,
            }),
          )
        ).stop,
      ).toBe(true);
    });
  });

  describe('converged with embedding', () => {
    it('uses cosine similarity when embed is provided and threshold < 1', async () => {
      const embed = mockEmbed({
        hello: [
          1,
          0,
          0,
        ],
        'hello!': [
          0.98,
          0.02,
          0,
        ],
        goodbye: [
          0,
          1,
          0,
        ],
      });

      const pred = until.converged({
        threshold: 0.95,
        embed,
      });

      // First call — never stops
      const v1 = await pred(
        makeSnap({
          lastText: 'hello',
        }),
      );
      expect(v1.stop).toBe(false);

      // Similar text — cosine similarity ~0.9998 > 0.95 → converged
      const v2 = await pred(
        makeSnap({
          lastText: 'hello!',
        }),
      );
      expect(v2.stop).toBe(true);
    });

    it('does not converge when similarity is below threshold', async () => {
      const embed = mockEmbed({
        hello: [
          1,
          0,
          0,
        ],
        goodbye: [
          0,
          1,
          0,
        ],
      });

      const pred = until.converged({
        threshold: 0.9,
        embed,
      });
      await pred(
        makeSnap({
          lastText: 'hello',
        }),
      );
      const v2 = await pred(
        makeSnap({
          lastText: 'goodbye',
        }),
      );
      expect(v2.stop).toBe(false);
    });

    it('restores previousVector from cache on first in-process call', async () => {
      const embed = mockEmbed({
        hello: [
          1,
          0,
          0,
        ],
        'hello!': [
          0.98,
          0.02,
          0,
        ],
      });

      const cache = makeStorage();

      // First instance writes to cache
      const pred1 = until.converged({
        threshold: 0.95,
        embed,
        cache,
      });
      await pred1(
        makeSnap({
          lastText: 'hello',
        }),
      );

      // Second instance (simulating new process) should restore from cache
      const pred2 = until.converged({
        threshold: 0.95,
        embed,
        cache,
      });
      // 'hello!' is similar to cached 'hello' vector → should converge
      const v = await pred2(
        makeSnap({
          lastText: 'hello!',
        }),
      );
      expect(v.stop).toBe(true);
    });

    it('persists vector to cache after each call', async () => {
      const embed = mockEmbed({
        hello: [
          1,
          0,
          0,
        ],
        goodbye: [
          0,
          1,
          0,
        ],
      });

      const cache = makeStorage();
      const pred = until.converged({
        threshold: 0.9,
        embed,
        cache,
      });

      await pred(
        makeSnap({
          lastText: 'hello',
        }),
      );

      // Verify cache was written
      const keys = await cache.list('converge:');
      expect(keys.length).toBe(1);
    });

    it('falls back to exact equality without embed', async () => {
      const pred = until.converged({
        threshold: 0.5,
      });
      await pred(
        makeSnap({
          lastText: 'hello',
        }),
      );
      // Different text → not converged even with low threshold (no embed = exact match)
      const v = await pred(
        makeSnap({
          lastText: 'hello!',
        }),
      );
      expect(v.stop).toBe(false);
    });
  });

  describe('converged edge cases', () => {
    it('similar-but-not-identical strings do not converge (exact equality only)', async () => {
      const pred = until.converged({
        threshold: 0.9,
      });
      await pred(
        makeSnap({
          lastText: 'hello world',
        }),
      );
      const verdict = await pred(
        makeSnap({
          lastText: 'hello worl',
        }),
      );
      // threshold is ignored; uses exact string equality
      expect(verdict.stop).toBe(false);
    });

    it('two instances track independently', async () => {
      const pred1 = until.converged({
        threshold: 0.9,
      });
      const pred2 = until.converged({
        threshold: 0.9,
      });
      await pred1(
        makeSnap({
          lastText: 'a',
        }),
      );
      await pred2(
        makeSnap({
          lastText: 'x',
        }),
      );
      // pred1 sees 'a' again → converged; pred2 sees 'y' → not converged
      const v1 = await pred1(
        makeSnap({
          lastText: 'a',
        }),
      );
      const v2 = await pred2(
        makeSnap({
          lastText: 'y',
        }),
      );
      expect(v1.stop).toBe(true);
      expect(v2.stop).toBe(false);
    });
  });

  describe('maxSteps edge cases', () => {
    it('maxSteps(0) stops immediately', async () => {
      const pred = until.maxSteps(0);
      const verdict = await pred(
        makeSnap({
          stepCount: 0,
        }),
      );
      // stepCount >= 0 is always true
      expect(verdict.stop).toBe(true);
    });
  });

  describe('outputContains edge cases', () => {
    it('outputContains empty string always stops', async () => {
      const pred = until.outputContains('');
      const verdict = await pred(
        makeSnap({
          lastText: 'anything',
        }),
      );
      // 'anything'.includes('') is true
      expect(verdict.stop).toBe(true);
    });
  });

  describe('error handling', () => {
    it('throwing predicate propagates', () => {
      const pred = until.custom(() => {
        throw new Error('boom');
      });
      expect(() => pred(makeSnap())).toThrow('boom');
    });
  });
});

describe('combinators', () => {
  describe('any() edge cases', () => {
    it('any() with zero predicates returns stop: false', async () => {
      const pred = any();
      const verdict = await pred(makeSnap());
      expect(verdict.stop).toBe(false);
    });
  });

  describe('all() edge cases', () => {
    it('all() with zero predicates returns stop: true', async () => {
      const pred = all();
      const verdict = await pred(makeSnap());
      expect(verdict.stop).toBe(true);
    });
  });

  describe('any()', () => {
    it('stops when any predicate fires', async () => {
      const pred = any(until.maxSteps(5), until.maxCost(1.0));
      const snap = makeSnap({
        stepCount: 5,
        cost: 0.1,
      });
      const verdict = await pred(snap);
      expect(verdict.stop).toBe(true);
      expect(verdict.reason).toContain('max steps');
    });

    it('does not stop when none fire', async () => {
      const pred = any(until.maxSteps(5), until.maxCost(1.0));
      const snap = makeSnap({
        stepCount: 2,
        cost: 0.1,
      });
      const verdict = await pred(snap);
      expect(verdict.stop).toBe(false);
    });

    it('returns the first matching verdict', async () => {
      const pred = any(until.maxCost(1.0), until.maxSteps(5));
      const snap = makeSnap({
        stepCount: 5,
        cost: 2.0,
      });
      const verdict = await pred(snap);
      expect(verdict.stop).toBe(true);
      // Should return cost verdict first since it's listed first
      expect(verdict.reason).toBe('Cost $2.00 exceeded budget $1.00');
    });

    it('works with async predicates', async () => {
      const pred = any(
        until.verified(async (output) => ({
          pass: output === 'done',
        })),
        until.maxSteps(10),
      );
      const snap = makeSnap({
        stepCount: 1,
        lastOutput: 'done',
      });
      const verdict = await pred(snap);
      expect(verdict.stop).toBe(true);
    });
  });

  describe('all()', () => {
    it('does not stop when only some predicates fire', async () => {
      const pred = all(until.maxSteps(5), until.maxCost(1.0));
      const verdict = await pred(
        makeSnap({
          stepCount: 5,
          cost: 0.1,
        }),
      );
      expect(verdict.stop).toBe(false);
    });

    it('stops when all predicates fire', async () => {
      const pred = all(until.maxSteps(5), until.maxCost(1.0));
      const verdict = await pred(
        makeSnap({
          stepCount: 5,
          cost: 1.0,
        }),
      );
      expect(verdict.stop).toBe(true);
    });

    it('combines reasons from all predicates', async () => {
      const pred = all(until.maxSteps(5), until.maxCost(1.0));
      const verdict = await pred(
        makeSnap({
          stepCount: 5,
          cost: 1.0,
        }),
      );
      expect(verdict.reason).toBe('Reached max steps (5); Cost $1.00 exceeded budget $1.00');
    });
  });

  describe('feedback', () => {
    const failsWith = (feedback?: string): Until =>
      until.verified(async () => ({
        pass: false,
        feedback,
      }));
    const passesWith = (feedback?: string): Until =>
      until.verified(async () => ({
        pass: true,
        feedback,
      }));

    it('any() carries the feedback of a failing verified()', async () => {
      const verdict = await any(
        until.maxSteps(10),
        failsWith('tests fail'),
      )(
        makeSnap({
          stepCount: 1,
        }),
      );
      expect(verdict).toEqual({
        stop: false,
        reason: 'Verification failed',
        feedback: 'tests fail',
      });
    });

    it('any() joins the feedback of every continuing predicate with a newline', async () => {
      const verdict = await any(failsWith('tests fail'), failsWith('lint fails'))(makeSnap());
      expect(verdict).toEqual({
        stop: false,
        reason: 'Verification failed; Verification failed',
        feedback: 'tests fail\nlint fails',
      });
    });

    it('any() leaves out feedback when no continuing predicate gives one', async () => {
      const verdict = await any(
        until.maxSteps(10),
        failsWith(),
        failsWith(''),
      )(
        makeSnap({
          stepCount: 1,
        }),
      );
      expect(verdict).toEqual({
        stop: false,
        reason: 'Verification failed; Verification failed',
      });
      expect('feedback' in verdict).toBe(false);
    });

    it('any() leaves out reason when no continuing predicate gives one', async () => {
      const verdict = await any(
        until.maxSteps(10),
        until.maxCost(1),
      )(
        makeSnap({
          stepCount: 1,
        }),
      );
      expect(verdict).toEqual({
        stop: false,
      });
      expect('reason' in verdict).toBe(false);
    });

    it('any() returns the stopping verdict as is, dropping earlier feedback', async () => {
      const verdict = await any(failsWith('tests fail'), passesWith('all green'))(makeSnap());
      expect(verdict).toEqual({
        stop: true,
        reason: 'Verification passed',
        feedback: 'all green',
      });
    });

    it('all() returns the first continuing verdict with its feedback', async () => {
      const verdict = await all(
        passesWith('ok'),
        failsWith('tests fail'),
        failsWith('never run'),
      )(makeSnap());
      expect(verdict).toEqual({
        stop: false,
        reason: 'Verification failed',
        feedback: 'tests fail',
      });
    });

    it('all() joins the feedback of every predicate when it stops', async () => {
      const verdict = await all(
        passesWith('tests pass'),
        until.maxSteps(1),
        passesWith('lint ok'),
      )(
        makeSnap({
          stepCount: 1,
        }),
      );
      expect(verdict).toEqual({
        stop: true,
        reason: 'Verification passed; Reached max steps (1); Verification passed',
        feedback: 'tests pass\nlint ok',
      });
    });

    it('all() leaves out feedback when no predicate gives one', async () => {
      const verdict = await all(until.maxSteps(1))(
        makeSnap({
          stepCount: 1,
        }),
      );
      expect(verdict).toEqual({
        stop: true,
        reason: 'Reached max steps (1)',
      });
      expect('feedback' in verdict).toBe(false);
    });
  });
});
