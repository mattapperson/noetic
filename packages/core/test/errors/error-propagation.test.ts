import { describe, it, expect } from 'bun:test';
import { execute } from '../../src/interpreter/execute';
import { ContextImpl } from '../../src/runtime/context-impl';
import { OrchidErrorImpl, isOrchidError } from '../../src/errors/orchid-error';
import type { Step, StepLoop } from '../../src/types/step';
import { until } from '../../src/until/predicates';

describe('Error propagation', () => {
  describe('loop error handling', () => {
    it('default propagates error', async () => {
      const step: StepLoop<string, string> = {
        kind: 'loop', id: 'test-loop',
        body: { kind: 'run', id: 'fail', execute: async () => { throw new Error('body fail'); } },
        until: until.maxSteps(5),
      };
      const ctx = new ContextImpl();
      await expect(execute(step, 'go', ctx)).rejects.toThrow('body fail');
    });

    it('onError retry re-runs', async () => {
      let attempts = 0;
      const step: StepLoop<string, string> = {
        kind: 'loop', id: 'retry-loop',
        body: {
          kind: 'run', id: 'flaky',
          execute: async () => {
            attempts++;
            if (attempts < 3) throw new OrchidErrorImpl({ kind: 'step_failed', stepId: 'flaky', cause: new Error('flaky'), retriesExhausted: false });
            return 'ok';
          },
        },
        until: until.maxSteps(1),
        onError: () => 'retry',
      };
      const ctx = new ContextImpl();
      const result = await execute(step, '', ctx);
      expect(result).toBe('ok');
      expect(attempts).toBe(3);
    });

    it('until predicate throw treated as stop', async () => {
      let bodyCount = 0;
      const step: StepLoop<string, string> = {
        kind: 'loop', id: 'pred-throw',
        body: { kind: 'run', id: 'inc', execute: async () => { bodyCount++; return 'ok'; } },
        until: () => { throw new Error('predicate boom'); },
      };
      const ctx = new ContextImpl();
      const result = await execute(step, '', ctx);
      expect(bodyCount).toBe(1);
      expect(result).toBe('ok');
    });
  });

  describe('fork error handling', () => {
    it('all mode throws fork_partial on failure', async () => {
      const step: Step<string, string> = {
        kind: 'fork', id: 'fail-fork', mode: 'all',
        paths: () => [
          { kind: 'run', id: 'ok', execute: async () => 'success' },
          { kind: 'run', id: 'fail', execute: async () => { throw new Error('boom'); } },
        ],
        merge: (r) => r.join(','),
      };
      const ctx = new ContextImpl();
      try {
        await execute(step, '', ctx);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(isOrchidError(e)).toBe(true);
        expect((e as OrchidErrorImpl).orchidError.kind).toBe('fork_partial');
      }
    });

    it('settle mode never throws', async () => {
      const step: Step<string, string> = {
        kind: 'fork', id: 'settle-fork', mode: 'settle',
        paths: () => [
          { kind: 'run', id: 'ok', execute: async () => 'yes' },
          { kind: 'run', id: 'fail', execute: async () => { throw new Error('no'); } },
        ],
        merge: (results: any[]) => `${results.filter(r => r.status === 'fulfilled').length} ok`,
      };
      const ctx = new ContextImpl();
      const result = await execute(step, '', ctx);
      expect(result).toBe('1 ok');
    });

    it('race mode all-fail throws fork_partial', async () => {
      const step: Step<string, string> = {
        kind: 'fork', id: 'race-fail', mode: 'race',
        paths: () => [
          { kind: 'run', id: 'a', execute: async () => { throw new Error('a'); } },
          { kind: 'run', id: 'b', execute: async () => { throw new Error('b'); } },
        ],
      };
      const ctx = new ContextImpl();
      try {
        await execute(step, '', ctx);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(isOrchidError(e)).toBe(true);
        expect((e as OrchidErrorImpl).orchidError.kind).toBe('fork_partial');
      }
    });
  });

  describe('spawn errors', () => {
    it('spawn_summary_failed preserves childOutput', async () => {
      const step: Step<string, string> = {
        kind: 'spawn', id: 'sum-fail',
        child: { kind: 'run', id: 'child', execute: async () => 'child-data' },
        contextIn: { strategy: 'fresh' },
        contextOut: { strategy: 'summary' },
      };
      const ctx = new ContextImpl();
      const mockCallModel = async () => { throw new Error('LLM down'); };
      try {
        await execute(step, '', ctx, mockCallModel);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(isOrchidError(e)).toBe(true);
        const oe = (e as OrchidErrorImpl).orchidError;
        expect(oe.kind).toBe('spawn_summary_failed');
        if (oe.kind === 'spawn_summary_failed') {
          expect(oe.childOutput).toBe('child-data');
        }
      }
    });
  });
});
