import { describe, it, expect } from 'bun:test';
import { until } from '../../src/until/predicates';
import { any, all } from '../../src/until/combinators';
import type { Snapshot } from '../../src/types/step';

function makeSnap(overrides?: Partial<Snapshot>): Snapshot {
  return {
    stepCount: 0,
    tokens: { input: 0, output: 0, total: 0 },
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
      const verdict = await pred(makeSnap({ stepCount: 2 }));
      expect(verdict.stop).toBe(false);
      expect(verdict.reason).toBeUndefined();
    });

    it('stops when step count reached', async () => {
      const pred = until.maxSteps(3);
      const verdict = await pred(makeSnap({ stepCount: 3 }));
      expect(verdict.stop).toBe(true);
      expect(verdict.reason).toContain('max steps');
    });

    it('stops when step count exceeded', async () => {
      const pred = until.maxSteps(3);
      const verdict = await pred(makeSnap({ stepCount: 5 }));
      expect(verdict.stop).toBe(true);
    });
  });

  describe('maxCost', () => {
    it('does not stop below threshold', async () => {
      const pred = until.maxCost(1.0);
      const verdict = await pred(makeSnap({ cost: 0.5 }));
      expect(verdict.stop).toBe(false);
    });

    it('stops when cost reached', async () => {
      const pred = until.maxCost(1.0);
      const verdict = await pred(makeSnap({ cost: 1.0 }));
      expect(verdict.stop).toBe(true);
      expect(verdict.reason).toContain('max cost');
    });

    it('stops when cost exceeded', async () => {
      const pred = until.maxCost(1.0);
      const verdict = await pred(makeSnap({ cost: 2.0 }));
      expect(verdict.stop).toBe(true);
    });
  });

  describe('maxDuration', () => {
    it('does not stop below threshold', async () => {
      const pred = until.maxDuration(5000);
      const verdict = await pred(makeSnap({ elapsed: 3000 }));
      expect(verdict.stop).toBe(false);
    });

    it('stops when duration reached', async () => {
      const pred = until.maxDuration(5000);
      const verdict = await pred(makeSnap({ elapsed: 5000 }));
      expect(verdict.stop).toBe(true);
      expect(verdict.reason).toContain('max duration');
    });
  });

  describe('noToolCalls', () => {
    it('does not stop on first step', async () => {
      const pred = until.noToolCalls();
      const snap = makeSnap({ stepCount: 0 });
      const verdict = await pred(snap);
      expect(verdict.stop).toBe(false);
    });

    it('stops when no tool calls in last step', async () => {
      const pred = until.noToolCalls();
      const snap = {
        ...makeSnap({ stepCount: 2 }),
        lastStepMeta: { toolCalls: undefined },
      };
      const verdict = await pred(snap);
      expect(verdict.stop).toBe(true);
    });

    it('stops when tool calls array is empty', async () => {
      const pred = until.noToolCalls();
      const snap = {
        ...makeSnap({ stepCount: 2 }),
        lastStepMeta: { toolCalls: [] as unknown[] },
      };
      const verdict = await pred(snap);
      expect(verdict.stop).toBe(true);
    });

    it('does not stop when tool calls present', async () => {
      const pred = until.noToolCalls();
      const snap = {
        ...makeSnap({ stepCount: 2 }),
        lastStepMeta: {
          toolCalls: [
            {
              id: '1',
              status: 'completed',
              type: 'function_call',
              call_id: 'c1',
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
      const snap = makeSnap({ lastOutput: 'correct' });
      const verdict = await pred(snap);
      expect(verdict.stop).toBe(true);
      expect(verdict.reason).toContain('Verification passed');
    });

    it('does not stop when verification fails', async () => {
      const pred = until.verified(async () => ({
        pass: false,
        feedback: 'Try again',
      }));
      const snap = makeSnap({ lastOutput: 'wrong' });
      const verdict = await pred(snap);
      expect(verdict.stop).toBe(false);
      expect(verdict.feedback).toBe('Try again');
    });

    it('does not include reason on failure', async () => {
      const pred = until.verified(async () => ({ pass: false }));
      const verdict = await pred(makeSnap());
      expect(verdict.reason).toBeUndefined();
    });
  });

  describe('converged', () => {
    it('does not stop on first call', async () => {
      const pred = until.converged({ threshold: 0.9 });
      const verdict = await pred(makeSnap({ lastText: 'hello' }));
      expect(verdict.stop).toBe(false);
    });

    it('stops when output is identical', async () => {
      const pred = until.converged({ threshold: 0.9 });
      await pred(makeSnap({ lastText: 'hello' }));
      const verdict = await pred(makeSnap({ lastText: 'hello' }));
      expect(verdict.stop).toBe(true);
      expect(verdict.reason).toContain('converged');
    });

    it('does not stop when output changes', async () => {
      const pred = until.converged({ threshold: 0.9 });
      await pred(makeSnap({ lastText: 'hello' }));
      const verdict = await pred(makeSnap({ lastText: 'world' }));
      expect(verdict.stop).toBe(false);
    });

    it('tracks across multiple calls', async () => {
      const pred = until.converged({ threshold: 0.9 });
      await pred(makeSnap({ lastText: 'a' }));
      await pred(makeSnap({ lastText: 'b' }));
      await pred(makeSnap({ lastText: 'c' }));
      const verdict = await pred(makeSnap({ lastText: 'c' }));
      expect(verdict.stop).toBe(true);
    });
  });

  describe('outputContains', () => {
    it('does not stop when marker absent', async () => {
      const pred = until.outputContains('DONE');
      const verdict = await pred(makeSnap({ lastText: 'still working' }));
      expect(verdict.stop).toBe(false);
    });

    it('stops when marker found', async () => {
      const pred = until.outputContains('DONE');
      const verdict = await pred(makeSnap({ lastText: 'task DONE!' }));
      expect(verdict.stop).toBe(true);
      expect(verdict.reason).toContain('DONE');
    });
  });

  describe('custom', () => {
    it('wraps a custom function', async () => {
      const pred = until.custom((snap) => ({
        stop: snap.depth > 2,
      }));
      expect((await pred(makeSnap({ depth: 1 }))).stop).toBe(false);
      expect((await pred(makeSnap({ depth: 3 }))).stop).toBe(true);
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
  describe('any()', () => {
    it('stops when any predicate fires', async () => {
      const pred = any(until.maxSteps(5), until.maxCost(1.0));
      const snap = makeSnap({ stepCount: 5, cost: 0.1 });
      const verdict = await pred(snap);
      expect(verdict.stop).toBe(true);
      expect(verdict.reason).toContain('max steps');
    });

    it('does not stop when none fire', async () => {
      const pred = any(until.maxSteps(5), until.maxCost(1.0));
      const snap = makeSnap({ stepCount: 2, cost: 0.1 });
      const verdict = await pred(snap);
      expect(verdict.stop).toBe(false);
    });

    it('returns the first matching verdict', async () => {
      const pred = any(until.maxCost(1.0), until.maxSteps(5));
      const snap = makeSnap({ stepCount: 5, cost: 2.0 });
      const verdict = await pred(snap);
      expect(verdict.stop).toBe(true);
      // Should return cost verdict first since it's listed first
      expect(verdict.reason).toContain('max cost');
    });

    it('works with async predicates', async () => {
      const pred = any(
        until.verified(async (output) => ({ pass: output === 'done' })),
        until.maxSteps(10),
      );
      const snap = makeSnap({ stepCount: 1, lastOutput: 'done' });
      const verdict = await pred(snap);
      expect(verdict.stop).toBe(true);
    });
  });

  describe('all()', () => {
    it('does not stop when only some predicates fire', async () => {
      const pred = all(until.maxSteps(5), until.maxCost(1.0));
      const verdict = await pred(makeSnap({ stepCount: 5, cost: 0.1 }));
      expect(verdict.stop).toBe(false);
    });

    it('stops when all predicates fire', async () => {
      const pred = all(until.maxSteps(5), until.maxCost(1.0));
      const verdict = await pred(makeSnap({ stepCount: 5, cost: 1.0 }));
      expect(verdict.stop).toBe(true);
    });

    it('combines reasons from all predicates', async () => {
      const pred = all(until.maxSteps(5), until.maxCost(1.0));
      const verdict = await pred(makeSnap({ stepCount: 5, cost: 1.0 }));
      expect(verdict.reason).toContain('max steps');
      expect(verdict.reason).toContain('max cost');
    });
  });
});
