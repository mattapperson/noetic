import { describe, it, expect } from 'bun:test';
import { executeFork } from '../../src/interpreter/execute-fork';
import { ContextImpl } from '../../src/runtime/context-impl';
import { OrchidErrorImpl, isOrchidError } from '../../src/errors/orchid-error';
import type { StepForkAll, StepForkRace, StepForkSettle, SettleResult } from '../../src/types/step';
import type { Context } from '../../src/types/context';

const simpleExecute = async <I, O>(step: any, input: I, ctx: Context): Promise<O> => {
  if (step.kind === 'run') return step.execute(input, ctx);
  throw new Error(`Unsupported: ${step.kind}`);
};

describe('executeFork', () => {
  describe('all mode', () => {
    it('executes all paths and merges results', async () => {
      const step: StepForkAll<number, number> = {
        kind: 'fork',
        id: 'all-test',
        mode: 'all',
        paths: () => [
          { kind: 'run', id: 'a', execute: async (i: number) => i * 2 },
          { kind: 'run', id: 'b', execute: async (i: number) => i * 3 },
        ],
        merge: (results) => results.reduce((a, b) => a + b, 0),
      };
      const ctx = new ContextImpl();
      const result = await executeFork(step, 5, ctx, simpleExecute);
      expect(result).toBe(25); // 10 + 15
    });

    it('throws fork_partial when any path fails', async () => {
      const step: StepForkAll<string, string> = {
        kind: 'fork',
        id: 'fail-test',
        mode: 'all',
        paths: () => [
          { kind: 'run', id: 'ok', execute: async () => 'success' },
          { kind: 'run', id: 'fail', execute: async () => { throw new Error('boom'); } },
        ],
        merge: (results) => results.join(','),
      };
      const ctx = new ContextImpl();
      try {
        await executeFork(step, '', ctx, simpleExecute);
        expect(true).toBe(false);
      } catch (e) {
        expect(isOrchidError(e)).toBe(true);
        const oe = (e as OrchidErrorImpl).orchidError;
        expect(oe.kind).toBe('fork_partial');
        if (oe.kind === 'fork_partial') {
          expect(oe.succeeded.length).toBeGreaterThanOrEqual(1);
          expect(oe.failed).toHaveLength(1);
        }
      }
    });

    it('state is isolated between paths', async () => {
      const step: StepForkAll<string, string> = {
        kind: 'fork',
        id: 'iso-test',
        mode: 'all',
        paths: () => [
          {
            kind: 'run', id: 'a',
            execute: async (_: string, ctx: Context) => {
              (ctx as any).state = { modified: 'by-a' };
              return 'a';
            },
          },
          {
            kind: 'run', id: 'b',
            execute: async (_: string, ctx: Context) => {
              // Should NOT see a's mutation
              return JSON.stringify(ctx.state);
            },
          },
        ],
        merge: (results) => results.join('|'),
      };
      const ctx = new ContextImpl({ state: { original: true } });
      const result = await executeFork(step, '', ctx, simpleExecute);
      // b should see the original state, not a's mutation
      expect(result).toContain('original');
      // Parent state should also be unchanged
      expect((ctx.state as any).original).toBe(true);
    });

    it('respects concurrency limit', async () => {
      let maxConcurrent = 0;
      let current = 0;
      const step: StepForkAll<string, string> = {
        kind: 'fork',
        id: 'conc-test',
        mode: 'all',
        paths: () => [
          { kind: 'run', id: 'a', execute: async () => { current++; maxConcurrent = Math.max(maxConcurrent, current); await new Promise(r => setTimeout(r, 50)); current--; return 'a'; } },
          { kind: 'run', id: 'b', execute: async () => { current++; maxConcurrent = Math.max(maxConcurrent, current); await new Promise(r => setTimeout(r, 50)); current--; return 'b'; } },
          { kind: 'run', id: 'c', execute: async () => { current++; maxConcurrent = Math.max(maxConcurrent, current); await new Promise(r => setTimeout(r, 50)); current--; return 'c'; } },
        ],
        merge: (r) => r.join(','),
        concurrency: 2,
      };
      const ctx = new ContextImpl();
      await executeFork(step, '', ctx, simpleExecute);
      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it('handles empty paths', async () => {
      const step: StepForkAll<string, string> = {
        kind: 'fork',
        id: 'empty-all',
        mode: 'all',
        paths: () => [],
        merge: (results) => `got ${results.length}`,
      };
      const ctx = new ContextImpl();
      const result = await executeFork(step, '', ctx, simpleExecute);
      expect(result).toBe('got 0');
    });
  });

  describe('race mode', () => {
    it('returns first completed result', async () => {
      const step: StepForkRace<string, string> = {
        kind: 'fork',
        id: 'race-test',
        mode: 'race',
        paths: () => [
          { kind: 'run', id: 'slow', execute: async () => { await new Promise(r => setTimeout(r, 200)); return 'slow'; } },
          { kind: 'run', id: 'fast', execute: async () => { await new Promise(r => setTimeout(r, 10)); return 'fast'; } },
        ],
      };
      const ctx = new ContextImpl();
      const result = await executeFork(step, '', ctx, simpleExecute);
      expect(result).toBe('fast');
    });

    it('winner state replaces parent state', async () => {
      const step: StepForkRace<string, string> = {
        kind: 'fork',
        id: 'state-test',
        mode: 'race',
        paths: () => [
          { kind: 'run', id: 'winner', execute: async (_: string, ctx: Context) => { (ctx as any).state = { winner: true }; return 'won'; } },
          { kind: 'run', id: 'loser', execute: async () => { await new Promise(r => setTimeout(r, 200)); return 'lost'; } },
        ],
      };
      const ctx = new ContextImpl({ state: { original: true } });
      await executeFork(step, '', ctx, simpleExecute);
      expect((ctx.state as any).winner).toBe(true);
    });

    it('all fail throws fork_partial', async () => {
      const step: StepForkRace<string, string> = {
        kind: 'fork',
        id: 'all-fail',
        mode: 'race',
        paths: () => [
          { kind: 'run', id: 'a', execute: async () => { throw new Error('fail a'); } },
          { kind: 'run', id: 'b', execute: async () => { throw new Error('fail b'); } },
        ],
      };
      const ctx = new ContextImpl();
      try {
        await executeFork(step, '', ctx, simpleExecute);
        expect(true).toBe(false);
      } catch (e) {
        expect(isOrchidError(e)).toBe(true);
        const oe = (e as OrchidErrorImpl).orchidError;
        expect(oe.kind).toBe('fork_partial');
        if (oe.kind === 'fork_partial') {
          expect(oe.succeeded).toHaveLength(0);
          expect(oe.failed).toHaveLength(2);
        }
      }
    });

    it('throws fork_partial on empty paths', async () => {
      const step: StepForkRace<string, string> = {
        kind: 'fork',
        id: 'empty-race',
        mode: 'race',
        paths: () => [],
      };
      const ctx = new ContextImpl();
      try {
        await executeFork(step, '', ctx, simpleExecute);
        expect(true).toBe(false);
      } catch (e) {
        expect(isOrchidError(e)).toBe(true);
        const oe = (e as OrchidErrorImpl).orchidError;
        expect(oe.kind).toBe('fork_partial');
      }
    });
  });

  describe('settle mode', () => {
    it('waits for all and never throws', async () => {
      const step: StepForkSettle<string, string> = {
        kind: 'fork',
        id: 'settle-test',
        mode: 'settle',
        paths: () => [
          { kind: 'run', id: 'ok', execute: async () => 'success' },
          { kind: 'run', id: 'fail', execute: async () => { throw new Error('boom'); } },
        ],
        merge: (results: SettleResult<string>[]) => {
          const fulfilled = results.filter(r => r.status === 'fulfilled');
          const rejected = results.filter(r => r.status === 'rejected');
          return `${fulfilled.length} ok, ${rejected.length} failed`;
        },
      };
      const ctx = new ContextImpl();
      const result = await executeFork(step, '', ctx, simpleExecute);
      expect(result).toBe('1 ok, 1 failed');
    });

    it('settle result has correct shape', async () => {
      let capturedResults: SettleResult<string>[] = [];
      const step: StepForkSettle<string, string> = {
        kind: 'fork',
        id: 'shape-test',
        mode: 'settle',
        paths: () => [
          { kind: 'run', id: 'a', execute: async () => 'value-a' },
          { kind: 'run', id: 'b', execute: async () => { throw new Error('err-b'); } },
        ],
        merge: (results: SettleResult<string>[]) => {
          capturedResults = results;
          return 'done';
        },
      };
      const ctx = new ContextImpl();
      await executeFork(step, '', ctx, simpleExecute);

      expect(capturedResults).toHaveLength(2);
      const fulfilled = capturedResults.find(r => r.status === 'fulfilled')!;
      expect(fulfilled.stepId).toBe('a');
      expect(fulfilled.value).toBe('value-a');

      const rejected = capturedResults.find(r => r.status === 'rejected')!;
      expect(rejected.stepId).toBe('b');
      expect(rejected.error).toBeDefined();
    });

    it('handles empty paths', async () => {
      const step: StepForkSettle<string, string> = {
        kind: 'fork',
        id: 'empty-settle',
        mode: 'settle',
        paths: () => [],
        merge: (results: SettleResult<string>[]) => `got ${results.length}`,
      };
      const ctx = new ContextImpl();
      const result = await executeFork(step, '', ctx, simpleExecute);
      expect(result).toBe('got 0');
    });
  });
});
