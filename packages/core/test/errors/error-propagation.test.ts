import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData } from '@noetic-tools/context';
import type { SettleResult, Step } from '@noetic-tools/types';
import { isNoeticError, NoeticErrorImpl } from '@noetic-tools/types';
import { loop } from '../../src/builders/loop-builder';
import { execute } from '../../src/interpreter/execute';
import { ContextImpl } from '../../src/runtime/context-impl';
import { until } from '../../src/until/predicates';
import { makeMockHarness } from '../_helpers';

describe('Error propagation', () => {
  describe('loop error handling', () => {
    it('default propagates error', async () => {
      const loopStep = loop<ContextData, string, string>({
        id: 'test-loop',
        steps: [
          {
            kind: 'runCode',
            id: 'fail',
            execute: async () => {
              throw new Error('body fail');
            },
          },
        ],
        until: until.maxSteps(5),
      });
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      await expect(execute(loopStep, 'go', ctx)).rejects.toThrow('body fail');
    });

    it('onError retry re-runs', async () => {
      let attempts = 0;
      const loopStep = loop<ContextData, string, string>({
        id: 'retry-loop',
        steps: [
          {
            kind: 'runCode',
            id: 'flaky',
            execute: async () => {
              attempts++;
              if (attempts < 3) {
                throw new NoeticErrorImpl({
                  kind: 'step_failed',
                  stepId: 'flaky',
                  cause: new Error('flaky'),
                  retriesExhausted: false,
                });
              }
              return 'ok';
            },
          },
        ],
        until: until.maxSteps(1),
        onError: () => 'retry',
      });
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const result = await execute(loopStep, '', ctx);
      expect(result).toBe('ok');
      expect(attempts).toBe(3);
    });

    it('until predicate throw treated as stop', async () => {
      let bodyCount = 0;
      const loopStep = loop<ContextData, string, string>({
        id: 'pred-throw',
        steps: [
          {
            kind: 'runCode',
            id: 'inc',
            execute: async () => {
              bodyCount++;
              return 'ok';
            },
          },
        ],
        until: () => {
          throw new Error('predicate boom');
        },
      });
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const result = await execute(loopStep, '', ctx);
      expect(bodyCount).toBe(1);
      expect(result).toBe('ok');
    });
  });

  describe('inParallel error handling', () => {
    it('all mode throws fork_partial on failure', async () => {
      const step: Step<ContextData, string, string> = {
        kind: 'inParallel',
        id: 'fail-inParallel',
        mode: 'all',
        paths: () => [
          {
            kind: 'runCode',
            id: 'ok',
            execute: async () => 'success',
          },
          {
            kind: 'runCode',
            id: 'fail',
            execute: async () => {
              throw new Error('boom');
            },
          },
        ],
        merge: (r) => r.join(','),
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      try {
        await execute(step, '', ctx);
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticError(e));
        expect(e.noeticError.kind).toBe('fork_partial');
      }
    });

    it('settle mode never throws', async () => {
      const step: Step<ContextData, string, string> = {
        kind: 'inParallel',
        id: 'settle-inParallel',
        mode: 'settle',
        paths: () => [
          {
            kind: 'runCode',
            id: 'ok',
            execute: async () => 'yes',
          },
          {
            kind: 'runCode',
            id: 'fail',
            execute: async () => {
              throw new Error('no');
            },
          },
        ],
        merge: (results: SettleResult<string>[]) =>
          `${results.filter((r) => r.status === 'fulfilled').length} ok`,
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const result = await execute(step, '', ctx);
      expect(result).toBe('1 ok');
    });

    it('race mode all-fail throws fork_partial', async () => {
      const step: Step<ContextData, string, string> = {
        kind: 'inParallel',
        id: 'race-fail',
        mode: 'race',
        paths: () => [
          {
            kind: 'runCode',
            id: 'a',
            execute: async () => {
              throw new Error('a');
            },
          },
          {
            kind: 'runCode',
            id: 'b',
            execute: async () => {
              throw new Error('b');
            },
          },
        ],
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      try {
        await execute(step, '', ctx);
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticError(e));
        expect(e.noeticError.kind).toBe('fork_partial');
      }
    });
  });
});
